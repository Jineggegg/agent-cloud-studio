import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { StudioBuildInfo, StudioRuntimeInfo } from '@/shared/types.js';
import { findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';

const execFileAsync = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/i;
const GITHUB_CACHE_MS = 60_000;
const GITHUB_TIMEOUT_MS = 4_000;

type RuntimeDependencies = {
  appRoot?: string;
  readFrontendManifest?: () => unknown;
  backendBuild?: unknown;
  git?: (args: string[]) => Promise<string>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function buildInfo(value: unknown): StudioBuildInfo | null {
  const data = record(value);
  if (!data || data.schemaVersion !== 1 || typeof data.version !== 'string' || !data.version.trim() || data.version.length > 100
    || !(data.commit === null || typeof data.commit === 'string' && SHA.test(data.commit))
    || typeof data.builtAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(data.builtAt) || !Number.isFinite(Date.parse(data.builtAt))
    || !(data.dirty === null || typeof data.dirty === 'boolean')) return null;
  return { schemaVersion: 1, version: data.version, commit: data.commit as string | null, builtAt: data.builtAt, dirty: data.dirty as boolean | null };
}

function readManifest(filename: string): unknown {
  try { return JSON.parse(readFileSync(filename, 'utf8')); } catch { return null; }
}

const moduleDirectory = getModuleDirectory(import.meta.url);
const outputDirectory = path.resolve(moduleDirectory, '../../..');
// Capture once from the directory containing this loaded JavaScript. A later deploy or checkout change
// must not rewrite the identity of the still-running process. tsx development has no build identity.
const startupBuild = /\/dist-server(?:\.next|\.old)?$/.test(outputDirectory.replaceAll('\\', '/'))
  ? buildInfo(readManifest(path.join(outputDirectory, 'build-info.json'))) : null;
const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
const bootedAt = new Date(Date.now() - os.uptime() * 1000).toISOString();

function githubRepository(origin: string): string | null {
  // Only GitHub's fixed public host is allowed; no credentials, ports, query, fragment or local paths.
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(origin);
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') return null;
  return `${match[1]}/${match[2]}`;
}

/** Used by studio.module and focused tests for safe, read-only running/build/source identity. */
export function createStudioRuntimeService(dependencies: RuntimeDependencies = {}) {
  const appRoot = dependencies.appRoot ?? findApplicationRoot(moduleDirectory);
  const readFrontend = dependencies.readFrontendManifest ?? (() => readManifest(path.join(appRoot, 'dist', 'build-info.json')));
  const backendBuild = dependencies.backendBuild === undefined ? startupBuild : buildInfo(dependencies.backendBuild);
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const git = dependencies.git ?? (async (args: string[]) => {
    // Exported installations must not inherit the Git identity of an unrelated parent checkout.
    if (!existsSync(path.join(appRoot, '.git'))) throw new Error('Studio checkout has no Git metadata');
    const { stdout } = await execFileAsync('git', ['--no-optional-locks', ...args], {
      cwd: appRoot, timeout: 2_000, maxBuffer: 128 * 1024, encoding: 'utf8', windowsHide: true,
    });
    return stdout.trim();
  });
  let githubCache: { origin: string; until: number; value: StudioRuntimeInfo['github'] } | null = null;
  let githubFlight: { origin: string; promise: Promise<StudioRuntimeInfo['github']> } | null = null;

  async function readGithub(origin: string): Promise<StudioRuntimeInfo['github']> {
    if (githubCache?.origin === origin && githubCache.until > now()) return githubCache.value;
    if (githubFlight?.origin === origin) return githubFlight.promise;
    const repository = githubRepository(origin);
    const promise = (async (): Promise<StudioRuntimeInfo['github']> => {
      const checkedAt = new Date(now()).toISOString();
      const missing: StudioRuntimeInfo['github'] = { state: 'unavailable', repository, defaultBranch: null, commit: null, checkedAt, reason: null };
      if (!repository) return { ...missing, state: 'unconfigured', reason: origin ? 'origin 不是可检查的 GitHub 地址' : '没有可检查的 origin 仓库' };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
      try {
        const request = async (endpoint: string): Promise<Record<string, unknown>> => {
          const response = await fetcher(`https://api.github.com/repos/${repository}${endpoint}`, {
            signal: controller.signal, redirect: 'error',
            headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
          });
          if (!response.ok) throw new Error(response.status === 404 ? '仓库不可公开读取，可能是私有仓库'
            : response.status === 403 || response.status === 429 ? 'GitHub 暂时限流，请稍后刷新' : 'GitHub 暂时无法检查，请稍后刷新');
          const body = record(await response.json());
          if (!body) throw new Error('GitHub 返回的数据无效，请稍后刷新');
          return body;
        };
        const repo = await request('');
        const defaultBranch = repo.default_branch;
        if (typeof defaultBranch !== 'string' || !defaultBranch || defaultBranch.length > 250) throw new Error('GitHub 未提供默认分支');
        const commit = (await request(`/commits/${encodeURIComponent(defaultBranch)}`)).sha;
        if (typeof commit !== 'string' || !SHA.test(commit)) throw new Error('GitHub 返回的版本无效，请稍后刷新');
        return { ...missing, state: 'available', defaultBranch, commit };
      } catch (error) {
        const safeMessages = ['仓库不可公开读取，可能是私有仓库', 'GitHub 暂时限流，请稍后刷新', 'GitHub 暂时无法检查，请稍后刷新', 'GitHub 返回的数据无效，请稍后刷新', 'GitHub 未提供默认分支', 'GitHub 返回的版本无效，请稍后刷新'];
        return { ...missing, reason: error instanceof Error && safeMessages.includes(error.message) ? error.message : 'GitHub 连接失败或超时，请稍后刷新' };
      } finally { clearTimeout(timer); }
    })().then(value => {
      githubCache = { origin, until: now() + GITHUB_CACHE_MS, value };
      return value;
    }).finally(() => { if (githubFlight?.promise === promise) githubFlight = null; });
    githubFlight = { origin, promise };
    return promise;
  }

  return {
    async describe(): Promise<StudioRuntimeInfo> {
      const [head, branch, changes, origin] = await Promise.allSettled([
        git(['rev-parse', '--verify', 'HEAD']), git(['symbolic-ref', '--quiet', '--short', 'HEAD']),
        git(['status', '--porcelain', '--untracked-files=normal']), git(['remote', 'get-url', 'origin']),
      ]);
      const commit = head.status === 'fulfilled' && SHA.test(head.value) ? head.value : null;
      let frontendBuild: StudioBuildInfo | null = null;
      try { frontendBuild = buildInfo(readFrontend()); } catch { /* A missing manifest is a display state, not a failed endpoint. */ }
      return {
        checkedAt: new Date(now()).toISOString(),
        frontend: { state: frontendBuild ? 'recorded' : 'unknown', build: frontendBuild, reason: frontendBuild ? null : '未记录有效的前端构建信息' },
        backend: { state: backendBuild ? 'recorded' : 'unknown', build: backendBuild, reason: backendBuild ? null : '后台启动时未记录构建信息，或正在开发模式运行' },
        checkout: {
          state: commit ? 'available' : 'unavailable', commit,
          branch: commit && branch.status === 'fulfilled' && branch.value ? branch.value : null,
          dirty: commit && changes.status === 'fulfilled' ? changes.value.length > 0 : null,
          reason: commit ? changes.status === 'rejected' ? '无法检查未提交改动' : null : '无法读取当前代码目录的 Git 状态',
        },
        github: await readGithub(origin.status === 'fulfilled' ? origin.value : ''),
        host: { hostname: os.hostname(), platform: process.platform, bootedAt, processStartedAt, uptimeSeconds: Math.floor(process.uptime()) },
      };
    },
  };
}

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { StudioCloudflareAccessConfig, StudioIngressId, StudioIngressOrigins } from '@/shared/types.js';
import {
  AppError,
  findApplicationRoot,
  getModuleDirectory,
  readCloudflareAccessConfig,
  readStudioIngressOrigins,
} from '@/shared/utils.js';

/** One front door as the Settings screen lists it. */
type StudioIngressView = {
  id: StudioIngressId;
  label: string;
  /** Normalised origin, or null when the variable is unset or invalid. */
  origin: string | null;
  configured: boolean;
  /** The public domain is the default door. */
  isDefault: boolean;
};

/** GET /api/studio/network: both doors, the one that served this request, and short guidance. */
type StudioNetworkView = {
  ingresses: StudioIngressView[];
  /** Door whose host matches the request's Host header; 'local' for localhost, LAN or dev hosts. */
  current: StudioIngressId | 'local';
  /** 'tailscale' when the caller's token came from passwordless Tailscale sign-in. */
  session: 'password' | 'tailscale';
  guidance: string[];
};

type NetworkDependencies = {
  /**
   * Origins of both doors, read per request; defaults to readStudioIngressOrigins(process.env),
   * which load-env fills from .env once at startup.
   */
  origins?: () => StudioIngressOrigins;
  /** Optional Cloudflare Access check settings; defaults to readCloudflareAccessConfig(process.env). */
  cloudflareAccess?: () => StudioCloudflareAccessConfig;
  /**
   * Text of the network guide, or null when it is not on this machine; defaults to reading
   * docs/network.md from the application root (present in the git checkout Studio runs from).
   */
  readGuide?: () => string | null;
};

// The guide is served by Studio itself, so it opens even where GitHub does not (mainland China).
function readGuideFromAppRoot(): string | null {
  try {
    const appRoot = findApplicationRoot(getModuleDirectory(import.meta.url));
    return readFileSync(path.join(appRoot, 'docs', 'network.md'), 'utf8');
  } catch {
    return null;
  }
}

const LABELS: Record<StudioIngressId, string> = { public: '公网域名', tailnet: 'Tailscale · AJ 通道' };
const EXAMPLES: Record<StudioIngressId, { variable: string; example: string; setup: string }> = {
  public: {
    variable: 'STUDIO_PUBLIC_ORIGIN',
    example: 'https://studio.ajarche.com',
    setup: '按文档开启 Cloudflare Tunnel（建议再加 Cloudflare Access）',
  },
  tailnet: {
    variable: 'STUDIO_TAILNET_ORIGIN',
    example: 'https://<机器名>.<tailnet>.ts.net:8443',
    setup: '用 Tailscale Serve 把 8443 端口转到 127.0.0.1:3002',
  },
};

// The Host header compared the way a browser compares hosts: the origin's scheme decides which
// port is the default, so "studio.example:443" equals "https://studio.example".
function hostMatchesOrigin(host: string, origin: string): boolean {
  try {
    const originUrl = new URL(origin);
    const hostUrl = new URL(`${originUrl.protocol}//${host}`);
    // A Host header is only "name[:port]"; anything that parses into more is not a match.
    return hostUrl.host === originUrl.host && hostUrl.pathname === '/' && !hostUrl.username && !hostUrl.password;
  } catch {
    return false;
  }
}

/**
 * Describes Studio's two front doors for the Settings screen.
 * Used by studio.module, which mounts it at GET /api/studio/network behind authentication.
 * The answer holds origins and configuration status only, never secrets.
 */
export function createStudioNetworkService(dependencies: NetworkDependencies = {}) {
  const readOrigins = dependencies.origins ?? (() => readStudioIngressOrigins(process.env));
  const readAccess = dependencies.cloudflareAccess ?? (() => readCloudflareAccessConfig(process.env));
  const readGuide = dependencies.readGuide ?? readGuideFromAppRoot;
  return {
    describe(input: { host: string | undefined; tailscaleSession: boolean }): StudioNetworkView {
      const origins = readOrigins();
      const ids: StudioIngressId[] = ['public', 'tailnet'];
      const ingresses = ids.map((id): StudioIngressView => ({
        id,
        label: LABELS[id],
        origin: origins[id],
        configured: origins[id] !== null,
        isDefault: id === 'public',
      }));
      const host = input.host?.trim();
      const current = (host && ids.find(id => origins[id] !== null && hostMatchesOrigin(host, origins[id] as string))) || 'local';

      const guidance = ['两个入口通向这台电脑上的同一个 Studio 和同一个数据库，切换不会丢数据，也不会出现两份不同步的内容。'];
      for (const id of ids) {
        const { variable, example, setup } = EXAMPLES[id];
        if (origins.invalid.includes(id)) {
          guidance.push(`${variable} 格式不对：要写成 ${example} 这样的完整地址，不带路径。`);
        } else if (origins[id] === null) {
          guidance.push(`${LABELS[id]}还没有配置：${setup}，再在 .env 里设置 ${variable}。`);
        }
      }
      const access = readAccess();
      if (access.status === 'invalid') {
        guidance.push(`Cloudflare Access 校验配置有误：${access.problem}。在修好之前，经公网域名的请求会全部被拒绝。`);
      } else if (access.status === 'off' && origins.public !== null) {
        guidance.push('建议在 .env 里设置 STUDIO_CF_ACCESS_TEAM_DOMAIN 和 STUDIO_CF_ACCESS_AUD，让 Studio 自己核对 Cloudflare Access 的验证结果。');
      }
      if (input.tailscaleSession) {
        guidance.push('当前是 Tailscale 免密码会话：切换到公网域名需要输入一次账户密码。');
      }
      guidance.push('在中国大陆：电脑和 iPad 都选 AJ 的出口节点，再走 Tailscale 通道。');
      return { ingresses, current, session: input.tailscaleSession ? 'tailscale' : 'password', guidance };
    },

    /** The network guide (docs/network.md) as Markdown, for the Settings screen to render. */
    guide(): { markdown: string } {
      const markdown = readGuide();
      if (markdown === null) {
        throw new AppError('这台服务器上没有找到连接方式说明（docs/network.md）', { statusCode: 404, code: 'NETWORK_GUIDE_MISSING' });
      }
      return { markdown };
    },
  };
}

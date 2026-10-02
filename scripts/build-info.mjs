import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;

/** Used by the client and server build scripts to record the source at build time. */
export function createBuildInfo(root, builtAt = new Date().toISOString()) {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  let commit = null;
  let dirty = null;

  // An exported release may live inside some unrelated repository. Only use Git
  // when this root is itself a checkout, including a linked-worktree .git file.
  if (fs.existsSync(path.join(root, '.git'))) {
    try {
      const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (COMMIT_PATTERN.test(revision)) {
        commit = revision.toLowerCase();
        dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
          cwd: root, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim().length > 0;
      }
    } catch {
      // Missing Git or an unreadable checkout must not impersonate a known build.
      commit = null;
      dirty = null;
    }
  } else {
    try {
      const revision = fs.readFileSync(path.join(root, 'RELEASE_COMMIT'), 'utf8').trim();
      if (COMMIT_PATTERN.test(revision)) commit = revision.toLowerCase();
    } catch {
      // Older archives have no source identity; the UI explicitly shows unknown.
    }
  }

  return { schemaVersion: 1, version, commit, builtAt, dirty };
}

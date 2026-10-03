import { execFile } from 'node:child_process';

type GitExecFile = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; windowsHide: boolean; encoding: 'utf8' },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

// Reading a branch name and a remote URL is instant; a hung git (network filesystem, lock) must not hold a request.
const GIT_TIMEOUT_MS = 5_000;

/**
 * Used by studio.module to give github-branch.service the current branch and the `origin` URL of a project directory:
 * `git symbolic-ref` and `git remote get-url` through execFile with an exact argv, no shell, never prompting.
 * Anything git cannot answer (not a repository, detached HEAD, no origin) comes back as null; it never rejects.
 */
export function createLocalRepoReader({
  execFile: runExecFile = execFile as unknown as GitExecFile,
  env = process.env,
}: { execFile?: GitExecFile; env?: NodeJS.ProcessEnv } = {}) {
  const environment: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  const git = (cwd: string, args: string[]) => new Promise<string | null>(resolve => {
    try {
      runExecFile('git', args, { cwd, env: environment, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8' },
        (error, stdout) => resolve(error ? null : String(stdout ?? '').trim() || null));
    } catch {
      resolve(null);
    }
  });
  return async (directory: string) => {
    const [branch, remoteUrl] = await Promise.all([
      git(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      git(directory, ['remote', 'get-url', 'origin']),
    ]);
    return { branch, remoteUrl };
  };
}

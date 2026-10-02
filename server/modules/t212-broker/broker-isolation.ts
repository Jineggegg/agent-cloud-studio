import { readFileSync, readdirSync } from 'node:fs';

import type { StudioT212BrokerIsolation } from '@/shared/types.js';

// The kernel's binfmt handler that routes execution of a Windows PE binary to /init; while it is
// enabled the Studio user can run `wsl.exe -u root` and read the order key, whatever /etc/wsl.conf says.
const INTEROP_BINFMT = '/proc/sys/fs/binfmt_misc/WSLInterop';
// WSL's per-session interop socket(s); their presence means an interop server is still running.
const INTEROP_RUN_DIR = '/run/WSL';
const MOUNTS = '/proc/self/mounts';
// Injectable so the broker tests can describe a machine without touching the real /proc and /run.
type Readers = {
  readText?: (path: string) => string;
  readDir?: (path: string) => string[];
  readMounts?: () => string;
};

/**
 * Windows drives automounted so a non-root Linux user (uid != 0) can read or write them. A writable
 * Windows profile lets the Studio user plant a startup script or .wslconfig and so become the Windows
 * user; a readable one may still expose an old order-key copy. Returns the mount points, e.g. ['/mnt/c'].
 */
function windowsDriveMounts(mounts: string): string[] {
  const found: string[] = [];
  for (const line of mounts.split('\n')) {
    const [, mountPoint, fsType, options = ''] = line.split(' ');
    if (!mountPoint || !mountPoint.startsWith('/mnt/')) continue;
    if (fsType !== '9p' && fsType !== 'drvfs' && fsType !== 'virtiofs') continue;
    // WSL tags Windows drives with aname=drvfs and mounts them for a uid; uid=0 would keep the Studio user out.
    if (!/\baname=drvfs\b/.test(options)) continue;
    const uid = options.match(/\buid=(\d+)\b/)?.[1];
    if (uid === undefined || uid !== '0') found.push(mountPoint);
  }
  return found;
}

/**
 * Used by the broker service (GET /v1/status) and CLI (`check`): inspects the running WSL instance for
 * the isolation the broker depends on. It never trusts /etc/wsl.conf, which on some WSL versions is
 * parsed yet does not actually disable interop; it reads the live kernel state instead. The result is
 * data for the owner, so Studio's Settings page can show "隔离无效" and the installer can fail closed.
 */
export function inspectIsolation(readers: Readers = {}): StudioT212BrokerIsolation {
  const readText = readers.readText ?? ((filePath: string) => readFileSync(filePath, 'utf8'));
  const readDir = readers.readDir ?? ((dirPath: string) => readdirSync(dirPath));
  const readMounts = readers.readMounts ?? (() => readFileSync(MOUNTS, 'utf8'));

  let interopBinfmt = false;
  try { interopBinfmt = /^enabled/m.test(readText(INTEROP_BINFMT)); } catch { /* not WSL, or handler absent */ }
  let interopSocket = false;
  try { interopSocket = readDir(INTEROP_RUN_DIR).some(name => name.includes('interop')); } catch { /* no /run/WSL */ }
  let windowsDrives: string[] = [];
  try { windowsDrives = windowsDriveMounts(readMounts()); } catch { /* no /proc/self/mounts */ }

  const interopActive = interopBinfmt || interopSocket;
  const notes: string[] = [];
  if (interopActive) {
    notes.push('WSL 互操作仍然开着：Studio 的系统用户可以运行 wsl.exe -u root 读出下单密钥。'
      + '在 Windows 上禁用 binfmt 处理器（echo 0 > /proc/sys/fs/binfmt_misc/WSLInterop，用 studio-trader-isolation.service 固化），'
      + '同时检查 /run/WSL 下没有 interop socket。');
  }
  if (windowsDrives.length) {
    notes.push(`Windows 盘 ${windowsDrives.join('、')} 对 Studio 的系统用户可读写：可以借此写启动项变成 Windows 用户，或读出旧的密钥副本。`
      + '在 /etc/wsl.conf 设 [automount] enabled=false，或挂载参数 uid=0,umask=077。');
  }
  return { ok: !interopActive && windowsDrives.length === 0, interopActive, interopBinfmt, interopSocket, windowsDrives, notes };
}

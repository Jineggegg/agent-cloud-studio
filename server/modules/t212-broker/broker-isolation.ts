import { readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { StudioT212BrokerIsolation } from '@/shared/types.js';

// binfmt_misc handlers that hand any executed Windows PE file to /init, which asks the WSL interop server to start
// it on Windows as the Windows user (wsl.exe -u root included). WSL registers WSLInterop at boot; some versions add
// WSLInterop-late after systemd has started.
const BINFMT_DIR = '/proc/sys/fs/binfmt_misc';
const INTEROP_HANDLERS = ['WSLInterop', 'WSLInterop-late'];
// The interop server's unix sockets (one per WSL session, e.g. 2_interop, with 1_interop linking to it). `/init
// <program.exe>` uses one of them directly, so they must be unreachable for non-root users even without a handler.
const INTEROP_RUN_DIR = '/run/WSL';
const MOUNTS = '/proc/self/mounts';
const WSL_CONF_AUTOMOUNT = '[automount] options = "uid=0,gid=0,umask=022,fmask=133"（不要加 metadata）或 enabled = false';

// What the checks need to know about a file, after following links.
type Probe = { uid: number; gid: number; mode: number; socket: boolean };
// Injectable so the broker tests can describe a machine without touching the real /proc and /run.
type Readers = {
  readText?: (filePath: string) => string;
  readDir?: (dirPath: string) => string[];
  stat?: (filePath: string) => Probe;
  // Kernel release (uname -r); WSL kernels contain "microsoft".
  release?: () => string;
};
type State = 'safe' | 'unsafe' | 'unknown';

/** Whether an account other than root may use permission `bit` (0o1 search, 0o2 write) on a file it can reach. */
function nonRootMay(probe: Probe, bit: number) {
  return probe.uid !== 0 || (probe.gid !== 0 && (probe.mode & (bit << 3)) !== 0) || (probe.mode & bit) !== 0;
}

// 'unsafe' while a handler is enabled. 'unknown' when binfmt_misc cannot be read on WSL (a sandbox hiding /proc/sys,
// or binfmt_misc not mounted): a handler may still be registered, so that must not pass as safe.
function binfmtState(readText: (filePath: string) => string, onWsl: boolean): State {
  for (const handler of INTEROP_HANDLERS) {
    try { if (/^enabled/m.test(readText(path.join(BINFMT_DIR, handler)))) return 'unsafe'; } catch { /* absent */ }
  }
  try { readText(path.join(BINFMT_DIR, 'status')); return 'safe'; } catch { return onWsl ? 'unknown' : 'safe'; }
}

// 'unsafe' when some non-root account may search /run/WSL and write one of its interop sockets. A /run/WSL that
// only root may search (root:root 0700) hides every socket in it, including those WSL creates there later.
function interopSocketState(readDir: (dirPath: string) => string[], stat: (filePath: string) => Probe): State {
  let directory: Probe;
  try { directory = stat(INTEROP_RUN_DIR); } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'safe' : 'unknown';
  }
  if (!nonRootMay(directory, 0o1)) return 'safe';
  let names: string[];
  // Searchable but not listable (e.g. 0711): sockets with guessable names may still be reachable.
  try { names = readDir(INTEROP_RUN_DIR); } catch { return 'unknown'; }
  for (const name of names) {
    if (!name.includes('interop')) continue;
    let entry: Probe;
    try { entry = stat(path.join(INTEROP_RUN_DIR, name)); } catch { continue; }
    if (entry.socket && nonRootMay(entry, 0o2)) return 'unsafe';
  }
  return 'safe';
}

// Windows drives (drvfs over 9p, or virtiofs) that a non-root account may write. Without the metadata option every
// file on a drive has the owner and mode of its root, so the root decides; with metadata files carry their own
// Linux owner and mode, which the root says nothing about. A drive that cannot be inspected counts as writable.
function writableWindowsDrives(mounts: string, stat: (filePath: string) => Probe) {
  const found: string[] = [];
  for (const line of mounts.split('\n')) {
    const [, rawMountPoint, fsType, options = ''] = line.split(' ');
    if (!rawMountPoint) continue;
    const tokens = options.split(/[,;]/);
    if (!(fsType === 'drvfs' || fsType === 'virtiofs' || (fsType === '9p' && tokens.includes('aname=drvfs')))) continue;
    // The mounts table escapes spaces and other separators as octal (\040).
    const mountPoint = rawMountPoint.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
    let exposed = tokens.includes('metadata');
    if (!exposed) {
      try { exposed = nonRootMay(stat(mountPoint), 0o2); } catch { exposed = true; }
    }
    if (exposed) found.push(mountPoint);
  }
  return found;
}

function defaultStat(filePath: string): Probe {
  const stats = statSync(filePath);
  return { uid: stats.uid, gid: stats.gid, mode: stats.mode & 0o7777, socket: stats.isSocket() };
}

/**
 * Used by the broker service (GET /v1/status) and CLI (`check`): inspects the running WSL instance for the
 * isolation the broker depends on. It never trusts /etc/wsl.conf, which on some WSL versions is parsed yet leaves
 * interop running; it reads the live state instead. Interop counts as active while a binfmt handler is enabled OR
 * an interop socket is reachable by non-root users (`/init <program.exe>` needs no handler); a state it cannot read
 * counts as active too. The result is data for the owner: Studio's Settings page shows "隔离无效" when not ok.
 */
export function inspectIsolation(readers: Readers = {}): StudioT212BrokerIsolation {
  const readText = readers.readText ?? ((filePath: string) => readFileSync(filePath, 'utf8'));
  const readDir = readers.readDir ?? ((dirPath: string) => readdirSync(dirPath));
  const stat = readers.stat ?? defaultStat;
  const onWsl = /microsoft/i.test((readers.release ?? os.release)());

  const binfmt = binfmtState(readText, onWsl);
  const socket = interopSocketState(readDir, stat);
  let windowsDrives: string[] = [];
  let drivesUnknown = false;
  try { windowsDrives = writableWindowsDrives(readText(MOUNTS), stat); } catch { drivesUnknown = onWsl; }

  const notes: string[] = [];
  if (binfmt === 'unsafe') {
    notes.push('WSL 互操作处理器（binfmt_misc 的 WSLInterop）仍然启用：Studio 的系统用户运行任何 Windows 程序（比如 wsl.exe -u root）'
      + '都会以 Windows 用户身份启动，从而读出下单密钥。studio-trader-isolation.service 每次开机会移除它：'
      + 'sudo systemctl restart studio-trader-isolation 立即执行。');
  } else if (binfmt === 'unknown') {
    notes.push(`读不到 ${BINFMT_DIR}，无法确认 WSL 互操作处理器已经移除；按无效处理。`);
  }
  if (socket === 'unsafe') {
    notes.push(`${INTEROP_RUN_DIR} 里的互操作 socket 对非 root 用户可用：即使没有 binfmt 处理器，直接运行 /init <程序.exe> 也能启动 Windows 程序。`
      + `studio-trader-isolation.service 每次开机会把 ${INTEROP_RUN_DIR} 改成只有 root 能进（root:root 0700）。`);
  } else if (socket === 'unknown') {
    notes.push(`无法检查 ${INTEROP_RUN_DIR} 里的互操作 socket（能进入但不能列出）；按无效处理。`);
  }
  if (windowsDrives.length) {
    notes.push(`Windows 盘 ${windowsDrives.join('、')} 对非 root 用户可写（或用了 metadata、无法确认）：Studio 的系统用户可以在 Windows 用户目录里放启动项或 .wslconfig，`
      + `下次登录 Windows 时以 Windows 用户身份运行，再用 wsl.exe -u root 读出下单密钥。在 /etc/wsl.conf 设 ${WSL_CONF_AUTOMOUNT}，然后 wsl.exe --shutdown。`);
  }
  if (drivesUnknown) notes.push(`读不到 ${MOUNTS}，无法确认 Windows 盘的挂载方式；按无效处理。`);
  const interopBinfmt = binfmt !== 'safe';
  const interopSocket = socket !== 'safe';
  const interopActive = interopBinfmt || interopSocket;
  return {
    ok: !interopActive && windowsDrives.length === 0 && !drivesUnknown, interopActive, interopBinfmt, interopSocket, windowsDrives, notes,
  };
}

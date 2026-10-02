import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inspectIsolation } from '../broker-isolation.js';

type Probe = { uid: number; gid: number; mode: number; socket: boolean };
type Machine = { text?: Record<string, string>; dirs?: Record<string, string[]>; stats?: Record<string, Probe>; release?: string };

const BINFMT = '/proc/sys/fs/binfmt_misc';
const MOUNTS = '/proc/self/mounts';
const WSL_KERNEL = '6.18.40.1-microsoft-standard-WSL2';
const LINUX_MOUNT = '/dev/sdc / ext4 rw,relatime 0 0';
const root = (mode: number, socket = false): Probe => ({ uid: 0, gid: 0, mode, socket });

// A /proc/self/mounts line as WSL writes it for a Windows drive.
function drive(mountPoint: string, options = 'uid=1000;gid=1000') {
  return `C:\\134 ${mountPoint} 9p rw,noatime,aname=drvfs;path=C:\\;${options};symlinkroot=/mnt/,cache=0x5,access=client 0 0`;
}
function missing(filePath: string): never {
  throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' });
}
// Describes a machine as plain maps; anything not listed does not exist.
function inspect(machine: Machine) {
  return inspectIsolation({
    readText: filePath => machine.text?.[filePath] ?? missing(filePath),
    readDir: dirPath => machine.dirs?.[dirPath] ?? missing(dirPath),
    stat: filePath => machine.stats?.[filePath] ?? missing(filePath),
    release: () => machine.release ?? WSL_KERNEL,
  });
}
// The state the boot oneshot leaves: no handler, /run/WSL root-only (the world-writable sockets stay inside it),
// Windows drives mounted for root with umask 022.
function hardened(): Machine {
  return {
    text: { [`${BINFMT}/status`]: 'enabled\n', [MOUNTS]: [LINUX_MOUNT, drive('/mnt/c', 'uid=0;gid=0;umask=22;fmask=133')].join('\n') },
    dirs: { [BINFMT]: ['register', 'status'], '/run/WSL': ['1_interop', '2_interop'] },
    stats: {
      '/run/WSL': root(0o700),
      '/run/WSL/1_interop': root(0o777, true), '/run/WSL/2_interop': root(0o777, true),
      '/mnt/c': root(0o755),
    },
  };
}

test('a hardened instance reports isolation as ok even though world-writable sockets remain inside a root-only /run/WSL', () => {
  assert.deepEqual(inspect(hardened()), { ok: true, interopActive: false, interopBinfmt: false, interopSocket: false, windowsDrives: [], notes: [] });
});

test('an enabled WSLInterop or WSLInterop-late handler makes interop active whatever wsl.conf says', () => {
  for (const handler of ['WSLInterop', 'WSLInterop-late']) {
    const machine = hardened();
    machine.text![`${BINFMT}/${handler}`] = 'enabled\ninterpreter /init\nflags: PF\noffset 0\nmagic 4d5a\n';
    const result = inspect(machine);
    assert.equal(result.interopBinfmt, true, handler);
    assert.equal(result.interopSocket, false);
    assert.equal(result.ok, false);
    assert.ok(result.notes.some(note => note.includes('wsl.exe -u root')));
  }
  const disabled = hardened();
  disabled.text![`${BINFMT}/WSLInterop`] = 'disabled\ninterpreter /init\n';
  assert.equal(inspect(disabled).ok, true);
});

test('binfmt_misc that cannot be read counts as interop active on WSL (fail closed), but not on other kernels', () => {
  const hidden = hardened();
  delete hidden.text![`${BINFMT}/status`];
  const onWsl = inspect(hidden);
  assert.equal(onWsl.interopBinfmt, true);
  assert.equal(onWsl.ok, false);
  assert.ok(onWsl.notes.some(note => note.includes('无法确认')));
  assert.equal(inspect({ ...hidden, release: '6.8.0-45-generic' }).ok, true);
});

test('a socket that non-root users can reach counts even without a binfmt handler (/init <program.exe> uses it)', () => {
  // As measured: /run/WSL 0755 root with srwxrwxrwx sockets, and 1_interop a link to 2_interop.
  const open = hardened();
  open.stats!['/run/WSL'] = root(0o755);
  const result = inspect(open);
  assert.equal(result.interopBinfmt, false);
  assert.equal(result.interopSocket, true);
  assert.equal(result.interopActive, true);
  assert.equal(result.ok, false);
  assert.ok(result.notes.some(note => note.includes('/init')));

  // A searchable directory whose sockets only root may write is fine; so is a directory without sockets.
  const rootOnlySockets = hardened();
  rootOnlySockets.stats!['/run/WSL'] = root(0o755);
  rootOnlySockets.stats!['/run/WSL/1_interop'] = root(0o755, true);
  rootOnlySockets.stats!['/run/WSL/2_interop'] = root(0o755, true);
  assert.equal(inspect(rootOnlySockets).interopSocket, false);
  const empty = hardened();
  empty.stats!['/run/WSL'] = root(0o755);
  empty.dirs!['/run/WSL'] = [];
  assert.equal(inspect(empty).interopSocket, false);

  // A non-root owner or group may reach a socket whatever the "others" bits say.
  const groupReachable = hardened();
  groupReachable.stats!['/run/WSL'] = { uid: 0, gid: 1000, mode: 0o750, socket: false };
  groupReachable.stats!['/run/WSL/2_interop'] = { uid: 0, gid: 1000, mode: 0o770, socket: true };
  assert.equal(inspect(groupReachable).interopSocket, true);

  // Searchable but unlistable: guessable socket names may still be reachable, so it is not safe.
  const unlistable = hardened();
  unlistable.stats!['/run/WSL'] = root(0o711);
  delete unlistable.dirs!['/run/WSL'];
  assert.equal(inspect(unlistable).interopSocket, true);

  // No /run/WSL at all is fine.
  const none = hardened();
  delete none.stats!['/run/WSL'];
  assert.equal(inspect(none).interopSocket, false);
});

test('Windows drives writable by non-root users are reported; a root-owned umask 022 mount is not', () => {
  const machine = hardened();
  machine.text![MOUNTS] = [
    LINUX_MOUNT, drive('/mnt/c'), drive('/mnt/d', 'uid=0;gid=0;umask=22'), drive('/mnt/e', 'metadata;uid=0;gid=0;umask=22'),
    drive('/mnt/my\\040drive', 'uid=0;gid=0;umask=22'),
    'drivers /usr/lib/wsl/drivers 9p ro,nosuid,nodev,noatime,aname=drivers;fmask=222;dmask=222 0 0',
  ].join('\n');
  machine.stats!['/mnt/c'] = { uid: 1000, gid: 1000, mode: 0o777, socket: false };
  machine.stats!['/mnt/d'] = root(0o755);
  machine.stats!['/mnt/e'] = root(0o755);
  // '/mnt/my drive' cannot be inspected: it counts as writable.
  const result = inspect(machine);
  assert.deepEqual(result.windowsDrives, ['/mnt/c', '/mnt/e', '/mnt/my drive']);
  assert.equal(result.interopActive, false);
  assert.equal(result.ok, false);
  assert.ok(result.notes.some(note => note.includes('/mnt/c') && note.includes('uid=0,gid=0,umask=022,fmask=133')));
});

test('a mounts table that cannot be read fails closed on WSL; nothing readable on another kernel is fine', () => {
  const machine = hardened();
  delete machine.text![MOUNTS];
  assert.equal(inspect(machine).ok, false);
  assert.deepEqual(inspect({ release: '6.8.0-45-generic' }),
    { ok: true, interopActive: false, interopBinfmt: false, interopSocket: false, windowsDrives: [], notes: [] });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inspectIsolation } from '../broker-isolation.js';

// A /proc/self/mounts line as WSL writes it for a Windows drive, with the uid it is mounted for.
function drive(mountPoint: string, uid: number) {
  return `drvfs ${mountPoint} 9p rw,noatime,aname=drvfs;path=C:\\;uid=${uid};gid=${uid};symlinkroot=/mnt/ 0 0`;
}
const LINUX_MOUNT = '/dev/sdc / ext4 rw,relatime 0 0';
const missing = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

test('a hardened instance reports isolation as ok', () => {
  const result = inspectIsolation({
    readText: () => 'disabled\n',
    readDir: missing,
    readMounts: () => [LINUX_MOUNT, drive('/mnt/c', 0)].join('\n'),
  });
  assert.deepEqual(result, { ok: true, interopActive: false, interopBinfmt: false, interopSocket: false, windowsDrives: [], notes: [] });
});

test('an enabled WSLInterop binfmt handler makes interop active even when wsl.conf claims otherwise', () => {
  const result = inspectIsolation({
    readText: () => 'enabled\ninterpreter /init\nflags: PF\n',
    readDir: missing,
    readMounts: () => LINUX_MOUNT,
  });
  assert.equal(result.interopBinfmt, true);
  assert.equal(result.interopActive, true);
  assert.equal(result.ok, false);
  assert.ok(result.notes.some(note => note.includes('wsl.exe -u root')));
});

test('a lingering /run/WSL interop socket also counts as interop active', () => {
  const result = inspectIsolation({
    readText: missing,
    readDir: () => ['1_interop', '2_interop'],
    readMounts: () => LINUX_MOUNT,
  });
  assert.equal(result.interopBinfmt, false);
  assert.equal(result.interopSocket, true);
  assert.equal(result.interopActive, true);
  assert.equal(result.ok, false);
});

test('Windows drives mounted for a non-root user are reported; a uid=0 mount is not', () => {
  const accessible = inspectIsolation({
    readText: () => 'disabled', readDir: missing,
    readMounts: () => [LINUX_MOUNT, drive('/mnt/c', 1000), drive('/mnt/d', 1000)].join('\n'),
  });
  assert.deepEqual(accessible.windowsDrives, ['/mnt/c', '/mnt/d']);
  assert.equal(accessible.ok, false);
  assert.ok(accessible.notes.some(note => note.includes('/mnt/c') && note.includes('automount')));

  const locked = inspectIsolation({ readText: () => 'disabled', readDir: missing, readMounts: () => drive('/mnt/c', 0) });
  assert.deepEqual(locked.windowsDrives, []);
  assert.equal(locked.ok, true);
});

test('all probes failing (not WSL) is treated as no interop and no Windows drives', () => {
  const result = inspectIsolation({ readText: missing, readDir: missing, readMounts: missing });
  assert.deepEqual(result, { ok: true, interopActive: false, interopBinfmt: false, interopSocket: false, windowsDrives: [], notes: [] });
});

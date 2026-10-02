import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runBrokerCommand } from '../index.js';
import { parseBrokerConfig } from '../broker.config.js';

// Runs the installer's checks (scripts/wsl/t212-broker-install-lib.sh) with bash as the current, non-root user.
// The machine is described by fixtures: T212_BINFMT_DIR, T212_WSL_RUN_DIR and T212_MOUNTS_FILE point at temporary
// files, and the functions that need root (as_user, sudo_rules_for, groups_of, path_stat) are replaced.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPTS = path.join(REPO, 'scripts', 'wsl');
const LIB = path.join(SCRIPTS, 't212-broker-install-lib.sh');
const USER = os.userInfo().username;
const ENABLED = 'enabled\ninterpreter /init\nflags: PF\noffset 0\nmagic 4d5a\n';
const WSL_CONF_LINE = 'options = "uid=0,gid=0,umask=022,fmask=133"';

// Defaults: probes run as this user, sudo always asks for a password, no special groups, and path_stat reports
// root as the owner (the fixtures cannot be root-owned), keeping the real mode bits.
const AS_ME = 'as_user() { shift; "$@"; }';
const SUDO_WITH_PASSWORD = 'sudo_rules_for() { echo "User $1 may run the following commands on host: (ALL : ALL) ALL"; }';
const PLAIN_GROUPS = 'groups_of() { echo "$1"; echo users; }';
const ROOT_OWNED = 'path_stat() { local mode; mode="$(stat -L -c %a -- "$1")" || return 1; echo "0 0 $mode"; }';
const DEFAULTS = [AS_ME, SUDO_WITH_PASSWORD, PLAIN_GROUPS, ROOT_OWNED];

type Run = { code: number | null; stdout: string; stderr: string };

function bash(script: string, env: Record<string, string> = {}, overrides = DEFAULTS): Run {
  const result = spawnSync('bash', ['-c', `set -u\n. "$LIB"\n${overrides.join('\n')}\n${script}`], {
    env: { ...process.env, LIB, ...env }, encoding: 'utf8', timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
function scratch(prefix: string) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}
// Makes a tree writable again so it can be removed after a test made parts of it read-only.
function remove(directory: string) {
  spawnSync('chmod', ['-R', 'u+w', directory]);
  rmSync(directory, { recursive: true, force: true });
}

type MachineOptions = { handler?: string; lateHandler?: string; status?: boolean; runDirMode?: number; socketMode?: number; sockets?: boolean; driveWritable?: boolean };

/**
 * A WSL instance on disk: binfmt_misc entries, /run/WSL with a live unix socket 2_interop and 1_interop linking to
 * it (as measured on WSL 3.0.1.0), and a Windows drive C: mounted at <dir>/mnt/c with a user profile in it.
 * Defaults describe a hardened machine.
 */
async function machine(options: MachineOptions = {}) {
  const directory = scratch('t212-install-');
  const binfmt = path.join(directory, 'binfmt');
  const run = path.join(directory, 'run', 'WSL');
  const drive = path.join(directory, 'mnt', 'c');
  mkdirSync(binfmt, { recursive: true });
  if (options.status !== false) writeFileSync(path.join(binfmt, 'status'), 'enabled\n');
  if (options.handler) writeFileSync(path.join(binfmt, 'WSLInterop'), options.handler);
  if (options.lateHandler) writeFileSync(path.join(binfmt, 'WSLInterop-late'), options.lateHandler);
  mkdirSync(run, { recursive: true });
  let server: net.Server | null = null;
  if (options.sockets !== false) {
    server = net.createServer();
    await new Promise<void>(resolve => server!.listen(path.join(run, '2_interop'), resolve));
    chmodSync(path.join(run, '2_interop'), options.socketMode ?? 0o777);
    symlinkSync(path.join(run, '2_interop'), path.join(run, '1_interop'));
  }
  chmodSync(run, options.runDirMode ?? 0o700);
  const startup = path.join(drive, 'Users', 'owner', 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  mkdirSync(startup, { recursive: true });
  mkdirSync(path.join(drive, 'Windows', 'System32'), { recursive: true });
  // Read-only unless the drive is meant to be writable (the probe uses test -w as this user).
  if (!options.driveWritable) spawnSync('chmod', ['-R', 'a-w', drive]);
  const mounts = path.join(directory, 'mounts');
  writeFileSync(mounts, [
    '/dev/sdc / ext4 rw,relatime 0 0',
    `C:\\134 ${drive} 9p rw,noatime,aname=drvfs;path=C:\\;uid=0;gid=0;umask=22;fmask=133;symlinkroot=/mnt/,cache=0x5 0 0`,
    'drivers /usr/lib/wsl/drivers 9p ro,nosuid,nodev,noatime,aname=drivers;fmask=222;dmask=222 0 0',
  ].join('\n'));
  return {
    directory, drive, startup, run,
    env: { T212_BINFMT_DIR: binfmt, T212_WSL_RUN_DIR: run, T212_MOUNTS_FILE: mounts },
    close: async () => {
      if (server) await new Promise(resolve => server!.close(resolve));
      remove(directory);
    },
  };
}
async function problems(options: MachineOptions, overrides = DEFAULTS) {
  const m = await machine(options);
  try {
    const result = bash('isolation_problems "$STUDIO_USER"', { ...m.env, STUDIO_USER: USER }, overrides);
    assert.equal(result.code, 0, result.stderr);
    return { lines: result.stdout.split('\n').filter(Boolean), machine: m };
  } finally { await m.close(); }
}

test('a hardened machine has no isolation problems, although world-writable sockets remain in a root-only /run/WSL', async () => {
  const { lines } = await problems({});
  assert.deepEqual(lines, []);
});

test('an enabled WSLInterop or WSLInterop-late handler is a problem; a disabled one is not; an unreadable status fails closed', async () => {
  const enabled = await problems({ handler: ENABLED });
  assert.equal(enabled.lines.length, 1);
  assert.match(enabled.lines[0], /binfmt handler WSLInterop is enabled.*wsl\.exe -u root/);
  assert.match((await problems({ lateHandler: ENABLED })).lines.join('\n'), /WSLInterop-late is enabled/);
  assert.deepEqual((await problems({ handler: 'disabled\ninterpreter /init\n' })).lines, []);
  assert.match((await problems({ status: false })).lines.join('\n'), /cannot read .*status/);
});

test('an interop socket counts only when non-root users can reach it: searchable directory and writable socket', async () => {
  // As measured: /run/WSL 0755 root, sockets srwxrwxrwx root. /init <program.exe> needs no binfmt handler.
  const open = await problems({ runDirMode: 0o755 });
  assert.equal(open.lines.length, 1);
  assert.match(open.lines[0], /interop socket .*_interop is usable by non-root users: \/init <program\.exe>/);
  // The boot oneshot's state: the same sockets inside a root-only directory.
  assert.deepEqual((await problems({ runDirMode: 0o700 })).lines, []);
  // A searchable directory whose sockets only root may write, or one without sockets, is fine.
  assert.deepEqual((await problems({ runDirMode: 0o755, socketMode: 0o755 })).lines, []);
  assert.deepEqual((await problems({ runDirMode: 0o755, sockets: false })).lines, []);
  // With the real owner (this non-root user) even a 0700 directory is reachable: its owner can enter it.
  const realOwner = await problems({ runDirMode: 0o700 }, [AS_ME, SUDO_WITH_PASSWORD, PLAIN_GROUPS]);
  assert.match(realOwner.lines.join('\n'), /interop socket/);
  // A non-root group with search and write permission also counts.
  const groupOwned = 'path_stat() { local mode; mode="$(stat -L -c %a -- "$1")" || return 1; echo "0 1000 $mode"; }';
  const viaGroup = await problems({ runDirMode: 0o750, socketMode: 0o770 }, [AS_ME, SUDO_WITH_PASSWORD, PLAIN_GROUPS, groupOwned]);
  assert.match(viaGroup.lines.join('\n'), /interop socket/);
});

test('Windows paths the Studio user can write are reported with the wsl.conf fix; read-only drives are not', async () => {
  const writable = await problems({ driveWritable: true });
  const text = writable.lines.join('\n');
  assert.ok(writable.lines.length >= 4, text);
  assert.ok(writable.lines.every(line => line.includes(`${USER} can write the Windows path`)), text);
  assert.match(text, /\/mnt\/c:/);
  assert.match(text, /\/Users\/owner:/);
  assert.match(text, /Start Menu\/Programs\/Startup:/);
  assert.deepEqual((await problems({ driveWritable: false })).lines, []);
  // A probe that cannot run is a problem, never a pass.
  const failingProbe = await problems({ driveWritable: false }, ['as_user() { return 1; }', SUDO_WITH_PASSWORD, PLAIN_GROUPS, ROOT_OWNED]);
  assert.match(failingProbe.lines.join('\n'), /could not check which Windows paths/);
});

test('windows_drive_roots finds drvfs drives (9p aname=drvfs, drvfs, virtiofs) and decodes escaped mount points', () => {
  const directory = scratch('t212-install-');
  try {
    const mounts = path.join(directory, 'mounts');
    writeFileSync(mounts, [
      'C:\\134 /mnt/c 9p rw,noatime,aname=drvfs;path=C:\\;uid=1000;gid=1000;symlinkroot=/mnt/ 0 0',
      'D: /mnt/my\\040drive drvfs rw,noatime 0 0',
      'drvfsE /mnt/e virtiofs rw,relatime 0 0',
      'drivers /usr/lib/wsl/drivers 9p ro,aname=drivers;fmask=222 0 0',
      'none /run tmpfs rw 0 0',
    ].join('\n'));
    const result = bash('windows_drive_roots "$MOUNTS"', { MOUNTS: mounts });
    assert.deepEqual(result.stdout.split('\n').filter(Boolean), ['/mnt/c', '/mnt/my drive', '/mnt/e']);
  } finally { remove(directory); }
});

test('sudo without a password and root-equivalent groups are problems', async () => {
  const nopasswd = 'sudo_rules_for() { echo "User $1 may run the following commands on host: (ALL) NOPASSWD: ALL"; }';
  assert.match((await problems({}, [AS_ME, nopasswd, PLAIN_GROUPS, ROOT_OWNED])).lines.join('\n'), /sudo without a password/);
  const docker = 'groups_of() { printf "%s\\n" "$1" docker; }';
  assert.match((await problems({}, [AS_ME, SUDO_WITH_PASSWORD, docker, ROOT_OWNED])).lines.join('\n'), /in the docker group, which is root-equivalent/);
});

test('enforce_isolation fails closed, prints the wsl.conf lines, and only --accept-insecure continues', async () => {
  const m = await machine({ handler: ENABLED, runDirMode: 0o755, driveWritable: true });
  try {
    const env = { ...m.env, STUDIO_USER: USER };
    const refused = bash('enforce_isolation "$STUDIO_USER" 0; echo continued', env);
    assert.equal(refused.code, 1);
    assert.ok(!refused.stdout.includes('continued'));
    assert.match(refused.stderr, /^ {2}- the WSL interop binfmt handler WSLInterop is enabled/m);
    assert.match(refused.stderr, /^ {2}- the WSL interop socket/m);
    assert.match(refused.stderr, /can write the Windows path/);
    assert.ok(refused.stderr.includes(WSL_CONF_LINE), 'prints the exact [automount] line');
    assert.match(refused.stderr, /\[interop\]\n\s+enabled = false/);
    assert.match(refused.stderr, /ERROR: the broker cannot protect the order key/);

    const accepted = bash('enforce_isolation "$STUDIO_USER" 1; echo continued', env);
    assert.equal(accepted.code, 0);
    assert.match(accepted.stdout, /continued/);
    assert.match(accepted.stderr, /WARNING: --accept-insecure: .*CANNOT protect/);
  } finally { await m.close(); }

  const clean = await machine({});
  try {
    const passed = bash('enforce_isolation "$STUDIO_USER" 0', { ...clean.env, STUDIO_USER: USER });
    assert.equal(passed.code, 0, passed.stderr);
    assert.match(passed.stdout, /isolation checks passed/);
  } finally { await clean.close(); }
});

test('require_trusted_path accepts only root-owned paths that only root can write, through links as well', () => {
  const directory = scratch('t212-install-');
  try {
    const own = path.join(directory, 'file');
    writeFileSync(own, 'x');
    const link = path.join(directory, 'env-link');
    symlinkSync('/usr/bin/env', link);
    const check = (target: string) => bash('require_trusted_path "$TARGET" && echo trusted', { TARGET: target });
    assert.match(check('/usr/bin/env').stdout, /trusted/);
    assert.match(check(own).stderr, new RegExp(`belongs to uid ${process.getuid!()}, not root`));
    // The link resolves to a trusted file, but it sits in a directory this user can write: it could be swapped.
    assert.match(check(link).stderr, /belongs to uid .*, not root/);
    assert.match(check('/tmp').stderr, /\/tmp .*writable by group or others/);
    assert.match(check(path.join(directory, 'missing')).stderr, /does not exist/);
    assert.match(bash('require_trusted_tree "$TARGET" && echo trusted', { TARGET: directory }).stderr, /not root/);
  } finally { remove(directory); }
});

test('require_plain_tree accepts plain files and directories and refuses links, FIFOs, sockets and setuid files', async () => {
  const build = () => {
    const directory = scratch('t212-install-');
    mkdirSync(path.join(directory, 'app', 'lib'), { recursive: true });
    writeFileSync(path.join(directory, 'app', 'main.js'), 'export {};\n');
    writeFileSync(path.join(directory, 'app', 'lib', 'x.js'), 'export {};\n');
    return directory;
  };
  const plain = (directory: string) => bash('require_plain_tree "$TARGET" && echo plain', { TARGET: directory });
  const cases: [string, (directory: string) => Promise<void> | void, RegExp][] = [
    ['link', directory => symlinkSync('main.js', path.join(directory, 'app', 'alias.js')), /alias\.js: symbolic link/],
    ['fifo', directory => { spawnSync('mkfifo', [path.join(directory, 'app', 'pipe')]); }, /pipe: fifo/],
    ['setuid', directory => chmodSync(path.join(directory, 'app', 'main.js'), 0o4755), /main\.js: it has a set-user-ID/],
  ];
  const clean = build();
  try { assert.match(plain(clean).stdout, /plain/); } finally { remove(clean); }
  for (const [name, change, refusal] of cases) {
    const directory = build();
    try {
      await change(directory);
      const result = plain(directory);
      assert.equal(result.code, 1, name);
      assert.match(result.stderr, refusal, name);
    } finally { remove(directory); }
  }
  const withSocket = build();
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(path.join(withSocket, 'app', 'sock'), resolve));
  try { assert.match(plain(withSocket).stderr, /sock: socket/); } finally {
    await new Promise(resolve => server.close(resolve));
    remove(withSocket);
  }
});

test('install_node_tarball uses a tarball only when its SHA-256 matches, and only an official-looking layout', () => {
  const directory = scratch('t212-install-');
  try {
    const top = path.join(directory, 'node-v24.0.0-linux-x64');
    const required = ['bin/node', 'lib/node_modules/npm/bin/npm-cli.js', 'lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js', 'include/node/common.gypi'];
    for (const relative of required) {
      mkdirSync(path.dirname(path.join(top, relative)), { recursive: true });
      writeFileSync(path.join(top, relative), relative);
    }
    const tarball = path.join(directory, 'node.tar.gz');
    spawnSync('tar', ['-czf', tarball, '-C', directory, 'node-v24.0.0-linux-x64']);
    const hash = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    const install = (expected: string, work: string) => {
      mkdirSync(work, { recursive: true });
      return bash('install_node_tarball "$TARBALL" "$EXPECTED" "$WORK" && echo "prefix=$NODE_PREFIX"', { TARBALL: tarball, EXPECTED: expected, WORK: work });
    };

    const wrong = install('0'.repeat(64), path.join(directory, 'work-wrong'));
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, new RegExp(`SHA-256 is ${hash}, not 0{64}`));
    assert.deepEqual(readdirSync(path.join(directory, 'work-wrong')), [], 'nothing of a rejected tarball is kept or unpacked');

    assert.match(install('abc', path.join(directory, 'work-short')).stderr, /must be the 64-character SHA-256/);

    const work = path.join(directory, 'work-ok');
    const ok = install(hash.toUpperCase(), work);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, new RegExp(`prefix=${work}/node`));
    assert.equal(readFileSync(path.join(work, 'node', 'bin', 'node'), 'utf8'), 'bin/node');
    assert.ok(!existsSync(path.join(work, 'node.tar')));

    rmSync(path.join(top, 'include'), { recursive: true });
    spawnSync('tar', ['-czf', tarball, '-C', directory, 'node-v24.0.0-linux-x64']);
    const partial = install(createHash('sha256').update(readFileSync(tarball)).digest('hex'), path.join(directory, 'work-partial'));
    assert.match(partial.stderr, /the tarball has no include\/node\/common\.gypi/);
  } finally { remove(directory); }
});

test('the stage script copies plain files only and refuses every link, inside a package or as the package', () => {
  const build = () => {
    const from = scratch('t212-stage-');
    const compiled = path.join(from, 'dist-server', 'server', 'modules', 't212-broker');
    mkdirSync(compiled, { recursive: true });
    writeFileSync(path.join(compiled, 'main.js'), 'export {};\n');
    writeFileSync(path.join(compiled, 'main.js.map'), '{}');
    for (const name of ['better-sqlite3', '@simplewebauthn/server']) {
      const directory = path.join(from, 'node_modules', name);
      mkdirSync(path.join(directory, 'lib'), { recursive: true });
      writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
      writeFileSync(path.join(directory, 'lib', 'index.js'), 'module.exports = {};\n');
    }
    return from;
  };
  const stage = (from: string) => spawnSync(process.execPath, [path.join(SCRIPTS, 'stage-t212-broker.mjs'), '--from', from, '--to', path.join(from, 'out')], { encoding: 'utf8' });

  const clean = build();
  try {
    const result = stage(clean);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(path.join(clean, 'out', 'app')), ['main.js']);
    assert.ok(existsSync(path.join(clean, 'out', 'node_modules', '@simplewebauthn', 'server', 'lib', 'index.js')));
  } finally { remove(clean); }

  const inside = build();
  try {
    // A link inside a package, even one pointing within the same package, is refused.
    symlinkSync('index.js', path.join(inside, 'node_modules', 'better-sqlite3', 'lib', 'alias.js'));
    const result = stage(inside);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing .*alias\.js: it is a symbolic link/);
  } finally { remove(inside); }

  const linked = build();
  try {
    const elsewhere = path.join(linked, 'elsewhere');
    mkdirSync(elsewhere);
    const server = path.join(linked, 'node_modules', '@simplewebauthn', 'server');
    spawnSync('mv', [server, path.join(elsewhere, 'server')]);
    symlinkSync(path.join(elsewhere, 'server'), server);
    const result = stage(linked);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing .*@simplewebauthn\/server: it is a symbolic link/);
  } finally { remove(linked); }
});

// The installer's validate_config step: the new config.json goes through the broker's own validate-config.
async function validateConfig(text: string) {
  let stdout = '';
  let stderr = '';
  const sink = (append: (chunk: string) => void) => new Writable({ write(chunk, _encoding, done) { append(String(chunk)); done(); } });
  const code = await runBrokerCommand(['validate-config'], {
    stdout: sink(chunk => { stdout += chunk; }), stderr: sink(chunk => { stderr += chunk; }),
    stdin: Readable.from([text]), env: { STUDIO_TRADER_STATE_DIR: '/nonexistent' }, pid: process.pid,
  });
  return { code, stdout, stderr };
}

test('the installer writes config.json the broker accepts, and its own parser catches what the shell cannot', async () => {
  const generate = (origins: string, values = '500 2000 60 10') =>
    bash(`broker_config_json demo "$ORIGINS" ${values}`, { ORIGINS: origins });

  const typical = generate('https://studio.ajarche.com, https://desktop.tail1234.ts.net:8443');
  assert.equal(typical.code, 0, typical.stderr);
  const config = parseBrokerConfig(typical.stdout, '/x');
  assert.deepEqual(
    [config.allowedEnvs, config.origins, config.maxOrderValue, config.maxDailyOrderValue, config.liveOrderCooldownSeconds, config.maxOrdersPerHour, config.demoConfirm],
    [['demo'], ['https://studio.ajarche.com', 'https://desktop.tail1234.ts.net:8443'], 500, 2000, 60, 10, false],
  );
  const accepted = await validateConfig(typical.stdout);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.match(accepted.stdout, /配置有效/);

  // These pass the shell's character check, so only the broker's parser stops them before anything is installed.
  const nine = generate(Array.from({ length: 9 }, (_, index) => `https://s${index}.example.com`).join(','));
  assert.equal(nine.code, 0);
  assert.match((await validateConfig(nine.stdout)).stderr, /origins 必须是最多 8 个网址的数组/);
  for (const origin of ['https://Studio.Example.com', 'https://studio.example.com:99999', 'http://localhost:99999']) {
    const generated = generate(origin);
    assert.equal(generated.code, 0, origin);
    const refused = await validateConfig(generated.stdout);
    assert.equal(refused.code, 1, origin);
    assert.match(refused.stderr, /交易代理配置无效/, origin);
  }

  // What cannot be put into JSON safely never gets that far.
  for (const bad of ['https://studio.example.com/', 'https://a"b.example.com', 'javascript:alert(1)']) {
    const refused = generate(bad);
    assert.equal(refused.code, 1, bad);
    assert.match(refused.stderr, /invalid value/, bad);
  }
  assert.match(generate('https://a.example.com', '007 2000 60 10').stderr, /--max-order-value must be a number/);
  assert.match(generate('https://a.example.com', '500 2000 1.5 10').stderr, /--live-cooldown-seconds must be a number/);
  assert.match(generate('https://a.example.com', '500 2000 60 101').stderr, /--max-orders-per-hour must be a number/);
  assert.match(bash('broker_config_json paper "" 500 2000 60 10').stderr, /invalid value: paper/);
  // An empty account list or origin list is valid JSON and a valid config: trading stays off.
  assert.equal((await validateConfig(bash('broker_config_json "" "" 500 0 0 10').stdout)).code, 0);
  assert.match((await validateConfig(' '.repeat(70 * 1024))).stderr, /超过 65536 字节/);
});

const SHELL_SCRIPTS = readdirSync(SCRIPTS).filter(name => name.endsWith('.sh')).map(name => path.join(SCRIPTS, name));
const SHELLCHECK = spawnSync('shellcheck', ['--version']).status === 0;

test('every WSL script parses with bash -n', () => {
  assert.ok(SHELL_SCRIPTS.some(file => file.endsWith('install-t212-broker.sh')));
  for (const file of SHELL_SCRIPTS) {
    const result = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${path.basename(file)}: ${result.stderr}`);
  }
});

test('every WSL script passes shellcheck', { skip: SHELLCHECK ? false : 'shellcheck is not installed' }, () => {
  const result = spawnSync('shellcheck', ['-x', '-P', REPO, ...SHELL_SCRIPTS], { encoding: 'utf8', cwd: REPO });
  assert.equal(result.status, 0, result.stdout);
});

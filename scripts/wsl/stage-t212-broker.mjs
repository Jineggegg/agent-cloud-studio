#!/usr/bin/env node
// Copies the compiled Trading 212 order broker and only its runtime dependencies into a new directory. Run by
// scripts/wsl/build-t212-broker.sh as the unprivileged build user; scripts/wsl/install-t212-broker.sh then copies
// the result into the root-owned /opt/studio-trader. Usable on its own for a dry run:
//   node scripts/wsl/stage-t212-broker.mjs --from . --to /tmp/broker-stage
//
// Layout produced:  <to>/package.json  <to>/app/*.js  <to>/node_modules/<runtime packages>
// The broker imports only Node built-ins, better-sqlite3 and @simplewebauthn/server at runtime (a broker test
// enforces this), so those two packages and their dependency closure are all that is copied.
//
// Only regular files and directories are copied, and every file is opened without following links. A symbolic
// link or any other file type in what would be copied stops the stage: kept as a link it would make the
// root-owned copy load a file that someone else can change; followed, it would copy whatever it points at.
// Only the two starting points, <from> and <from>/node_modules, are resolved through links (a worktree's
// node_modules often is one); they only say where to read from, and nothing below them is followed.
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const ROOT_PACKAGES = ['better-sqlite3', '@simplewebauthn/server'];
// better-sqlite3 lists its install-time downloader as a dependency; the broker never runs it, so it stays behind.
const INSTALL_ONLY = new Set(['prebuild-install']);

function fail(message) {
  console.error(`stage-t212-broker: ${message}`);
  process.exit(1);
}
function describe(stats) {
  if (stats.isSymbolicLink()) return 'a symbolic link';
  if (stats.isDirectory()) return 'a directory';
  if (stats.isFIFO()) return 'a FIFO';
  if (stats.isSocket()) return 'a socket';
  if (stats.isCharacterDevice() || stats.isBlockDevice()) return 'a device';
  return 'not a regular file';
}
function refuse(file, stats) {
  fail(`refusing ${file}: it is ${describe(stats)}; only regular files and directories are staged`);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    console.error('usage: stage-t212-broker.mjs --from <repository root> --to <new or empty directory>');
    process.exit(2);
  }
  return path.resolve(process.argv[index + 1]);
}

// Reads a regular file without following a link (O_NOFOLLOW) or blocking on a FIFO (O_NONBLOCK).
function readRegular(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ELOOP') refuse(file, lstatSync(file));
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) refuse(file, stats);
    return { data: readFileSync(fd), mode: stats.mode };
  } finally {
    closeSync(fd);
  }
}
// 'wx' never writes through an existing entry; write bits for group and others and special bits are dropped.
function copyRegular(source, target) {
  const { data, mode } = readRegular(source);
  writeFileSync(target, data, { flag: 'wx', mode: mode & 0o755 });
}
// Copies a directory tree entry by entry. Nested node_modules are left out: they are resolved and copied as
// packages of their own.
function copyTree(source, target) {
  const stats = lstatSync(source);
  if (!stats.isDirectory()) {
    if (!stats.isFile()) refuse(source, stats);
    copyRegular(source, target);
    return;
  }
  mkdirSync(target, { recursive: true, mode: 0o755 });
  for (const name of readdirSync(source)) {
    if (name !== 'node_modules') copyTree(path.join(source, name), path.join(target, name));
  }
}
// Walks the given components below base with lstat: null when one is missing, a refusal when one is not a real
// directory (a link included), otherwise the path.
function realDirectory(base, parts) {
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      return null;
    }
    if (!stats.isDirectory()) refuse(current, stats);
  }
  return current;
}

const from = realpathSync(argument('--from'));
const to = argument('--to');
const compiled = realDirectory(from, ['dist-server', 'server', 'modules', 't212-broker']);
if (!compiled || !existsSync(path.join(compiled, 'main.js'))) {
  fail(`missing ${path.join(from, 'dist-server/server/modules/t212-broker/main.js')}: compile the broker first`);
}
if (existsSync(to)) {
  const stats = lstatSync(to);
  if (!stats.isDirectory()) refuse(to, stats);
  if (readdirSync(to).length) fail(`${to} must be empty`);
}

// The compiled broker files only; tests and source maps stay behind.
mkdirSync(path.join(to, 'app'), { recursive: true, mode: 0o755 });
for (const name of readdirSync(compiled).sort()) {
  if (name.endsWith('.js')) copyRegular(path.join(compiled, name), path.join(to, 'app', name));
}
writeFileSync(path.join(to, 'package.json'), `${JSON.stringify({ name: 'studio-trader-broker', private: true, type: 'module' }, null, 2)}\n`, { flag: 'wx' });

// Node's lookup: node_modules/<name> in the requiring package's directory, then in each parent up to the top-level
// node_modules. Every component on the way is checked with lstat, so no package is reached through a link.
const modulesRoot = realpathSync(path.join(from, 'node_modules'));
function locate(name, fromDirectory) {
  const parts = name.split('/');
  for (let directory = fromDirectory; directory.startsWith(modulesRoot + path.sep); directory = path.dirname(directory)) {
    const candidate = realDirectory(directory, ['node_modules', ...parts]);
    if (candidate && existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  const topLevel = realDirectory(modulesRoot, parts);
  return topLevel && existsSync(path.join(topLevel, 'package.json')) ? topLevel : null;
}

const copied = new Map();
const queue = ROOT_PACKAGES.map(name => ({ name, fromDirectory: modulesRoot, optional: false }));
while (queue.length) {
  const { name, fromDirectory, optional } = queue.shift();
  if (INSTALL_ONLY.has(name)) continue;
  const directory = locate(name, fromDirectory);
  if (!directory) {
    if (optional) continue;
    fail(`cannot find runtime dependency ${name} (from ${fromDirectory})`);
  }
  if (copied.has(directory)) continue;
  const relative = path.relative(modulesRoot, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail(`${name} resolves outside ${modulesRoot}: ${directory}`);
  const manifest = JSON.parse(readRegular(path.join(directory, 'package.json')).data.toString('utf8'));
  copied.set(directory, `${manifest.name}@${manifest.version}`);
  copyTree(directory, path.join(to, 'node_modules', relative));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) queue.push({ name: dependency, fromDirectory: directory, optional: false });
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) queue.push({ name: dependency, fromDirectory: directory, optional: true });
}

console.log(`staged broker app (${readdirSync(path.join(to, 'app')).length} files) and ${copied.size} packages:`);
for (const label of [...copied.values()].sort()) console.log(`  ${label}`);

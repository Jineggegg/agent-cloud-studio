#!/usr/bin/env node
// Copies the compiled Trading 212 order broker and only its runtime dependencies into a directory that the install
// script then makes root-owned (/opt/studio-trader). Run by scripts/wsl/install-t212-broker.sh; usable on its own
// for a dry run:  node scripts/wsl/stage-t212-broker.mjs --from . --to /tmp/broker-stage
//
// Layout produced:  <to>/package.json  <to>/app/*.js  <to>/node_modules/<runtime packages>
// The broker imports only Node built-ins, better-sqlite3 and @simplewebauthn/server at runtime (a broker test
// enforces this), so those two packages and their dependency closure are all that is copied.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT_PACKAGES = ['better-sqlite3', '@simplewebauthn/server'];
// better-sqlite3 lists its install-time downloader as a dependency; the broker never runs it, so it stays behind.
const INSTALL_ONLY = new Set(['prebuild-install']);

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    console.error(`usage: stage-t212-broker.mjs --from <repository root> --to <empty directory>`);
    process.exit(2);
  }
  return path.resolve(process.argv[index + 1]);
}

const from = argument('--from');
const to = argument('--to');
const compiled = path.join(from, 'dist-server', 'server', 'modules', 't212-broker');
if (!existsSync(path.join(compiled, 'main.js'))) {
  console.error(`missing ${path.join(compiled, 'main.js')}: run "npm run build:server" in ${from} first`);
  process.exit(1);
}
if (existsSync(to) && readdirSync(to).some(name => name !== 'bin')) {
  console.error(`${to} must be empty (a bin/ directory is allowed)`);
  process.exit(1);
}

// The compiled broker files only; tests stay behind.
mkdirSync(path.join(to, 'app'), { recursive: true });
for (const name of readdirSync(compiled)) {
  if (name.endsWith('.js')) cpSync(path.join(compiled, name), path.join(to, 'app', name));
}
writeFileSync(path.join(to, 'package.json'), `${JSON.stringify({ name: 'studio-trader-broker', private: true, type: 'module' }, null, 2)}\n`);

// Node's lookup: node_modules/<name> in the requiring package's directory, then in each parent up to the root.
const modulesRoot = realpathSync(path.join(from, 'node_modules'));
function locate(name, fromDirectory) {
  let directory = fromDirectory;
  for (;;) {
    const candidate = path.join(directory, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
    if (directory === path.dirname(modulesRoot) || directory === path.dirname(directory)) return null;
    directory = path.dirname(directory);
  }
}

const copied = new Map();
const queue = ROOT_PACKAGES.map(name => ({ name, fromDirectory: path.dirname(modulesRoot), optional: false }));
while (queue.length) {
  const { name, fromDirectory, optional } = queue.shift();
  if (INSTALL_ONLY.has(name)) continue;
  const directory = locate(name, fromDirectory);
  if (!directory) {
    if (optional) continue;
    console.error(`cannot find runtime dependency ${name} (from ${fromDirectory})`);
    process.exit(1);
  }
  if (copied.has(directory)) continue;
  const relative = path.relative(modulesRoot, directory);
  if (relative.startsWith('..')) {
    console.error(`${name} resolves outside ${modulesRoot}: ${directory}`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
  copied.set(directory, `${manifest.name}@${manifest.version}`);
  // Nested node_modules are resolved and copied as packages of their own.
  cpSync(directory, path.join(to, 'node_modules', relative), {
    recursive: true, dereference: true,
    filter: source => !path.relative(directory, source).split(path.sep).includes('node_modules'),
  });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) queue.push({ name: dependency, fromDirectory: directory, optional: false });
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) queue.push({ name: dependency, fromDirectory: directory, optional: true });
}

console.log(`staged broker app (${readdirSync(path.join(to, 'app')).length} files) and ${copied.size} packages:`);
for (const label of [...copied.values()].sort()) console.log(`  ${label}`);

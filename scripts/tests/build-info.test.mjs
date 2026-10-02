import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createBuildInfo } from '../build-info.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-build-info-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  return root;
}

test('records checkout identity and detects work built from uncommitted source', (t) => {
  const root = fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init', '--quiet');
  git('add', 'package.json');
  git('-c', 'user.name=Build Test', '-c', 'user.email=build-test@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  const builtAt = '2026-10-02T18:00:00.000Z';
  const clean = createBuildInfo(root, builtAt);
  assert.equal(clean.commit, git('rev-parse', 'HEAD'));
  assert.equal(clean.dirty, false);
  assert.equal(clean.builtAt, builtAt);
  assert.equal(clean.schemaVersion, 1);
  fs.writeFileSync(path.join(root, 'new-feature.ts'), 'export const value = 1;');
  assert.equal(createBuildInfo(root).dirty, true);
  // The original value stays a snapshot when the checkout subsequently changes.
  assert.equal(clean.dirty, false);
});

test('an archive has unknown identity unless it includes a valid release marker', (t) => {
  const root = fixture(t);
  assert.equal(createBuildInfo(root).commit, null);
  assert.equal(createBuildInfo(root).dirty, null);
  fs.writeFileSync(path.join(root, 'RELEASE_COMMIT'), 'a'.repeat(40));
  assert.equal(createBuildInfo(root).commit, 'a'.repeat(40));
  assert.equal(createBuildInfo(root).dirty, null);
  fs.writeFileSync(path.join(root, 'RELEASE_COMMIT'), 'not-a-commit');
  assert.equal(createBuildInfo(root).commit, null);
});

test('does not mistake a parent repository for the source of a nested archive', (t) => {
  const parent = fixture(t);
  execFileSync('git', ['init', '--quiet'], { cwd: parent });
  const root = path.join(parent, 'archive');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.0.0' }));
  assert.equal(createBuildInfo(root).commit, null);
});

test('server preparation freezes identity in staging while preserving the installed build', (t) => {
  const root = fixture(t);
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts);
  for (const name of ['build-info.mjs', 'prepare-server-build.mjs']) {
    fs.copyFileSync(new URL(`../${name}`, import.meta.url), path.join(scripts, name));
  }
  fs.mkdirSync(path.join(root, 'dist-server'));
  fs.writeFileSync(path.join(root, 'dist-server', 'installed.txt'), 'keep this build');
  fs.mkdirSync(path.join(root, 'dist-server.next'));
  fs.writeFileSync(path.join(root, 'dist-server.next', 'stale.txt'), 'incomplete old build');
  fs.writeFileSync(path.join(root, 'RELEASE_COMMIT'), 'a'.repeat(40));
  execFileSync(process.execPath, [path.join(scripts, 'prepare-server-build.mjs')], { cwd: root });
  fs.writeFileSync(path.join(root, 'RELEASE_COMMIT'), 'b'.repeat(40));
  const recorded = JSON.parse(fs.readFileSync(path.join(root, 'dist-server.next', 'build-info.json'), 'utf8'));
  assert.equal(recorded.commit, 'a'.repeat(40));
  assert.equal(fs.existsSync(path.join(root, 'dist-server.next', 'stale.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'dist-server', 'installed.txt'), 'utf8'), 'keep this build');
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { AppError, readSnrBasicAuthorization } from '@/shared/utils.js';

// Each case gets its own throwaway password file with fake test values only.
function withPasswordFile(contents: string | null, run: (file: string) => void) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'snr-basic-'));
  const file = path.join(directory, 'snr-password');
  if (contents !== null) writeFileSync(file, contents);
  try { run(file); } finally { rmSync(directory, { recursive: true }); }
}
const basic = (credential: string) => `Basic ${Buffer.from(credential, 'utf8').toString('base64')}`;

test('SNR access stays unauthenticated unless both the user and the password file are configured', () => {
  assert.equal(readSnrBasicAuthorization({}), null);
  assert.equal(readSnrBasicAuthorization({ STUDIO_SNR_USER: 'unit-test' }), null);
  assert.equal(readSnrBasicAuthorization({ STUDIO_SNR_PASSWORD_FILE: '/nonexistent/snr-password' }), null);
  assert.equal(readSnrBasicAuthorization({ STUDIO_SNR_USER: '  ', STUDIO_SNR_PASSWORD_FILE: '/nonexistent/snr-password' }), null);
});

test('the password file becomes a Basic credential without its trailing newline or BOM', () => {
  withPasswordFile('﻿fake-password with spaces\r\n', file => {
    assert.equal(readSnrBasicAuthorization({ STUDIO_SNR_USER: 'unit-test', STUDIO_SNR_PASSWORD_FILE: file }), basic('unit-test:fake-password with spaces'));
  });
  withPasswordFile('密码-fake-only', file => {
    assert.equal(readSnrBasicAuthorization({ STUDIO_SNR_USER: 'unit-test', STUDIO_SNR_PASSWORD_FILE: file }), basic('unit-test:密码-fake-only'));
  });
});

test('a configured but unusable credential fails closed without revealing the file or password', () => {
  const unusable = (env: NodeJS.ProcessEnv) => assert.throws(() => readSnrBasicAuthorization(env), (error: AppError) => {
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, 'SNR_AUTH_UNAVAILABLE');
    assert.ok(!error.message.includes('snr-password') && !error.message.includes('fake'));
    return true;
  });
  withPasswordFile(null, file => unusable({ STUDIO_SNR_USER: 'unit-test', STUDIO_SNR_PASSWORD_FILE: file }));
  withPasswordFile('\n', file => unusable({ STUDIO_SNR_USER: 'unit-test', STUDIO_SNR_PASSWORD_FILE: file }));
  withPasswordFile('fake-first\nfake-second\n', file => unusable({ STUDIO_SNR_USER: 'unit-test', STUDIO_SNR_PASSWORD_FILE: file }));
  withPasswordFile('fake-password', file => unusable({ STUDIO_SNR_USER: 'unit:test', STUDIO_SNR_PASSWORD_FILE: file }));
});

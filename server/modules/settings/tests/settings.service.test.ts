import assert from 'node:assert/strict';
import test from 'node:test';

import { createSettingsService } from '../settings.service.js';

type Dependencies = Parameters<typeof createSettingsService>[0];

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    verifyStepUp: async () => undefined,
    apiKeys: { list: () => [], create: () => ({}), remove: () => false, toggle: () => false },
    credentials: { list: () => [], create: () => ({}), remove: () => false, toggle: () => false },
    notifications: {
      getPreferences: () => undefined,
      updatePreferences: () => ({}),
      createEnabledEvent: () => ({}),
      notifyUser: () => undefined,
    },
    pushSubscriptions: { save: () => undefined, remove: () => undefined },
    getVapidPublicKey: () => null,
    ...overrides,
  };
}

test('listApiKeys redacts secret values through the service boundary', () => {
  const service = createSettingsService(dependencies({
    apiKeys: {
      list: () => [{ id: 1, api_key: '1234567890-secret' }],
      create: () => ({}), remove: () => false, toggle: () => false,
    },
  }));
  assert.equal(service.listApiKeys(1).apiKeys[0]?.api_key, '1234567890...');
});

test('subscribeToPush persists the subscription and enables Web Push', () => {
  const operations: string[] = [];
  const service = createSettingsService(dependencies({
    pushSubscriptions: {
      save: (_id, endpoint) => operations.push(`save:${endpoint}`),
      remove: () => undefined,
    },
    notifications: {
      getPreferences: () => ({ channels: { webPush: false } }),
      updatePreferences: () => { operations.push('preferences'); return {}; },
      createEnabledEvent: () => ({ code: 'push.enabled' }),
      notifyUser: () => { operations.push('notify'); },
    },
  }));

  service.subscribeToPush(1, {
    endpoint: 'https://push.example.test',
    keys: { p256dh: 'key', auth: 'auth' },
  });
  assert.deepEqual(operations, ['save:https://push.example.test', 'preferences', 'notify']);
});

test('creating an API key or turning one back on needs the password step-up; turning one off does not', async () => {
  const stepUps: unknown[] = [];
  const created: string[] = [];
  const toggled: boolean[] = [];
  let passwordOk = false;
  const service = createSettingsService(dependencies({
    verifyStepUp: async (stepUp) => {
      stepUps.push(stepUp.password);
      if (!passwordOk) throw Object.assign(new Error('wrong'), { statusCode: 403 });
    },
    apiKeys: {
      list: () => [],
      create: (_userId, keyName) => { created.push(keyName); return { keyName }; },
      remove: () => true,
      toggle: (_userId, _keyId, isActive) => { toggled.push(isActive); return true; },
    },
  }));
  const client = { door: 'cloudflare', address: '198.51.100.7' } as const;

  await assert.rejects(service.createApiKey(1, 'laptop', { user: { id: 1 }, password: 'guess', client }));
  assert.deepEqual(created, []);
  await assert.rejects(service.toggleApiKey(1, 3, true, { user: { id: 1 }, password: 'guess', client }));
  await service.toggleApiKey(1, 3, false, { user: { id: 1 }, password: undefined, client });
  assert.deepEqual(toggled, [false]);

  passwordOk = true;
  await service.createApiKey(1, 'laptop', { user: { id: 1 }, password: 'right', client });
  await service.toggleApiKey(1, 3, true, { user: { id: 1 }, password: 'right', client });
  assert.deepEqual(created, ['laptop']);
  assert.deepEqual(toggled, [false, true]);
  assert.deepEqual(stepUps, ['guess', 'guess', 'right', 'right']);
});

test('re-registering an existing push subscription only stores it, without switching Web Push on', () => {
  const operations: string[] = [];
  const service = createSettingsService(dependencies({
    pushSubscriptions: {
      save: (_id, endpoint) => operations.push(`save:${endpoint}`),
      remove: () => undefined,
    },
    notifications: {
      getPreferences: () => ({ channels: { webPush: false } }),
      updatePreferences: () => { operations.push('preferences'); return {}; },
      createEnabledEvent: () => ({ code: 'push.enabled' }),
      notifyUser: () => { operations.push('notify'); },
    },
  }));
  const input = { endpoint: 'https://push.example.test', keys: { p256dh: 'key', auth: 'auth' }, resubscribe: true };
  service.subscribeToPush(1, input);
  service.subscribeToPush(1, input);
  assert.deepEqual(operations, ['save:https://push.example.test', 'save:https://push.example.test']);
});

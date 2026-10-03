import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  notificationPreferencesDb,
  projectsDb,
  pushSubscriptionsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';

import {
  buildNotificationPayload,
  sendStudioPushNotification,
} from '../services/notification-orchestrator.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'notification-orchestrator-'));
  const databasePath = path.join(temporaryDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('notification payload uses the app session id for a provider session id', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session-1', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-session-1', 'claude-native-1');

    const payload = buildNotificationPayload({
      provider: 'claude',
      sessionId: 'claude-native-1',
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason: 'completed' },
    });

    assert.equal(payload.data.sessionId, 'app-session-1');
    assert.match(payload.data.tag, /app-session-1/);
  });
});

test('a tap on an agent-run notification opens the session in its project workbench', async () => {
  await withIsolatedDatabase(() => {
    const { project } = projectsDb.createProjectPath('/workspace/demo');
    assert.ok(project);
    sessionsDb.createAppSession('app-session-2', 'codex', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-session-2', 'codex-native-2');

    const stopped = buildNotificationPayload({ provider: 'codex', sessionId: 'codex-native-2', kind: 'stop', code: 'run.stopped', meta: {} });
    assert.equal(stopped.data.url, `/work/${encodeURIComponent(project.project_id)}/s/app-session-2`);

    // A session whose project the server does not know keeps the old address, which the app resolves.
    const orphan = buildNotificationPayload({ provider: 'claude', sessionId: 'not-indexed', kind: 'error', code: 'run.failed', meta: { error: 'x' } });
    assert.equal(orphan.data.url, '/session/not-indexed');

    // Nothing to open (the "push enabled" test notification): the home screen.
    const enabled = buildNotificationPayload({ provider: 'system', sessionId: null, kind: 'info', code: 'push.enabled', meta: {} });
    assert.equal(enabled.data.url, '/');
  });
});

test('a Studio push carries its page, and anything but a same-origin path falls back to the home screen', async () => {
  await withIsolatedDatabase(async () => {
    const userId = Number(userDb.createUser('owner', 'hash').id);
    notificationPreferencesDb.updatePreferences(userId, { channels: { webPush: true }, events: {} });
    pushSubscriptionsDb.saveSubscription(userId, 'https://push.example.test/device-1', 'p256dh', 'auth');
    // web-push ships no declarations; the orchestrator calls the module's shared sender, swapped here for a recorder.
    const webPushSpecifier = 'web-push';
    const webPush = ((await import(webPushSpecifier)) as { default: { sendNotification: (subscription: unknown, payload: string) => Promise<unknown> } }).default;
    const sent: { data: { url: string; tag: string } }[] = [];
    const original = webPush.sendNotification;
    webPush.sendNotification = async (_subscription, payload) => {
      sent.push(JSON.parse(payload));
      return { statusCode: 201, body: '', headers: {} };
    };
    try {
      const send = (url: unknown) => sendStudioPushNotification(userId, { title: 't', body: 'b', tag: 'automation:a1', url: url as string });
      assert.deepEqual(await send('/projects/prof?tab=automations'), { enabled: true, devices: 1, delivered: 1 });
      await send('/projects/prof');
      await send('https://evil.example/phish');
      await send('//evil.example/phish');
      await send('/\\evil.example');
      await send('javascript:alert(1)');
      await send(42);
      assert.deepEqual(sent.map(payload => payload.data.url), ['/projects/prof?tab=automations', '/projects/prof', '/', '/', '/', '/', '/']);
      assert.equal(sent[0].data.tag, 'automation:a1');
    } finally {
      webPush.sendNotification = original;
    }
  });
});

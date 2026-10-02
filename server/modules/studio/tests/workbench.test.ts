import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import { createWorkbenchService } from '../workbench.service.js';
import { createWorkbenchRouter } from '../workbench.routes.js';

const PROJECTS = [
  { id: 'professor', workspacePath: '/home/me/projects/professor', remoteHost: '' },
  { id: 'snr', workspacePath: '/home/me/projects/snr3-lab', remoteHost: '' },
  // Agents on an SSH host have no local directory to look up.
  { id: 'aj', workspacePath: '/srv/app', remoteHost: 'aj' },
  // A project without a directory has nothing to open in the workbench.
  { id: 'mail-only', workspacePath: '', remoteHost: '' },
  { id: 'gone', workspacePath: '/home/me/projects/deleted', remoteHost: '' },
];

function fixture() {
  const lookups: string[] = [];
  const service = createWorkbenchService({
    listHubProjects: userId => (userId === 1 ? PROJECTS : []),
    findProjectId(directory) {
      lookups.push(directory);
      if (directory.endsWith('deleted')) throw new Error('ENOENT');
      return directory.endsWith('professor') ? 'native-professor' : null;
    },
  });
  return { service, lookups };
}

test('hub links map local projects to their IDE project and never fail the list for one bad directory', () => {
  const { service, lookups } = fixture();
  assert.deepEqual(service.hubLinks(1), [
    { hubId: 'professor', projectId: 'native-professor' },
    { hubId: 'snr', projectId: null },
    { hubId: 'gone', projectId: null },
  ]);
  assert.deepEqual(lookups, ['/home/me/projects/professor', '/home/me/projects/snr3-lab', '/home/me/projects/deleted']);
  assert.deepEqual(service.hubLinks(2), []);
});

test('the hub-links route answers only for a signed-in user', async () => {
  const { service } = fixture();
  const app = express();
  app.use((req, _res, next) => {
    const id = Number(req.get('x-test-user'));
    if (id) (req as express.Request & { user?: { id: number } }).user = { id };
    next();
  });
  app.use('/workbench', createWorkbenchRouter(service));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : 'error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/workbench/hub-links`;
    const signedIn = await fetch(base, { headers: { 'x-test-user': '1' } });
    assert.equal(signedIn.status, 200);
    assert.equal(((await signedIn.json()) as unknown[]).length, 3);
    const anonymous = await fetch(base);
    assert.equal(anonymous.status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

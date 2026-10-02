import assert from 'node:assert/strict';
import type { ExecFileException } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import { createRemoteHostsService } from '../remote-hosts.service.js';
import { createRemoteHostsRouter } from '../remote-hosts.routes.js';

test('remote routes list hosts without directories and check only configured hosts', async () => {
  const probes: string[][] = [];
  const service = createRemoteHostsService({
    hostsConfig: JSON.stringify([{ name: 'aj', label: 'AJ 服务器', target: 'sp-remote', dir: '~/projects/super-professor' }]),
    execFile: (_file: string, args: string[], _options: unknown, done: (error: ExecFileException | null, stdout: string, stderr: string) => void) => {
      probes.push(args);
      done(null, 'claude=0\ncodex=1\ntmux=0\n', '');
    },
  });
  const app = express();
  app.use('/remote', createRemoteHostsRouter(service));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : 'error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/remote`;
  try {
    const hosts = await fetch(`${origin}/hosts`);
    assert.equal(hosts.status, 200);
    assert.equal(hosts.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await hosts.json(), [{ name: 'aj', label: 'AJ 服务器', target: 'sp-remote' }]);

    const status = await fetch(`${origin}/hosts/aj/status`);
    assert.equal(status.status, 200);
    const body = await status.json() as { name: string; online: boolean; tools: Record<string, boolean> };
    assert.equal(body.name, 'aj');
    assert.equal(body.online, true);
    assert.deepEqual(body.tools, { claude: false, codex: true, tmux: false });

    for (const name of ['nope', 'sp-remote', 'AJ', encodeURIComponent('aj;id'), encodeURIComponent('-oProxyCommand=x')]) {
      const unknown = await fetch(`${origin}/hosts/${name}/status`);
      assert.equal(unknown.status, 404, name);
    }
    assert.equal(probes.length, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

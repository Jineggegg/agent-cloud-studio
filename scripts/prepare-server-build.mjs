import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuildInfo } from './build-info.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const staging = path.join(root, 'dist-server.next');
// Freeze identity before compilation; postbuild must never relabel compiled
// files with a later checkout. The existing promotion checks the entrypoint.
const buildInfo = createBuildInfo(root);
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
fs.writeFileSync(path.join(staging, 'build-info.json'), JSON.stringify(buildInfo, null, 2) + '\n');

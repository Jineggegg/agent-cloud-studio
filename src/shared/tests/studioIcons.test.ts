import { beforeAll, expect, test } from 'vitest';

/*
 * Every icon the browser, iOS and the PWA manifest load is the Studio's current logo (public/studio-icon.svg and the
 * PNGs scripts/generate-studio-icons.mjs renders from it), and each URL carries the logo's version, so a browser or
 * iOS that cached an older icon (the cloud) fetches the current one.
 */

type NodeApis = {
  readFileSync: (path: string, encoding: 'utf8') => string;
  existsSync: (path: string) => boolean;
  createHash: (algorithm: string) => { update: (data: string) => { digest: (encoding: 'hex') => string } };
};

let read: (path: string) => string = () => '';
let exists: (path: string) => boolean = () => false;
let logoVersion = '';
beforeAll(async () => {
  // The frontend program has no Node types, so Node modules are loaded through specifiers TypeScript does not resolve.
  const [fsModule, cryptoModule] = ['node:fs', 'node:crypto'];
  const { readFileSync, existsSync } = (await import(/* @vite-ignore */ fsModule)) as Pick<NodeApis, 'readFileSync' | 'existsSync'>;
  const { createHash } = (await import(/* @vite-ignore */ cryptoModule)) as Pick<NodeApis, 'createHash'>;
  const testsDir = decodeURIComponent(import.meta.url.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1')).replace(/\/[^/]*$/, '');
  const root = `${testsDir}/../../..`;
  read = path => readFileSync(`${root}/${path}`, 'utf8');
  exists = path => existsSync(`${root}/${path}`);
  logoVersion = createHash('sha256').update(read('public/studio-icon.svg')).digest('hex').slice(0, 8);
});

// A versioned icon URL: the file under public/ it names, and its version.
function parse(url: string) {
  const match = /^(\/[^?]+)\?v=([\w-]+)$/.exec(url);
  if (!match) throw new Error(`${url} carries no ?v=`);
  return { file: `public${match[1]}`, version: match[2] };
}

test('the logo is the four-pointed spark of the launch animation, not the old cloud', () => {
  const logo = read('public/studio-icon.svg');
  expect(logo).toContain('M50 16 C53 40 60 47 84 50');
  expect(logo).not.toContain('M165 345h178');
});

test('the tab icon and the apple-touch-icons name the current logo, each with its version', () => {
  const page = new DOMParser().parseFromString(read('index.html'), 'text/html');
  const icon = page.querySelector('link[rel="icon"]')?.getAttribute('href') ?? '';
  expect(parse(icon)).toEqual({ file: 'public/studio-icon.svg', version: logoVersion });
  const touchIcons = Array.from(page.querySelectorAll('link[rel="apple-touch-icon"]'), link => link.getAttribute('href') ?? '');
  expect(touchIcons.length).toBeGreaterThan(0);
  for (const url of touchIcons) {
    const { file, version } = parse(url);
    expect(file).toMatch(/^public\/icons\/studio-apple-\d+\.png$/);
    expect(version).toBe(logoVersion);
    expect(exists(file)).toBe(true);
  }
});

test('the manifest lists the current logo, as any and as maskable, each with its version', () => {
  const manifest = JSON.parse(read('public/manifest.json')) as { icons: Array<{ src: string; purpose: string }> };
  expect(new Set(manifest.icons.map(icon => icon.purpose))).toEqual(new Set(['any', 'maskable']));
  for (const icon of manifest.icons) {
    const { file, version } = parse(icon.src);
    expect(file).toMatch(icon.purpose === 'maskable' ? /^public\/icons\/studio-maskable-\d+\.png$/ : /^public\/icons\/studio-\d+\.png$/);
    expect(version).toBe(logoVersion);
    expect(exists(file)).toBe(true);
  }
});

test('notifications show the current logo too', () => {
  const worker = read('public/sw.js');
  const urls = Array.from(worker.matchAll(/(?:icon|badge): '([^']+)'/g), match => match[1]);
  expect(urls).toHaveLength(2);
  for (const url of urls) expect(parse(url).version).toBe(logoVersion);
});

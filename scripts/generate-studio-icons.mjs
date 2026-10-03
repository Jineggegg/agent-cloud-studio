// Renders every PNG of the Studio's logo from its one source, public/studio-icon.svg (the four-pointed spark the
// launch animation draws, and the browser tab's icon): the manifest's icons, a maskable set with the safe-zone margin
// Android crops into, and the opaque, full-bleed apple-touch-icons iOS wants. It then stamps a version (a hash of the
// SVG) on every URL that names those files (index.html, the manifest, the service worker's notifications), so
// browsers and iOS, which cache icons hard, pick up a changed logo. Run with `node scripts/generate-studio-icons.mjs`
// after changing the SVG.
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const repoFile = path => fileURLToPath(new URL(`../${path}`, import.meta.url));
const source = await fs.readFile(repoFile('public/studio-icon.svg'), 'utf8');

// The artwork is a rounded tile (the first <rect>) with the drawing on top; <defs> hold the tile's gradient.
const tile = /<rect\b[^>]*\/>/.exec(source);
const tileFill = tile && /fill="([^"]+)"/.exec(tile[0])?.[1];
const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(source);
if (!tile || !tileFill || !viewBox || viewBox[1] !== viewBox[2]) throw new Error('studio-icon.svg: expected a square viewBox and a filled <rect> tile');
const size = Number(viewBox[1]);
const inner = source.slice(source.indexOf('>', source.indexOf('<svg')) + 1, source.lastIndexOf('</svg>'));
const defs = /<defs>[\s\S]*?<\/defs>/.exec(inner)?.[0] ?? '';
const drawing = inner.replace(defs, '').replace(tile[0], '');
// What fills any transparent edge when a PNG must be opaque: the tile's colour, or its gradient's first stop.
const opaqueBackground = tileFill.startsWith('url(') ? /stop-color="([^"]+)"/.exec(defs)?.[1] ?? '#000000' : tileFill;

// A full-bleed square of the tile's fill with the drawing scaled about the centre (the platform rounds or masks it).
const fullBleed = scale => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${defs}
  <rect width="${size}" height="${size}" fill="${tileFill}"/>
  <g transform="translate(${size / 2} ${size / 2}) scale(${scale}) translate(${-size / 2} ${-size / 2})">${drawing}</g>
</svg>`;

async function render(svg, px, path, { opaque = false } = {}) {
  let image = sharp(Buffer.from(svg), { density: Math.max(72, ((72 * px) / size) * 2) }).resize(px, px);
  if (opaque) image = image.flatten({ background: opaqueBackground }).removeAlpha();
  await image.png().toFile(repoFile(`public/${path}`));
}

// "any": the rounded tile as drawn.
for (const px of [72, 96, 128, 144, 152, 192, 384, 512]) await render(source, px, `icons/studio-${px}.png`);
// "maskable": the drawing kept inside the central 80 % safe zone, on a tile that fills the whole square.
for (const px of [192, 512]) await render(fullBleed(0.8), px, `icons/studio-maskable-${px}.png`);
// apple-touch-icon: opaque and full-bleed, as iOS rounds the corners itself (iPhone 180, iPad Pro 167, iPad 152).
for (const px of [152, 167, 180]) await render(fullBleed(1), px, `icons/studio-apple-${px}.png`, { opaque: true });

// Stamp the version on every quoted URL of these files ("/studio-icon.svg", "/icons/studio-*.png"), with or without
// an older `?v=`; prose that only names a file is left alone.
const version = createHash('sha256').update(source).digest('hex').slice(0, 8);
const iconUrl = /(["'])(\/(?:studio-icon\.svg|icons\/studio-[\w-]+\.png))(?:\?v=[\w-]+)?(?=["'])/g;
for (const path of ['index.html', 'public/manifest.json', 'public/sw.js']) {
  const text = await fs.readFile(repoFile(path), 'utf8');
  await fs.writeFile(repoFile(path), text.replace(iconUrl, `$1$2?v=${version}`));
}
console.log(`Studio icons generated (v=${version}).`);

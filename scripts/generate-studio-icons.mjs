import sharp from 'sharp';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = new URL('../public/studio-icon.svg', import.meta.url);
const sizes = [72, 96, 128, 144, 152, 192, 384, 512];
for (const size of sizes) {
  await sharp(await fs.readFile(source)).resize(size, size).png()
    .toFile(fileURLToPath(new URL(`../public/icons/studio-${size}.png`, import.meta.url)));
}
console.log('Studio icons generated.');

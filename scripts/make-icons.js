// Generates all icon sizes from public/icon-raw.png.
// Run: node scripts/make-icons.js
import sharp from 'sharp';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pub = join(__dirname, '..', 'public');

async function makeRounded(size) {
  const radius = Math.round(size * 0.22);
  // 4 % padding on each side so the brain has breathing room inside the square
  const pad    = Math.round(size * 0.04);
  const inner  = size - pad * 2;

  const mask = Buffer.from(
    `<svg width="${size}" height="${size}">
       <rect x="0" y="0" width="${size}" height="${size}"
             rx="${radius}" ry="${radius}" fill="white"/>
     </svg>`
  );

  // 1. Resize the raw capture to the padded inner size
  const resized = await sharp(`${pub}/icon-raw.png`)
    .resize(inner, inner, { fit: 'cover', position: 'centre' })
    .toBuffer();

  // 2. Place it on a #05070F background with padding
  const padded = await sharp({
    create: { width: size, height: size, channels: 4,
              background: { r: 5, g: 7, b: 15, alpha: 1 } },
  })
    .composite([{ input: resized, top: pad, left: pad }])
    .png()
    .toBuffer();

  // 3. Clip to rounded rectangle (corners become transparent)
  return sharp(padded)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

const buf1024 = await makeRounded(1024);
await sharp(buf1024).toFile(`${pub}/icon-1024.png`);
console.log('icon-1024.png');

await sharp(buf1024).resize(512, 512).toFile(`${pub}/icon-512.png`);
console.log('icon-512.png');

await sharp(buf1024).resize(180, 180).toFile(`${pub}/apple-touch-icon.png`);
console.log('apple-touch-icon.png');

await sharp(buf1024).resize(64, 64).toFile(`${pub}/favicon.png`);
console.log('favicon.png');

console.log('Done.');

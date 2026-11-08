// Rebuild the checked-in Windows/macOS icons from the generated PNG master.
// Uses macOS's image tools; consumers/builds on Windows use the exported assets.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('Rebuilding icons uses macOS sips/iconutil. Prebuilt PNG, ICO and ICNS assets are included for other platforms.');
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/assets');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aftershelf-icons-'));
try {
  for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
    execFileSync('sips', ['-z', String(size), String(size), path.join(directory, 'aftershelf-master.png'), '--out', path.join(directory, `aftershelf-${size}.png`)], { stdio: 'ignore' });
  }
  const sizes = [16, 32, 48, 64, 128, 256], images = await Promise.all(sizes.map(size => fs.readFile(path.join(directory, `aftershelf-${size}.png`))));
  const header = Buffer.alloc(6 + sizes.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size; header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[index].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  });
  await fs.writeFile(path.join(directory, 'aftershelf.ico'), Buffer.concat([header, ...images]));
  const iconset = path.join(temporary, 'AfterShelf.iconset'); await fs.mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    await fs.copyFile(path.join(directory, `aftershelf-${size}.png`), path.join(iconset, `icon_${size}x${size}.png`));
    await fs.copyFile(path.join(directory, `aftershelf-${size * 2}.png`), path.join(iconset, `icon_${size}x${size}@2x.png`));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(directory, 'aftershelf.icns')], { stdio: 'inherit' });
  console.log('AfterShelf PNG sizes, multi-resolution ICO and macOS ICNS exported.');
} finally { await fs.rm(temporary, { recursive: true, force: true }); }

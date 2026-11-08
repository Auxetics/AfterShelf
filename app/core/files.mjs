import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

export function isInside(root, target, allowRoot = false) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return (allowRoot || rel !== '') && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}
export function archivePath(root, name) {
  if (!name || /[\x00-\x1f]/.test(name) || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error('Archive contains an unsafe path.');
  const parts = name.split('/');
  if (parts.some(part => part === '..' || part === '.' || part.includes(':') || /[. ]$/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part))) throw new Error('Archive contains an unsafe path.');
  const result = path.resolve(root, ...parts);
  if (!isInside(root, result)) throw new Error('Archive path escapes its extraction directory.');
  return result;
}
export function safeName(value) { return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 100) || 'game'; }
export async function exists(file) { try { await fs.access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
export async function realDirectory(value) { const real = await fs.realpath(value); if (!(await fs.stat(real)).isDirectory()) throw new Error('Select a folder.'); return real; }
export async function assertNoLinks(root, target) {
  if (!isInside(root, target, true)) throw new Error('Path is outside the selected folder.');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Symbolic links are not followed during save transfer or deletion.'); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
  }
}
export async function walk(root, { max = 20000, depth = 12 } = {}) {
  const results = [];
  async function visit(dir, level) {
    if (results.length >= max) throw new Error('Folder scan limit reached. Choose a more specific game folder.');
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      if (item.name === '.DS_Store' || item.name === 'node_modules' || item.name === '.git') continue;
      const absolute = path.join(dir, item.name), relative = path.relative(root, absolute).split(path.sep).join('/');
      if (item.isSymbolicLink()) continue;
      results.push({ absolute, relative, directory: item.isDirectory() });
      if (item.isDirectory() && level < depth) await visit(absolute, level + 1);
    }
  }
  await visit(root, 0);
  return results;
}
export async function readSmall(file, max = 512000) { try { if ((await fs.stat(file)).size > max) return ''; return await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } }
export async function digest(file) { const hash = createHash('sha256'); const handle = await fs.open(file); try { for await (const chunk of handle.createReadStream()) hash.update(chunk); return hash.digest('hex'); } finally { await handle.close(); } }
export async function copyVerified(source, dest, signal) {
  signal?.throwIfAborted();
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Only regular save/preference files can be transferred.');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(source, dest);
  signal?.throwIfAborted();
  if (await digest(source) !== await digest(dest)) throw new Error('Save transfer verification failed. The original installation is unchanged.');
}

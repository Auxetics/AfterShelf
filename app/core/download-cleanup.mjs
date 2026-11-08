import fs from 'node:fs/promises';
import { assertNoLinks, isInside } from './files.mjs';

export async function removePartialDownload(job, { gamesRoot, games = [], downloads = [] }) {
  if (!['failed', 'cancelled'].includes(job.status) || !job.managedDownload || job.partialRemoved || !job.path) return false;
  if (!gamesRoot || !isInside(gamesRoot, job.path)) throw new Error('Partial download is outside the selected games folder; it was not removed.');
  if (downloads.some(other => other.id !== job.id && other.path === job.path && ['downloaded', 'installed'].includes(other.status))) throw new Error('Another completed download uses this file; it was not removed.');
  if (games.some(game => [game.installation, ...(game.previous || [])].some(install => install?.root && isInside(install.root, job.path, true)))) throw new Error('Partial file is inside an installed game; it was not removed.');
  // An offline volume is not proof that a file was deleted.
  await fs.access(gamesRoot);
  await assertNoLinks(gamesRoot, job.path);
  try {
    const stat = await fs.lstat(job.path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Only the incomplete downloaded file can be removed.');
    await fs.unlink(job.path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return true;
}

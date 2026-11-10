import fs from 'node:fs/promises';
import path from 'node:path';
import { isInside } from './files.mjs';
import { normalizedTitle } from './model.mjs';
import { archiveTitle } from './archive-names.mjs';

function collectionName(value) {
  return normalizedTitle(archiveTitle(value).replace(/\.app$/i, '')
    .replace(/(?:^|[\s._-])v?\d+(?:\.\d+)+(?:[a-z]\d*)?(?=$|[\s._-])/gi, ' ')
    .replace(/(?:^|[\s._-])(?:macos|mac|osx|windows|win64|win32|win|linux|x64|x86|arm64|pc)(?=$|[\s._-])/gi, ' '));
}
// A name match only hides redundant archive suggestions. It never merges games,
// changes source identity, deletes files, or marks a download installed.
export function archiveMatchesInstalled(filename, games) {
  const name = collectionName(filename);
  return Boolean(name && games.some(game => game.installation && game.availability?.status !== 'missing' && [game.title, game.localMetadata?.title, path.basename(game.installation.root || '')].some(value => value && collectionName(value) === name)));
}

export async function inspectLibraryPresence(games, gamesRoot, { signal, now = Date.now } = {}) {
  const roots = Array.isArray(gamesRoot) ? gamesRoot : [gamesRoot];
  const unavailable = new Map();
  for (const folder of roots) {
    try { if (!(await fs.stat(folder)).isDirectory()) throw new Error('The games folder is not a directory.'); }
    catch (error) { unavailable.set(folder, error.code || error.message); }
  }
  const rootAvailable = !unavailable.has(roots[0]), rootError = unavailable.get(roots[0]) || '';
  const updates = [];
  for (const game of games) {
    signal?.throwIfAborted();
    if (!game.installation) continue;
    const { root, launch } = game.installation;
    let status = 'available', reason = '';
    const offlineRoot = [...unavailable.keys()].find(folder => isInside(folder, root, true));
    if (offlineRoot) {
      status = 'offline'; reason = `Games folder is unavailable (${unavailable.get(offlineRoot)}).`;
    } else {
      try {
        if (!(await fs.stat(root)).isDirectory()) { status = 'missing'; reason = 'The installed game folder is no longer present.'; }
        else if (launch) await fs.access(launch);
      } catch (error) {
        status = ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unreadable';
        reason = status === 'missing' ? 'The game folder or launcher was moved or removed.' : `The game files could not be read (${error.code || 'access error'}).`;
      }
    }
    updates.push({ id: game.id, root, launch, availability: { status, reason, checkedAt: now() } });
  }
  return { rootAvailable, rootError, updates, unavailable };
}

export function applyLibraryPresence(state, result) {
  for (const update of result.updates) {
    const game = state.games.find(game => game.id === update.id);
    // Do not overwrite a new installation committed while the scan was running.
    if (game?.installation?.root === update.root && game.installation.launch === update.launch) game.availability = update.availability;
  }
}

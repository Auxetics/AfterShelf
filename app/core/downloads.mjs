import { randomUUID } from 'node:crypto';
import { ENGINES, newGame, ACTIVE_DOWNLOADS } from './model.mjs';
import { sourceThreadReference, gameMatchesThread, sameThread } from './sources.mjs';
import { applyForumMetadata } from './metadata.mjs';

// Resolve by stable thread identity, never by a similar title or archive name.
// A library entry without an installation is a first install, not an update.
export function ensureDownloadGame(state, { gameId, thread, create } = {}) {
  let ref;
  const supplied = create || thread;
  if (supplied?.threadUrl) ref = sourceThreadReference(state.settings, supplied.threadUrl);
  let game = state.games.find(item => item.id === gameId && (!ref || gameMatchesThread(item, ref)));
  if (game) return game;
  if (ref) {
    game = state.games.find(item => gameMatchesThread(item, ref));
    if (game) return game;
  }
  if (!ref && !create) return null;
  const title = String(supplied?.title || (ref ? `Thread ${ref.threadId}` : '')).trim().slice(0, 200);
  if (!title) throw new Error('Enter a title for the new game.');
  const engine = ENGINES.some(([id]) => id === supplied?.engine) ? supplied.engine : 'custom';
  game = newGame({ ...(ref || { id: `download:${randomUUID()}`, origin: state.settings.site.origin, threadId: '', threadUrl: '' }), title, engine,
    latestVersion: String(supplied?.latestVersion || supplied?.version || '').trim().slice(0, 100) });
  state.games.unshift(game);
  return game;
}

// Only installation completion adopts an explicitly assigned download's source.
// Downloading, failing or cancelling never changes an existing game's source.
export function applyDownloadSource(state, gameId, job) {
  const game = state.games.find(item => item.id === gameId);
  if (!game) throw new Error('This game no longer exists.');
  if (!job.thread?.threadUrl) return game;
  const ref = sourceThreadReference(state.settings, job.thread.threadUrl);
  if (sameThread(game.alternateThread, ref)) return game;
  const changed = ref.origin !== game.origin || ref.threadId !== game.threadId;
  return applyForumMetadata(state, gameId, { ...job.thread, ...ref, ...(changed ? { latestVersion: job.version || job.thread.latestVersion || '' } : job.version ? { latestVersion: job.version } : {}) });
}

export function assignDownloadGame(state, input) {
  const job = state.downloads.find(job => job.id === input.id);
  if (!job) throw new Error('Download no longer exists.');
  if (ACTIVE_DOWNLOADS.includes(job.status) || ['installing', 'installed'].includes(job.status)) throw new Error('Finish the download before changing its game.');
  if (!input.create && !state.games.some(game => game.id === input.gameId)) throw new Error('Choose an existing library game.');
  const ref = job.thread?.threadUrl ? sourceThreadReference(state.settings, job.thread.threadUrl) : null;
  const version = String(input.version || '').trim();
  const game = ensureDownloadGame(state, input.create ? { create: { ...job.thread, ...input.create, threadUrl: String(input.create.threadUrl || '').trim() || job.thread?.threadUrl, version } } : { gameId: input.gameId });
  // The other site's cached release is not evidence of this archive's version.
  const fallback = !ref || ref.origin === game.origin && ref.threadId === game.threadId ? game.latestVersion : job.thread.latestVersion || '';
  Object.assign(job, { gameId: game.id, version: version || job.version || fallback });
  return game;
}

export function importArchive(state, candidate) {
  let job = state.downloads.find(item => item.id === candidate.downloadId || item.path === candidate.path && !item.archiveRemoved);
  if (job && !['downloaded', 'awaiting-folder'].includes(job.status)) throw new Error('This archive has not completed downloading or is already installed.');
  if (job && state.games.some(game => game.id === job.gameId)) return { job, added: false };
  const game = ensureDownloadGame(state, { create: { ...job?.thread, title: job?.thread?.title || candidate.title, engine: job?.thread?.engine || candidate.engine } });
  if (job) job.gameId = game.id;
  else {
    job = { id: randomUUID(), gameId: game.id, filename: candidate.filename, path: candidate.path, status: 'downloaded', at: Date.now(), version: '', total: candidate.size, received: candidate.size, error: '', archiveRemoved: false };
    state.downloads.unshift(job);
  }
  return { job, added: true };
}
export function dismissDownloads(state, ids) {
  const selected = new Set(ids);
  if (state.downloads.some(job => selected.has(job.id) && ['queued', 'downloading', 'retrying', 'installing'].includes(job.status))) throw new Error('Cancel or finish active downloads and installations before removing them.');
  const count = state.downloads.filter(job => selected.has(job.id)).length;
  state.downloads = state.downloads.filter(job => !selected.has(job.id));
  return count;
}

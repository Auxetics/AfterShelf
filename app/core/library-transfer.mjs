import { ENGINES, PLAY_STATUSES, newGame } from './model.mjs';
import { sameThread, sourceThreadReference } from './sources.mjs';

export function exportLibraryPayload(state) {
  const games = (state.games || []).map(game => ({
    id: game.id,
    origin: game.origin || '',
    threadId: game.threadId || '',
    threadUrl: game.threadUrl || '',
    alternateThread: game.alternateThread || null,
    title: game.title || '',
    engine: game.engine || 'custom',
    latestVersion: game.latestVersion || '',
    installedVersion: game.installedVersion || '',
    creator: game.creator || '',
    description: game.description || '',
    tags: Array.isArray(game.tags) ? game.tags : [],
    archivePassword: game.archivePassword || '',
    notes: game.notes || '',
    playStatus: game.playStatus || 'backlog',
    favorite: Boolean(game.favorite),
    watching: Boolean(game.watching),
    skippedUpdate: game.skippedUpdate || null,
    releases: Array.isArray(game.releases) ? game.releases : [],
    playtimeMs: Number(game.playtimeMs) || 0,
    lastPlayedAt: game.lastPlayedAt || null,
    lastLaunchedAt: game.lastLaunchedAt || null,
    versionPlaytime: Array.isArray(game.versionPlaytime) ? game.versionPlaytime : [],
    addedAt: game.addedAt || Date.now()
  }));
  return {
    format: 'aftershelf-library',
    version: 1,
    exportedAt: Date.now(),
    games
  };
}

export function importLibraryPayload(state, payload) {
  if (!payload || typeof payload !== 'object' || payload.format !== 'aftershelf-library' || !Array.isArray(payload.games)) {
    throw new Error('This file is not a valid AfterShelf library export.');
  }
  if (payload.games.length > 5000) throw new Error('This library export contains too many entries.');
  let added = 0, updated = 0;
  for (const raw of payload.games) {
    if (!raw || typeof raw !== 'object') continue;
    const title = String(raw.title || '').trim().slice(0, 200);
    if (!title) continue;
    let ref = null;
    if (typeof raw.threadUrl === 'string' && raw.threadUrl.trim()) {
      try { ref = sourceThreadReference(state.settings, raw.threadUrl.trim()); } catch {}
    }
    let alternateThread = null;
    if (raw.alternateThread?.threadUrl) {
      try {
        const alt = sourceThreadReference(state.settings, String(raw.alternateThread.threadUrl).trim());
        if (!ref || alt.origin !== ref.origin) alternateThread = alt;
      } catch {}
    }
    const engine = ENGINES.some(([id]) => id === raw.engine) ? raw.engine : 'custom';
    const playStatus = PLAY_STATUSES.some(([id]) => id === raw.playStatus) ? raw.playStatus : 'backlog';
    const existing = state.games.find(game => (ref && sameThread(game, ref)) || (typeof raw.id === 'string' && game.id === raw.id));
    if (existing) {
      if (ref && !existing.threadId) Object.assign(existing, ref);
      if (alternateThread && !existing.alternateThread) existing.alternateThread = alternateThread;
      if (!existing.creator && typeof raw.creator === 'string') existing.creator = raw.creator.slice(0, 200);
      if (!existing.description && typeof raw.description === 'string') existing.description = raw.description.slice(0, 400);
      if (!existing.archivePassword && typeof raw.archivePassword === 'string') existing.archivePassword = raw.archivePassword.slice(0, 120);
      if (!existing.notes && typeof raw.notes === 'string') existing.notes = raw.notes.slice(0, 4000);
      if (Array.isArray(raw.tags) && raw.tags.length) {
        const mergedTags = [...new Set([...(Array.isArray(existing.tags) ? existing.tags : []), ...raw.tags.filter(t => typeof t === 'string').map(t => t.slice(0, 60))])];
        existing.tags = mergedTags.slice(0, 50);
      }
      if (!existing.latestVersion && typeof raw.latestVersion === 'string') existing.latestVersion = raw.latestVersion.slice(0, 100);
      if (raw.favorite) existing.favorite = true;
      if (raw.watching && existing.threadUrl) existing.watching = true;
      if ((Number(raw.playtimeMs) || 0) > (existing.playtimeMs || 0)) existing.playtimeMs = Number(raw.playtimeMs);
      updated++;
      continue;
    }
    const base = ref || {
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 120) : `local:${Date.now()}-${added}`,
      origin: state.settings.site.origin,
      threadId: '',
      threadUrl: ''
    };
    const created = newGame({
      ...base,
      alternateThread,
      title,
      engine,
      latestVersion: typeof raw.latestVersion === 'string' ? raw.latestVersion.slice(0, 100) : '',
      creator: typeof raw.creator === 'string' ? raw.creator.slice(0, 200) : '',
      description: typeof raw.description === 'string' ? raw.description.slice(0, 400) : '',
      tags: Array.isArray(raw.tags) ? raw.tags.filter(t => typeof t === 'string').map(t => t.slice(0, 60)).slice(0, 50) : [],
      archivePassword: typeof raw.archivePassword === 'string' ? raw.archivePassword.slice(0, 120) : '',
      notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 4000) : '',
      playStatus,
      favorite: Boolean(raw.favorite),
      watching: Boolean(raw.watching && ref),
      releases: Array.isArray(raw.releases) ? raw.releases.slice(0, 120) : [],
      playtimeMs: Math.max(0, Number(raw.playtimeMs) || 0),
      lastPlayedAt: Number.isFinite(raw.lastPlayedAt) ? raw.lastPlayedAt : null,
      lastLaunchedAt: Number.isFinite(raw.lastLaunchedAt) ? raw.lastLaunchedAt : null,
      versionPlaytime: Array.isArray(raw.versionPlaytime) ? raw.versionPlaytime.slice(0, 50) : [],
      addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : Date.now()
    });
    state.games.push(created);
    added++;
  }
  return { added, updated };
}

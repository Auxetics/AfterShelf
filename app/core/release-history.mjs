import { versionKnown, versionRelation } from './model.mjs';

export function recordForumRelease(game, metadata, now = Date.now()) {
  const { origin, threadId, latestVersion: version } = metadata;
  if (!origin || !threadId || !versionKnown(version)) return null;
  game.releases ||= [];
  const existing = game.releases.find(row => row.origin === origin && String(row.threadId) === String(threadId) && versionRelation(row.version, version) === 'same');
  const notes = typeof metadata.changelog === 'string' ? metadata.changelog.trim().slice(0, 1800) : '';
  if (existing) {
    if (notes) existing.notes = notes;
    return null;
  }
  const row = { origin, threadId, version, firstSeen: now, notes };
  game.releases.unshift(row);
  game.releases.length = Math.min(game.releases.length, 120);
  return row;
}

export function rememberWatchedRelease(game, release, now) {
  game.watchNotices ||= [];
  game.watchNotices.unshift({ origin: release.origin, threadId: release.threadId, version: release.version, at: now });
}

export function previouslyNotified(game, release) {
  return game.watchNotices?.some(notice => notice.origin === release.origin && String(notice.threadId) === String(release.threadId) &&
    versionRelation(notice.version, release.version) === 'same');
}

export function recordHtmlSession(game, { at, duration, version }) {
  if (!(duration > 0)) return;
  game.playSessions ||= [];
  game.playSessions.unshift({ at, duration, version });
  game.playSessions.length = Math.min(game.playSessions.length, 150);
  game.lastPlayedAt = Math.max(game.lastPlayedAt || 0, at + duration);
  game.playtimeMs = (game.playtimeMs || 0) + duration;
  game.versionPlaytime ||= [];
  const row = game.versionPlaytime.find(item => item.version === version || versionRelation(item.version, version) === 'same');
  if (row) row.duration += duration;
  else game.versionPlaytime.unshift({ version, duration });
}

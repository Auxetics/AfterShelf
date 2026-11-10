import path from 'node:path';
import { versionRelation, isInstalled, updateSkipped } from './model.mjs';

export const APP_NAME = 'AfterShelf';

// Reuse the whole existing profile, including Chromium's forum session. Do not
// move just library.json and strand its cookies, storage or preferences.
export function profileDirectory(appData, exists, env = process.env) {
  const override = env.AFTERSHELF_DATA || env.LC_LIBRARY_DATA;
  if (override) return path.resolve(override);
  const legacy = path.join(appData, 'LC Library');
  return exists(legacy) ? legacy : path.join(appData, APP_NAME);
}

export function availableUpdateCount(games) {
  return games.filter(game => isInstalled(game) && game.threadId && game.threadUrl && !updateSkipped(game) && versionRelation(game.installedVersion, game.latestVersion) === 'newer').length;
}

export function syncDockBadge(app, games, platform = process.platform) {
  const count = availableUpdateCount(games);
  if (platform === 'darwin') app.dock?.setBadge(count ? String(count) : '');
  return count;
}

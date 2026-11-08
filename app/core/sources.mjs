import { DEFAULT_SITE, DEFAULT_LC_SITE } from './model.mjs';
import { siteOrigin, threadReference } from './site-url.mjs';

export function sourceId(site) {
  if (site?.origin === DEFAULT_LC_SITE.origin) return 'lc';
  if (site?.origin === DEFAULT_SITE.origin) return 'f95';
  return site?.id === 'lc' ? 'lc' : 'f95';
}
export function configuredSources(settings) {
  const sources = { f95: { ...DEFAULT_SITE, ...settings.sources?.f95 }, lc: { ...DEFAULT_LC_SITE, ...settings.sources?.lc } };
  // Keep legacy settings.site compatible, without rewriting games' origins.
  if (settings.site) {
    const id = sourceId(settings.site);
    sources[id] = { ...sources[id], ...settings.site, id, shortName: id === 'lc' ? 'LC' : 'F95' };
  }
  return Object.values(sources);
}
export function sourceById(settings, id) {
  const source = configuredSources(settings).find(source => source.id === id);
  if (!source) throw new Error('Choose F95 or LewdCorner as the source.');
  return source;
}
export function sourceForUrl(settings, value) {
  let origin; try { origin = new URL(value).origin; } catch { throw new Error('Enter a complete F95 or LewdCorner thread URL.'); }
  const source = configuredSources(settings).find(source => source.origin === origin);
  if (!source) throw new Error('This thread belongs to a different site that is not a configured website source.');
  return source;
}
export function sourceThreadReference(settings, value) {
  const source = sourceForUrl(settings, value);
  return threadReference(value, source.origin);
}
export function sourceLabel(settings, game) {
  if (!game.threadId || !game.threadUrl) return 'Local';
  return configuredSources(settings).find(source => source.origin === game.origin)?.shortName || 'Unmapped';
}
export function migrateSources(state) {
  const sources = configuredSources(state.settings);
  state.settings.sources = Object.fromEntries(sources.map(source => [source.id, source]));
  state.settings.site = { ...state.settings.sources[sourceId(state.settings.site)] };
  state.sourceStatus ||= {}; state.sourceScans ||= {};
  for (const status of Object.values(state.sourceStatus)) { if (status.active) Object.assign(status, { active: false, status: 'unchecked', message: 'Previous site check was interrupted.' }); }
  for (const scan of Object.values(state.sourceScans)) { if (scan.active) Object.assign(scan, { active: false, error: 'The app closed before this source check finished.' }); }
}
export function updateSourceSettings(state, input) {
  const existing = sourceById(state.settings, input.id);
  if (state.scan.active || state.sourceStatus?.[input.id]?.active) throw new Error('Wait for the site/update check to finish before changing its endpoint.');
  const latestPath = String(input.latestPath || '').trim();
  if (latestPath.length > 2000) throw new Error('The endpoint URL is too long.');
  if (latestPath) {
    const url = new URL(latestPath.replaceAll('{page}', '1'), existing.origin);
    if (siteOrigin(url.href) !== existing.origin) throw new Error('The latest-updates endpoint must belong to this website.');
  }
  if (!['json', 'html'].includes(input.feedFormat)) throw new Error('Choose JSON data or a forum HTML listing.');
  const next = { ...existing, latestPath, feedFormat: input.feedFormat };
  state.settings.sources ||= {}; state.settings.sources[input.id] = next;
  if (sourceId(state.settings.site) === input.id) state.settings.site = { ...next };
  delete state.checkpoints[existing.origin];
  state.sourceStatus[input.id] = { active: false, status: 'unchecked', message: 'Endpoint changed. Check site to verify it.', feedStatus: latestPath ? 'unchecked' : 'unconfigured' };
}

export async function checkSourceStatus({ store, client, id, now = Date.now, timeout = 60000 }) {
  const site = sourceById(store.data.settings, id);
  if (store.data.sourceStatus[id]?.active) return { busy: true };
  const attempt = (store.data.sourceStatus[id]?.attempt || 0) + 1, startedAt = now();
  await store.update(state => { state.sourceStatus[id] = { ...state.sourceStatus[id], attempt, startedAt, active: true, status: 'checking', feedStatus: 'checking', message: 'Checking website…' }; });
  let result, timer;
  const progress = async message => {
    if (!store.data.sourceStatus[id]?.active || store.data.sourceStatus[id].attempt !== attempt) return;
    await store.update(state => { if (state.sourceStatus[id]?.active && state.sourceStatus[id].attempt === attempt) state.sourceStatus[id].message = message; });
  };
  try { result = await Promise.race([
    client.availability(progress),
    new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'error', message: 'The site check timed out. Open this source in Browse and retry.', feedStatus: 'unchecked' }), timeout); })
  ]); }
  catch { result = { status: 'error', message: 'The website check failed. Open it in Browse and retry.', feedStatus: 'unchecked' }; }
  finally { clearTimeout(timer); }
  result = { ...result, attempt, startedAt, active: false, checkedAt: now(), origin: site.origin };
  await store.update(state => { state.sourceStatus[id] = result; });
  return result;
}

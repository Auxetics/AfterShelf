import { normalizeVersion, versionKnown, versionRelation, updateSkipped } from './model.mjs';
import { applyForumMetadata } from './metadata.mjs';
import { configuredSources, sourceById } from './sources.mjs';

export function feedFingerprint(row) { return JSON.stringify([String(row.threadId), normalizeVersion(row.version), row.title || '']); }
function observedFingerprint(entries) { const keys = [...new Set(entries.map(feedFingerprint))].sort(); return keys.length === 1 ? keys[0] : JSON.stringify(keys); }
function reachedFrontier(rows, head) {
  const tail = new Set(head.slice(-5));
  return new Set(rows.map(feedFingerprint).filter(key => tail.has(key))).size >= Math.min(2, tail.size);
}
function updateTime(row, now) {
  const value = Number(row.updatedAt);
  return Number.isFinite(value) && value >= Date.UTC(2000, 0, 1) && value <= now + 300000 ? value : 0;
}
export async function checkLibraryUpdates({ onWatchedRelease, store, client, full = false, now = Date.now, maxPages = 20, recheckAfter = 86400000, maxRechecks = 5 }) {
  if (store.data.scan.active) return { busy: true };
  const site = structuredClone(store.data.settings.site), startedAt = now();
  const games = store.data.games.filter(game => game.origin === site.origin && game.threadId && game.threadUrl).map(game => ({ ...game }));
  const checkpoint = store.data.checkpoints[site.origin];
  const baseline = checkpoint?.revision !== 2 || !Array.isArray(checkpoint.head) || !checkpoint.head.length;
  const summary = { mode: 'feed', pages: 0, entries: 0, linked: games.length, verified: 0, failed: 0,
    unlinked: store.data.games.filter(game => !game.threadId || !game.threadUrl).length,
    unknownInstalled: games.filter(game => game.installation && !versionKnown(game.installedVersion)).length,
    updates: 0, different: 0, full, checkpointAdvanced: false, stopReason: '', reconciledAll: false };
  await store.update(state => Object.assign(state.scan, { active: true, message: 'Checking recent updates…', error: '', summary }));
  if (!games.length) {
    await store.update(state => Object.assign(state.scan, { active: false, message: 'No linked games to check. Use Find forum match first.', summary }));
    return { ...summary, message: store.data.scan.message, error: '' };
  }
  const errors = [];
  try {
    const pageSize = client.pageSize, paginated = Number.isInteger(pageSize) && pageSize > 0;
    const pageBudget = Math.max(1, Math.min(Math.floor(maxPages) || 20, Math.max(3, games.length)));
    const windowStart = client.windowDays > 0 ? startedAt - client.windowDays * 86400000 : 0;
    const expiredWindow = !baseline && windowStart > 0 && checkpoint.at > 0 && checkpoint.at < windowStart;
    const cutoff = Math.max(Number(checkpoint?.at) || 0, windowStart);
    let reconcileAll = full || expiredWindow;
    const rows = [], seen = new Set(); let head = [], complete = false;
    try {
      for (let page = 1; page <= pageBudget; page++) {
        await store.update(state => { state.scan.message = `Checking recent updates · page ${page}`; });
        const entries = await client.latestPage(page); summary.pages++;
        if (page === 1) {
          head = [...new Set(entries.map(feedFingerprint))].slice(0, 200);
          if (!entries.length) throw new Error('The latest feed returned no game entries. Check the endpoint and login in Browse.');
        }
        rows.push(...entries); summary.entries += entries.length;
        let added = 0;
        for (const row of entries) { const key = feedFingerprint(row); if (!seen.has(key)) { seen.add(key); added++; } }
        // A first observation needs a head marker, not a crawl to the end of
        // an allegedly seven-day listing. Imported/unknown games are verified
        // separately below; already verified games keep their known versions.
        if (baseline || reconcileAll) { summary.stopReason = full ? 'full-thread-check' : expiredWindow ? 'expired-listing-window' : 'initial-baseline'; complete = true; break; }
        if (reachedFrontier(rows, checkpoint.head)) { summary.stopReason = 'previous-checkpoint'; complete = true; break; }
        const oldDates = entries.length && entries.every(row => { const time = updateTime(row, startedAt); return time > 0 && time <= cutoff; });
        const reason = !entries.length || paginated && entries.length < pageSize ? 'listing-ended' : !added ? 'repeated-page' : oldDates ? 'saved-date-boundary' : '';
        if (reason) { reconcileAll = true; summary.stopReason = reason; complete = true; break; }
      }
    } catch (error) { if (!full) throw error; errors.push(`Latest feed unavailable: ${error.message}`); }
    // A lost frontier must not create a permanent retry loop. Verify the linked
    // games once to close the gap, then commit the new first-page marker.
    if (!complete && !errors.length) { reconcileAll = true; summary.stopReason = 'pagination-budget'; }
    summary.reconciledAll = reconcileAll;
    const observed = new Map();
    for (const row of rows) { const id = String(row.threadId); if (!observed.has(id)) observed.set(id, []); observed.get(id).push(row); }
    const selected = new Map();
    for (const game of games) {
      const entries = observed.get(String(game.threadId));
      const changed = entries && observedFingerprint(entries) !== game.lastFeedFingerprint && entries.some(row => !versionKnown(row.version) || normalizeVersion(row.version) !== normalizeVersion(game.latestVersion));
      if (reconcileAll || baseline && (!game.versionVerifiedAt || !versionKnown(game.latestVersion)) || changed) selected.set(game.id, game);
    }
    const overdue = games.filter(game => !selected.has(game.id) && startedAt - (game.versionVerifiedAt || 0) >= recheckAfter).sort((a, b) => (a.versionVerifiedAt || 0) - (b.versionVerifiedAt || 0)).slice(0, maxRechecks);
    for (const game of overdue) selected.set(game.id, game);
    for (const [index, game] of [...selected.values()].entries()) {
      await store.update(state => { state.scan.message = `Checking changed or unverified threads · ${index + 1} of ${selected.size}`; });
      try {
        const metadata = await client.thread(game.threadUrl, { cover: false });
        if (!versionKnown(metadata.latestVersion)) throw new Error('The thread did not report a usable game version.');
        if (String(metadata.threadId) !== String(game.threadId) || metadata.origin !== site.origin) throw new Error('The returned thread identity did not match the linked game.');
        if ((observed.get(String(game.threadId)) || []).some(row => versionRelation(metadata.latestVersion, row.version) === 'newer')) throw new Error('The feed reports a newer release than the thread currently returns. Retry after the forum catches up; the checkpoint was retained.');
        if (store.data.settings.site.origin !== site.origin) throw new Error('The configured forum changed during the update check.');
        await store.update(state => {
          const target = state.games.find(item => item.id === game.id);
          if (!target || target.origin !== game.origin || String(target.threadId) !== String(game.threadId) || target.threadUrl !== game.threadUrl) throw new Error('The game link changed during the update check. Retry with its current thread.');
          applyForumMetadata(state, game.id, metadata, { now: now(), onWatchedRelease }); target.versionVerifiedAt = now();
          const entries = observed.get(String(game.threadId)); if (entries) target.lastFeedFingerprint = observedFingerprint(entries);
        });
        summary.verified++;
      } catch (error) { summary.failed++; errors.push(`Thread ${game.threadId}: ${error.message}`); if (/sign in|HTTP (?:401|403)|configured forum changed/i.test(error.message)) break; }
    }
    if (store.data.settings.site.origin !== site.origin) throw new Error('The configured forum changed during the update check.');
    await store.update(state => {
      for (const game of state.games.filter(game => game.origin === site.origin)) {
        const entries = observed.get(String(game.threadId));
        if (entries && entries.every(row => versionKnown(row.version) && normalizeVersion(row.version) === normalizeVersion(game.latestVersion))) game.lastFeedFingerprint = observedFingerprint(entries);
      }
      if (!errors.length) {
        state.checkpoints[site.origin] = { revision: 2, head, at: startedAt, newestUpdatedAt: Math.max(0, ...rows.map(row => updateTime(row, startedAt))) };
        summary.checkpointAdvanced = true; state.scan.lastChecked = now();
      }
    });
  } catch (error) { errors.push(error.message); }
  const current = store.data.games.filter(game => game.origin === site.origin && game.threadId && game.threadUrl);
  summary.updates = current.filter(game => game.installation && !updateSkipped(game) && versionRelation(game.installedVersion, game.latestVersion) === 'newer').length;
  summary.different = current.filter(game => game.installation && !updateSkipped(game) && versionRelation(game.installedVersion, game.latestVersion) === 'different').length;
  const message = `${errors.length ? 'Update check incomplete' : 'Checked latest feed'} · ${summary.pages} pages / ${summary.entries} entries · ${summary.verified} threads refreshed${summary.reconciledAll ? ' · catch-up completed' : ''} · ${summary.updates} updates${summary.different ? ` · ${summary.different} versions differ` : ''}${summary.unlinked ? ` · ${summary.unlinked} unlinked` : ''}${summary.unknownInstalled ? ` · ${summary.unknownInstalled} installed versions unknown` : ''}`;
  await store.update(state => Object.assign(state.scan, { active: false, message, error: errors.join('\n'), summary }));
  if (errors.length) await store.log('Update check incomplete', errors.join('\n'));
  return { ...summary, message, error: errors.join('\n') };
}

// Reuse the proven single-source checker with its own scan state, while keeping
// the application's global busy flag held for the whole multi-source run.
function sourceStore(store, id) {
  const view = state => ({ ...state, settings: { ...state.settings, site: sourceById(state.settings, id) }, scan: state.sourceScans[id] || { active: false, message: '', lastChecked: null, error: '' } });
  return {
    get data() { return view(store.data); },
    update(fn) { return store.update(state => {
      const scoped = view(state); fn(scoped);
      state.games = scoped.games; state.downloads = scoped.downloads; state.checkpoints = scoped.checkpoints;
      state.sourceScans[id] = scoped.scan;
      state.scan.message = `${sourceById(state.settings, id).shortName} · ${scoped.scan.message}`;
    }); },
    log: (...args) => store.log(...args)
  };
}
export async function checkAllSourceUpdates({ store, clientForSource, full = false, now = Date.now, ...options }) {
  if (store.data.scan.active) return { busy: true };
  const sites = configuredSources(store.data.settings).filter(site => store.data.games.some(game => game.origin === site.origin && game.threadId && game.threadUrl));
  const linked = store.data.games.filter(game => game.threadId && game.threadUrl);
  const unmapped = linked.filter(game => !sites.some(site => site.origin === game.origin)).length;
  const results = [], errors = unmapped ? [`${unmapped} linked games have no configured website source.`] : [];
  await store.update(state => { state.sourceScans ||= {}; Object.assign(state.scan, { active: true, error: '', message: 'Checking game sources…' }); });
  try {
    for (const site of sites) {
      try {
        const result = await checkLibraryUpdates({ store: sourceStore(store, site.id), client: clientForSource(site), full, now, ...options });
        results.push({ sourceId: site.id, name: site.shortName, ...result });
        if (result.error) errors.push(`${site.shortName}: ${result.error}`);
      } catch (error) {
        errors.push(`${site.shortName}: ${error.message}`);
        await store.update(state => { state.sourceScans[site.id] = { ...state.sourceScans[site.id], active: false, error: error.message, message: 'Source check failed' }; });
      }
    }
  } catch (error) { errors.push(error.message); }
  const summary = { mode: 'feed', sources: results, pages: results.reduce((n, result) => n + (result.pages || 0), 0), entries: results.reduce((n, result) => n + (result.entries || 0), 0), verified: results.reduce((n, result) => n + (result.verified || 0), 0), updates: store.data.games.filter(game => game.installation && !updateSkipped(game) && versionRelation(game.installedVersion, game.latestVersion) === 'newer').length, unlinked: store.data.games.length - linked.length, full };
  const message = !sites.length && !unmapped ? 'No linked games to check. Use Find forum match first.' : `${errors.length ? 'Update check incomplete' : 'Checked game sources'} · ${summary.pages} pages / ${summary.entries} entries · ${summary.verified} threads verified · ${summary.updates} updates`;
  await store.update(state => { Object.assign(state.scan, { active: false, message, error: errors.join('\n'), summary }); if (sites.length && !errors.length) state.scan.lastChecked = now(); });
  return { ...summary, message, error: errors.join('\n') };
}

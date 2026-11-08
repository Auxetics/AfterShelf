import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialState, newGame } from '../app/core/model.mjs';
import { configuredSources, sourceById, sourceLabel, migrateSources, updateSourceSettings, checkSourceStatus } from '../app/core/sources.mjs';
import { ForumMetadata, updateFeedUrl, searchUrl } from '../app/core/forum-metadata.mjs';
import { parseLatestHtml } from '../app/core/site.mjs';
import { checkAllSourceUpdates } from '../app/core/update-checker.mjs';
import { ensureDownloadGame, applyDownloadSource, assignDownloadGame } from '../app/core/downloads.mjs';
import { Store } from '../app/core/store.mjs';

function harness() {
  const data = initialState();
  return { data, async update(fn) { fn(data); }, async log() {} };
}
function thread(site, version = '2.0') { return { origin: site.origin, threadId: '123', threadUrl: `${site.origin}/threads/example.123/`, title: `Example ${site.shortName}`, engine: 'renpy', latestVersion: version }; }
function listing(version = '2.0') { return `<main><div class="structItem"><div class="structItem-title"><span class="label">Ren'Py</span><a href="/threads/example.123/">Example [v${version}] [Creator]</a></div><a href="/threads/example.123/unread">Unread</a></div></main>`; }
function addGames(store) {
  for (const site of configuredSources(store.data.settings)) store.data.games.push(newGame({ ...thread(site, '1.0'), installation: { root: `/fixture/${site.id}` }, installedVersion: '1.0' }));
}

test('source migration preserves old games, checkpoints and F95 configuration while adding LC', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aftershelf-sources-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = initialState(); delete state.settings.sources; delete state.sourceStatus; delete state.sourceScans;
  state.settings.site.latestPath = '/custom-feed?page={page}'; state.games.push(newGame(thread(state.settings.site)));
  state.checkpoints[state.settings.site.origin] = { revision: 2, head: ['old'] };
  const before = structuredClone(state.games); await fs.writeFile(path.join(root, 'library.json'), JSON.stringify(state));
  const store = new Store(root); await store.open();
  assert.deepEqual(store.data.games, before); assert.equal(sourceById(store.data.settings, 'f95').latestPath, '/custom-feed?page={page}');
  assert.match(sourceById(store.data.settings, 'lc').latestPath, /only_new_days=7/);
  assert.deepEqual(store.data.checkpoints[state.settings.site.origin].head, ['old']);
});

test('LC pagination preserves the supplied filters and searches use title search without the seven-day restriction', () => {
  const site = sourceById(initialState().settings, 'lc'), url = new URL(updateFeedUrl(site, 3));
  assert.equal(url.pathname, '/latest-updates'); assert.equal(url.searchParams.get('page'), '3');
  assert.equal(url.searchParams.get('per_page'), '60'); assert.equal(url.searchParams.get('cat'), 'Games');
  assert.equal(url.searchParams.get('only_new_days'), '7'); assert.equal(url.searchParams.get('ignored_mode'), 'hide');
  assert.equal(url.searchParams.has('rows'), false); assert.equal(url.searchParams.has('sort'), false);
  const search = new URL(searchUrl(site, 'Example Game', 2)); assert.equal(search.searchParams.get('search'), 'example game'); assert.equal(search.searchParams.has('only_new_days'), false);
});

test('source settings accept a complete same-site URL and keep checkpoints independent', () => {
  const state = initialState(), f95 = sourceById(state.settings, 'f95'), lc = sourceById(state.settings, 'lc');
  state.checkpoints[f95.origin] = { head: ['f95'] }; state.checkpoints[lc.origin] = { head: ['lc'] };
  updateSourceSettings(state, { id: 'lc', latestPath: lc.origin + '/latest-updates?page={page}&per_page=60', feedFormat: 'html' });
  assert.equal(state.checkpoints[lc.origin], undefined); assert.deepEqual(state.checkpoints[f95.origin], { head: ['f95'] });
  assert.equal(sourceById(state.settings, 'f95').latestPath, f95.latestPath);
  assert.throws(() => updateSourceSettings(state, { id: 'lc', latestPath: f95.origin + '/feed', feedFormat: 'json' }), /must belong/);
  state.scan.active = true; assert.throws(() => updateSourceSettings(state, { id: 'lc', latestPath: '/feed', feedFormat: 'json' }), /finish/);
});

test('HTML listing extracts same-site release threads and rejects login, challenge and unexpected pages', () => {
  const origin = 'https://lc.example.test', rows = parseLatestHtml(listing(), origin);
  assert.equal(rows.length, 1); assert.equal(rows[0].threadId, '123'); assert.equal(rows[0].version, '2.0'); assert.equal(rows[0].engine, 'renpy');
  const badges = parseLatestHtml('<main><article class="game-card"><a href="/threads/example.123/" title="View thread">Example Game</a><span class="badge">22</span><span class="label">v3.1</span></article></main>', origin);
  assert.equal(badges[0].title, 'Example Game'); assert.equal(badges[0].version, '3.1');
  assert.throws(() => parseLatestHtml('<title>Just a moment</title>' + listing(), origin), /sign in/);
  assert.throws(() => parseLatestHtml('<main>Welcome to our website</main>', origin), /No game thread/);
  assert.deepEqual(parseLatestHtml('<main>No games found</main>', origin), []);
  assert.throws(() => parseLatestHtml('<main><a href="https://elsewhere.test/threads/example.123/">Foreign game [v2.0]</a></main>', origin), /No game thread/);
});

test('availability separates reachable sites, working feeds, login challenges and broken endpoint mappings', async () => {
  const store = harness(), site = sourceById(store.data.settings, 'lc'), before = structuredClone(store.data.games);
  const client = new ForumMetadata(site, async url => new Response(new URL(url).pathname === '/' ? '<title>Forum</title>' : listing()));
  let result = await checkSourceStatus({ store, client, id: 'lc' }); assert.equal(result.status, 'reachable'); assert.equal(result.feedStatus, 'ok');
  result = await new ForumMetadata(site, async () => new Response('<title>Just a moment</title>')).availability(); assert.equal(result.status, 'login-required');
  result = await new ForumMetadata(site, async url => new Response(new URL(url).pathname === '/' ? '<title>Forum</title>' : 'unexpected')).availability(); assert.equal(result.status, 'reachable'); assert.equal(result.feedStatus, 'error');
  result = await new ForumMetadata(site, async () => new Response('unavailable', { status: 503 })).availability(); assert.equal(result.status, 'error');
  assert.deepEqual(store.data.games, before); assert.deepEqual(store.data.checkpoints, {});
});

test('mixed libraries route identical thread IDs through their own JSON or HTML source regardless of the selected browsing site', async () => {
  const store = harness(); addGames(store);
  store.data.settings.site = { ...sourceById(store.data.settings, 'lc') };
  const requested = [];
  const result = await checkAllSourceUpdates({ store, clientForSource: site => new ForumMetadata(site, async url => {
    requested.push(url); assert.equal(new URL(url).origin, site.origin);
    if (new URL(url).pathname.startsWith('/threads/')) return new Response(`<h1 class="p-title-value">Example ${site.shortName} [v${site.id === 'f95' ? '2.0' : '3.0'}]</h1><article class="message-threadStarterPost"><div class="message-body">Engine: Ren'Py</div></article>`);
    return site.id === 'f95' ? Response.json({ data: [{ thread_id: 123, title: 'Example F95', version: '2.0' }] }) : new Response(listing('3.0'));
  }) });
  assert.equal(result.error, ''); assert.equal(result.verified, 2); assert.equal(result.updates, 2);
  assert.equal(store.data.games.find(game => game.origin.includes('f95')).latestVersion, '2.0');
  assert.equal(store.data.games.find(game => game.origin.includes('lewdcorner')).latestVersion, '3.0');
  assert.equal(Object.keys(store.data.checkpoints).length, 2); assert.equal(requested.length, 4);
  assert.equal(store.data.scan.active, false); assert.equal(store.data.sourceScans.f95.active, false); assert.equal(store.data.sourceScans.lc.active, false);
});

test('one source failure preserves its checkpoint while the other source completes successfully', async () => {
  const store = harness(); addGames(store);
  const lc = sourceById(store.data.settings, 'lc'), prior = { revision: 2, head: ['old-lc'], at: 1 }; store.data.checkpoints[lc.origin] = structuredClone(prior);
  const result = await checkAllSourceUpdates({ store, clientForSource: site => ({
    async latestPage() { if (site.id === 'lc') throw new Error('HTTP 403'); return [{ threadId: '123', title: 'Example F95', version: '2.0' }]; },
    async thread() { if (site.id === 'lc') throw new Error('HTTP 403'); return { ...thread(site), checkedAt: Date.now() }; }
  }) });
  assert.match(result.error, /LC:.*403/); assert.equal(result.verified, 1);
  assert.deepEqual(store.data.checkpoints[lc.origin], prior); assert.ok(store.data.checkpoints[sourceById(store.data.settings, 'f95').origin]);
  assert.equal(store.data.games.find(game => game.origin === lc.origin).latestVersion, '1.0');
  assert.equal(store.data.scan.lastChecked, null);
});

test('downloading from LC creates a separate identity, while explicit installation adopts its source only on commit', () => {
  const store = harness(), state = store.data, f95 = sourceById(state.settings, 'f95'), lc = sourceById(state.settings, 'lc');
  const existing = ensureDownloadGame(state, { thread: thread(f95, '1.0') }); existing.installation = { root: '/fixture/old' }; existing.installedVersion = '1.0';
  const pending = ensureDownloadGame(state, { thread: thread(lc) }); assert.notEqual(existing.id, pending.id); assert.equal(state.games.length, 2);
  const job = { id: 'download', gameId: existing.id, thread: thread(lc), version: '2.0', status: 'downloaded' }; state.downloads.push(job);
  assert.equal(sourceLabel(state.settings, existing), 'F95'); job.status = 'failed'; assert.equal(existing.origin, f95.origin);
  job.status = 'installed'; applyDownloadSource(state, existing.id, job);
  assert.equal(sourceLabel(state.settings, existing), 'LC'); assert.equal(existing.installedVersion, '1.0'); assert.equal(existing.installation.root, '/fixture/old');
  assert.equal(state.games.length, 1); assert.equal(existing.id, `${f95.origin}:123`);
});

test('a conflicting installed source cannot change another game’s metadata during source adoption', () => {
  const store = harness(); addGames(store);
  const game = store.data.games[0], before = structuredClone(game), lc = sourceById(store.data.settings, 'lc');
  assert.throws(() => applyDownloadSource(store.data, game.id, { thread: thread(lc), version: '2.0' }), /another installed game/);
  assert.deepEqual(game, before);
});

test('unlinked local games never cause source feed requests or receive a misleading website badge', async () => {
  const store = harness(); store.data.games.push({ id: 'local', title: 'Local', installation: { root: '/fixture/local' } });
  const result = await checkAllSourceUpdates({ store, clientForSource() { throw new Error('must not be requested'); } });
  assert.equal(result.verified, 0); assert.equal(sourceLabel(store.data.settings, store.data.games[0]), 'Local'); assert.equal(store.data.scan.lastChecked, null);
});

test('assigning an LC archive to an F95 game does not invent its version or change the game source early', () => {
  const state = initialState(), f95 = sourceById(state.settings, 'f95'), lc = sourceById(state.settings, 'lc');
  const game = ensureDownloadGame(state, { thread: thread(f95, '4.0') }); game.installation = { root: '/fixture/f95' }; game.installedVersion = '1.0';
  const job = { id: 'lc-archive', status: 'downloaded', version: '', thread: thread(lc, '') }; state.downloads.push(job);
  assignDownloadGame(state, { id: job.id, gameId: game.id });
  assert.equal(job.version, ''); assert.equal(game.origin, f95.origin); assert.equal(game.latestVersion, '4.0'); assert.equal(game.installedVersion, '1.0');
  assignDownloadGame(state, { id: job.id, gameId: game.id, version: '2.5' }); assert.equal(job.version, '2.5');
  applyDownloadSource(state, game.id, job); assert.equal(game.origin, lc.origin); assert.equal(game.latestVersion, '2.5'); assert.equal(game.installedVersion, '1.0');
});

test('adding a new game from a recorded LC download preserves its source while browsing F95', () => {
  const state = initialState(), lc = sourceById(state.settings, 'lc');
  state.downloads.push({ id: 'lc-new', status: 'downloaded', thread: thread(lc), version: '2.0' });
  const game = assignDownloadGame(state, { id: 'lc-new', create: { title: 'User title', engine: 'renpy', threadUrl: '' } });
  assert.equal(game.origin, lc.origin); assert.equal(game.threadId, '123'); assert.equal(game.title, 'User title'); assert.equal(game.installation, null);
});

test('site-check progress identifies the current stage and records a fresh completion time', async () => {
  const store = harness(), observed = []; store.data.sourceStatus.lc = { checkedAt: 1, status: 'reachable', feedStatus: 'error' };
  const client = { async availability(progress) {
    assert.equal(store.data.sourceStatus.lc.feedStatus, 'checking');
    await progress('Reading the update endpoint…'); observed.push(store.data.sourceStatus.lc.message);
    await progress('Waiting for game links…'); observed.push(store.data.sourceStatus.lc.message);
    return { status: 'reachable', feedStatus: 'ok', message: 'Parsed listing' };
  } };
  const result = await checkSourceStatus({ store, client, id: 'lc', now: () => 1000 });
  assert.deepEqual(observed, ['Reading the update endpoint…', 'Waiting for game links…']);
  assert.equal(result.active, false); assert.equal(result.startedAt, 1000); assert.equal(result.checkedAt, 1000);
});

test('site checks stop at the overall deadline and late work cannot overwrite a newer result', async () => {
  const store = harness(); let release, lateProgress;
  const result = await checkSourceStatus({ store, id: 'lc', timeout: 10, client: { availability(progress) { lateProgress = progress; return new Promise(resolve => { release = resolve; }); } } });
  assert.equal(result.active, false); assert.equal(result.status, 'error'); assert.match(result.message, /timed out/);
  await checkSourceStatus({ store, id: 'lc', client: { async availability() { return { status: 'reachable', message: 'Fresh result', feedStatus: 'ok' }; } } });
  await lateProgress('Stale progress'); release({ status: 'error', message: 'Late result' }); await Promise.resolve();
  assert.equal(store.data.sourceStatus.lc.message, 'Fresh result'); assert.equal(store.data.sourceStatus.lc.active, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { checkLibraryUpdates, feedFingerprint } from '../app/core/update-checker.mjs';
import { threadReference, parseLatest, parseLatestHtml } from '../app/core/site.mjs';
import { initialState, newGame } from '../app/core/model.mjs';
import { Store } from '../app/core/store.mjs';

const ORIGIN = initialState().settings.site.origin, NOW = 1800000000000;
const linked = (id, extra = {}) => newGame({ id: `local:${id}`, origin: ORIGIN, threadId: String(id), threadUrl: `${ORIGIN}/threads/game.${id}/`, title: `Game ${id}`, engine: 'renpy', installedVersion: '1.0', latestVersion: '1.0', installation: { root: `/games/${id}`, launch: `/games/${id}/run`, version: '1.0' }, ...extra });
function harness(games) {
  const data = initialState(), calls = [], pages = [], releases = {}, events = [];
  data.games = games; data.scan.lastChecked = NOW - 100000;
  const store = { data, async update(fn) { fn(data); events.push(data.scan.message); }, async log(message, details) { data.history.push({ message, details }); } };
  const client = {
    async latestPage(page) { pages.push(page); return page === 1 ? [{ threadId: '900', title: 'Newest 900', version: '1.0' }, { threadId: '901', title: 'Newest 901', version: '1.0' }] : []; },
    async thread(url, options) {
      assert.equal(options.cover, false); calls.push(url);
      const ref = threadReference(url, ORIGIN), value = releases[ref.threadId] ?? '1.0';
      if (value instanceof Error) throw value;
      return { ...ref, title: `Game ${ref.threadId}`, engine: 'renpy', latestVersion: value, checkedAt: NOW };
    }
  };
  return { store, client, calls, pages, releases, events, run(options = {}) { const { client: override, ...rest } = options; return checkLibraryUpdates({ store, client: override ? { ...client, ...override } : client, now: () => NOW, ...rest }); } };
}
test('an initial feed baseline verifies unknown linked versions without altering installations', async () => {
  const game = linked(1), h = harness([game]); h.releases['1'] = '2.0';
  h.store.data.downloads.push({ id: 'download', status: 'downloaded', gameId: game.id });
  const before = structuredClone(game.installation), result = await h.run();
  assert.equal(result.mode, 'feed'); assert.equal(result.verified, 1); assert.equal(result.updates, 1);
  assert.deepEqual(h.calls, [game.threadUrl]); assert.equal(game.latestVersion, '2.0'); assert.equal(game.installedVersion, '1.0');
  assert.deepEqual(game.installation, before); assert.equal(h.store.data.downloads[0].status, 'downloaded');
  assert.equal(game.versionVerifiedAt, NOW); assert.equal(h.store.data.scan.lastChecked, NOW);
  assert.equal(h.store.data.checkpoints[ORIGIN].at, NOW); assert.ok(h.events.some(text => text.includes('1 of 1')));
});
test('unchanged polls read only the latest page without refetching threads or covers', async () => {
  const h = harness([linked(1)]);
  await h.run(); const second = await h.run();
  assert.equal(h.calls.length, 1); assert.equal(second.verified, 0); assert.deepEqual(h.pages, [1, 1]); assert.equal(second.updates, 0);
});
test('explicit full checks verify linked threads after sampling only the first feed page', async () => {
  const h = harness([linked(1)]); h.releases['1'] = '2.0';
  const result = await h.run({ full: true }); assert.equal(result.verified, 1); assert.equal(result.updates, 1); assert.equal(h.calls.length, 1);
});
test('older forum releases never claim a newer update and nonnumeric labels remain explicitly different', async () => {
  const h = harness([linked(1, { installedVersion: '3.0' }), linked(2, { installedVersion: 'Chapter 1' })]);
  h.releases['1'] = '2.0'; h.releases['2'] = 'Chapter 2';
  const result = await h.run(); assert.equal(result.updates, 0); assert.equal(result.different, 1);
  assert.equal(h.store.data.games[0].installedVersion, '3.0');
});
test('partial failures keep successful metadata and preserve the last fully successful completion time', async () => {
  const h = harness([linked(1), linked(2)]); h.releases['1'] = '2.0'; h.releases['2'] = new Error('HTTP 503');
  const first = await h.run(); assert.equal(first.verified, 1); assert.equal(first.failed, 1); assert.match(first.error, /Thread 2/);
  assert.equal(h.store.data.games[0].latestVersion, '2.0'); assert.equal(h.store.data.games[1].latestVersion, '1.0');
  assert.equal(h.store.data.scan.lastChecked, NOW - 100000); assert.equal(h.store.data.scan.active, false);
  h.releases['2'] = '3.0'; h.calls.length = 0;
  const retry = await h.run(); assert.equal(retry.error, ''); assert.equal(retry.verified, 1); assert.equal(h.calls.length, 1);
  assert.equal(h.store.data.scan.lastChecked, NOW);
});
test('an expired login stops remaining requests for the affected source', async () => {
  const h = harness([linked(1), linked(2)]); h.releases['1'] = new Error('Metadata request returned HTTP 403. Open Browse to sign in.');
  const result = await h.run(); assert.equal(result.failed, 1); assert.equal(h.calls.length, 1);
  assert.equal(h.store.data.scan.lastChecked, NOW - 100000);
});
test('a missing or deleted thread reports failure while other linked games can still update', async () => {
  const h = harness([linked(1), linked(2)]); h.releases['1'] = new Error('HTTP 404'); h.releases['2'] = '2.0';
  const result = await h.run(); assert.equal(result.failed, 1); assert.equal(result.verified, 1); assert.equal(result.updates, 1);
});
test('missing thread version evidence preserves known data and reports the failed verification', async () => {
  const h = harness([linked(1)]); h.releases['1'] = 'Unknown';
  const result = await h.run(); assert.equal(result.failed, 1); assert.match(result.error, /usable game version/);
  assert.equal(h.store.data.games[0].latestVersion, '1.0'); assert.equal(h.store.data.games[0].versionVerifiedAt, undefined);
});
test('a changed URL slug with the same numeric ID updates the stored canonical link', async () => {
  const h = harness([linked(1)]);
  const result = await h.run({ client: { async thread() { return { origin: ORIGIN, threadId: '1', threadUrl: ORIGIN + '/threads/new-version-title.1/', latestVersion: '2.0' }; } } });
  assert.equal(result.error, ''); assert.equal(h.store.data.games[0].threadUrl, ORIGIN + '/threads/new-version-title.1/');
});
test('a different thread ID or website cannot overwrite the linked game', async () => {
  for (const change of [{ threadId: '2' }, { origin: 'https://other.test' }]) {
    const h = harness([linked(1)]);
    const result = await h.run({ client: { async thread() { return { origin: ORIGIN, threadId: '1', latestVersion: '9.0', ...change }; } } });
    assert.match(result.error, /identity/); assert.equal(h.store.data.games[0].latestVersion, '1.0');
  }
});
test('changing a game link in flight prevents applying metadata from its old thread', async () => {
  const h = harness([linked(1)]);
  const result = await h.run({ client: { async thread() { h.store.data.games[0].threadId = '2'; return { origin: ORIGIN, threadId: '1', latestVersion: '9.0' }; } } });
  assert.match(result.error, /link changed/); assert.equal(h.store.data.games[0].latestVersion, '1.0');
});
test('changing the configured source in flight prevents applying another website’s metadata', async () => {
  const h = harness([linked(1)]);
  const result = await h.run({ client: { async thread() { h.store.data.settings.site.origin = 'https://other.test'; return { origin: ORIGIN, threadId: '1', latestVersion: '9.0' }; } } });
  assert.match(result.error, /configured forum changed/); assert.equal(h.store.data.games[0].latestVersion, '1.0');
});
test('unlinked games make no requests and unknown installed versions never invent an available update', async () => {
  const local = newGame({ origin: ORIGIN, id: 'local', title: 'Unlinked', threadId: '', threadUrl: '' });
  const h = harness([linked(1, { installedVersion: '' }), local]); h.releases['1'] = '2.0';
  const result = await h.run(); assert.equal(result.updates, 0); assert.equal(result.unknownInstalled, 1); assert.equal(result.unlinked, 1); assert.equal(h.calls.length, 1);
  const empty = harness([local]); assert.match((await empty.run()).message, /No linked games/); assert.equal(empty.calls.length, 0);
});
test('catch-up results survive reopening and the saved frontier prevents repeating old pages', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aftershelf-direct-check-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new Store(directory); await store.open();
  const old = { revision: 2, at: NOW - 86400000, head: ['legacy frontier'] };
  await store.update(state => { state.games.push(linked(1)); state.checkpoints[ORIGIN] = old; state.scan = { active: false, error: 'Old 20-page limit', lastChecked: NOW - 100000 }; });
  const h = harness([]); h.releases['1'] = '2.0';
  let result = await checkLibraryUpdates({ store, client: h.client, now: () => NOW }); assert.equal(result.error, '');
  const reopened = new Store(directory); await reopened.open();
  assert.equal(reopened.data.games[0].latestVersion, '2.0'); assert.equal(reopened.data.games[0].versionVerifiedAt, NOW); assert.equal(reopened.data.scan.lastChecked, NOW);
  assert.equal(reopened.data.checkpoints[ORIGIN].at, NOW); assert.notDeepEqual(reopened.data.checkpoints[ORIGIN].head, old.head);
  result = await checkLibraryUpdates({ store: reopened, client: h.client, now: () => NOW + 1000 });
  assert.equal(result.verified, 0); assert.equal(h.calls.length, 1);
});
test('an active source check cannot start a second overlapping check', async () => {
  const h = harness([linked(1)]); h.store.data.scan.active = true;
  assert.deepEqual(await h.run(), { busy: true }); assert.equal(h.calls.length, 0);
});
test('an ignored seven-day filter never turns the initial baseline into a 20-page crawl', async () => {
  const h = harness([linked(1, { versionVerifiedAt: NOW })]); h.client.pageSize = 60; h.client.windowDays = 7;
  h.client.latestPage = async page => { h.pages.push(page); return Array.from({ length: 60 }, (_, i) => ({ threadId: String(page * 100 + i), title: 'Other game', version: '1.0' })); };
  let result = await h.run(); assert.deepEqual(h.pages, [1]); assert.equal(result.checkpointAdvanced, true); assert.equal(result.stopReason, 'initial-baseline'); assert.equal(h.calls.length, 0);
  h.pages.length = 0; result = await h.run(); assert.deepEqual(h.pages, [1]); assert.equal(result.stopReason, 'previous-checkpoint'); assert.equal(h.calls.length, 0);
});
test('a large library only fetches changed linked threads during a normal incremental check', async () => {
  const games = Array.from({ length: 500 }, (_, i) => linked(i + 1, { versionVerifiedAt: NOW }));
  const h = harness(games), anchors = [{ threadId: '900', title: 'Newest 900', version: '1.0' }, { threadId: '901', title: 'Newest 901', version: '1.0' }];
  h.store.data.checkpoints[ORIGIN] = { revision: 2, head: anchors.map(feedFingerprint), at: NOW - 1000 };
  h.client.latestPage = async page => { h.pages.push(page); return [{ threadId: '123', title: 'Game 123', version: '2.0' }, ...anchors]; };
  h.releases['123'] = '2.0'; const result = await h.run();
  assert.equal(result.verified, 1); assert.deepEqual(h.calls, [games[122].threadUrl]); assert.deepEqual(h.pages, [1]);
});
test('lost frontiers reconcile once at the page budget and the next check uses the new saved frontier', async () => {
  const h = harness([linked(1, { versionVerifiedAt: NOW })]);
  h.store.data.checkpoints[ORIGIN] = { revision: 2, head: ['lost frontier'], at: NOW - 1000 };
  h.client.latestPage = async page => { h.pages.push(page); return [{ threadId: String(900 + page), title: 'Other', version: '1.0' }]; };
  h.releases['1'] = '2.0'; let result = await h.run({ maxRechecks: 0 });
  assert.deepEqual(h.pages, [1, 2, 3]); assert.equal(result.error, ''); assert.equal(result.stopReason, 'pagination-budget'); assert.equal(result.checkpointAdvanced, true); assert.equal(h.calls.length, 1);
  h.pages.length = 0; h.calls.length = 0; result = await h.run({ maxRechecks: 0 });
  assert.deepEqual(h.pages, [1]); assert.equal(result.stopReason, 'previous-checkpoint'); assert.equal(h.calls.length, 0);
});
test('real listing failures preserve the checkpoint and never claim a successful scan', async () => {
  const h = harness([linked(1, { versionVerifiedAt: NOW })]), old = { revision: 2, head: ['old'], at: NOW - 1000 };
  h.store.data.checkpoints[ORIGIN] = old; h.client.latestPage = async () => { throw new Error('HTTP 403'); };
  const result = await h.run(); assert.match(result.error, /403/); assert.deepEqual(h.store.data.checkpoints[ORIGIN], old); assert.equal(h.calls.length, 0); assert.equal(h.store.data.scan.lastChecked, NOW - 100000);
});
test('explicit release update dates stop catch-up while generic timestamps are not trusted', async () => {
  const h = harness([linked(1, { versionVerifiedAt: NOW })]); h.store.data.checkpoints[ORIGIN] = { revision: 2, head: ['old'], at: NOW - 1000 };
  h.client.latestPage = async page => { h.pages.push(page); return [{ threadId: '900', title: 'Other', version: '1.0', updatedAt: NOW - 86400000 }]; };
  let result = await h.run(); assert.deepEqual(h.pages, [1]); assert.equal(result.stopReason, 'saved-date-boundary'); assert.equal(h.calls.length, 1);
  const unknown = harness([linked(1, { versionVerifiedAt: NOW })]); unknown.store.data.checkpoints[ORIGIN] = { revision: 2, head: ['old'], at: NOW - 1000 };
  unknown.client.latestPage = async page => { unknown.pages.push(page); return [{ threadId: String(page + 900), title: 'Other', version: '1.0', timestamp: NOW - 90 * 86400000 }]; };
  result = await unknown.run(); assert.deepEqual(unknown.pages, [1, 2, 3]); assert.equal(result.stopReason, 'pagination-budget');
});
test('missing a rolling retention window requires one catch-up instead of silently missing older updates', async () => {
  const h = harness([linked(1, { versionVerifiedAt: NOW })]); h.client.windowDays = 7;
  h.store.data.checkpoints[ORIGIN] = { revision: 2, head: ['expired'], at: NOW - 30 * 86400000 };
  const result = await h.run(); assert.equal(result.stopReason, 'expired-listing-window'); assert.equal(result.verified, 1); assert.deepEqual(h.pages, [1]); assert.equal(result.checkpointAdvanced, true);
});
test('duplicate copies of one anchor cannot prematurely end an incremental scan', async () => {
  const h = harness([linked(1, { versionVerifiedAt: NOW })]), anchor = id => ({ threadId: String(id), title: 'Anchor ' + id, version: '1.0' });
  h.store.data.checkpoints[ORIGIN] = { revision: 2, head: [anchor(900), anchor(901)].map(feedFingerprint), at: NOW - 1000 };
  h.client.latestPage = async page => { h.pages.push(page); return page === 1 ? [anchor(900), anchor(800)] : page === 2 ? [anchor(900), anchor(801)] : [anchor(901)]; };
  const result = await h.run(); assert.deepEqual(h.pages, [1, 2, 3]); assert.equal(result.stopReason, 'previous-checkpoint'); assert.equal(h.calls.length, 0);
});
test('conflicting feed versions require thread verification and unchanged polls do not repeat it', async () => {
  const h = harness([linked(1, { versionVerifiedAt: NOW })]), anchors = [{ threadId: '900', title: 'A', version: '1.0' }, { threadId: '901', title: 'B', version: '1.0' }];
  h.store.data.checkpoints[ORIGIN] = { revision: 2, head: anchors.map(feedFingerprint), at: NOW - 1000 };
  h.client.latestPage = async () => [{ threadId: '1', title: 'Game 1', version: '2.0', timestamp: 100 }, { threadId: '1', title: 'Game 1', version: '1.0', timestamp: 200 }, ...anchors];
  h.releases['1'] = '2.0'; let result = await h.run(); assert.equal(result.verified, 1); assert.equal(h.store.data.games[0].latestVersion, '2.0');
  h.calls.length = 0; result = await h.run(); assert.equal(result.verified, 0); assert.equal(h.calls.length, 0);
});
test('a feed ahead of its thread retains the checkpoint and retries the unverified release', async () => {
  const h = harness([linked(1, { versionVerifiedAt: NOW })]), anchor = { threadId: '900', title: 'A', version: '1.0' };
  const old = { revision: 2, head: [feedFingerprint(anchor)], at: NOW - 1000 }; h.store.data.checkpoints[ORIGIN] = old;
  h.client.latestPage = async () => [{ threadId: '1', title: 'Game 1', version: '2.0' }, anchor];
  let result = await h.run(); assert.match(result.error, /newer release than the thread/); assert.equal(result.checkpointAdvanced, false); assert.deepEqual(h.store.data.checkpoints[ORIGIN], old);
  h.releases['1'] = '2.0'; result = await h.run(); assert.equal(result.checkpointAdvanced, true); assert.equal(h.store.data.games[0].latestVersion, '2.0');
});
test('pagination recovery cannot advance a checkpoint when game verification fails', async () => {
  const h = harness([linked(1, { versionVerifiedAt: NOW })]), old = { revision: 2, head: ['lost frontier'], at: NOW - 1000 };
  h.store.data.checkpoints[ORIGIN] = old;
  h.client.latestPage = async page => [{ threadId: String(900 + page), title: 'Other', version: '1.0' }]; h.releases['1'] = new Error('HTTP 503');
  const result = await h.run({ maxPages: 2 }); assert.equal(result.failed, 1); assert.equal(result.checkpointAdvanced, false); assert.deepEqual(h.store.data.checkpoints[ORIGIN], old);
});
test('only explicit release-update dates are eligible for the scan date boundary', () => {
  const rows = parseLatestHtml('<main><article class="game-card"><a href="/threads/first.1/">First</a><time data-time="1700000000"></time></article><article class="game-card" data-updated-at="1799990000"><a href="/threads/second.2/">Second</a></article><article class="game-card"><a href="/threads/third.3/">Third</a><time itemprop="dateModified" datetime="2026-11-08T00:00:00Z"></time></article></main>', ORIGIN);
  assert.equal(rows[0].updatedAt, 0); assert.equal(rows[1].updatedAt, 1799990000000); assert.equal(rows[2].updatedAt, Date.parse('2026-11-08T00:00:00Z'));
  const json = parseLatest({ data: [{ id: 1, date: 1700000000 }, { id: 2, updated_at: 1799990000 }] });
  assert.equal(json[0].updatedAt, 0); assert.equal(json[1].updatedAt, 1799990000000);
});

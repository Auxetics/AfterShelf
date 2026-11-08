import test from 'node:test';
import assert from 'node:assert/strict';
import { threadReference, parseThread, parseLatest, matchExitTitle, popupAllowed, siteOrigin, latestPerThread } from '../app/core/site.mjs';
import { detectEngine, DEFAULT_SITE, newGame, hasUpdate, canInstallArchive } from '../app/core/model.mjs';

test('thread IDs are stable across slug changes and cannot cross sites', () => {
  assert.equal(threadReference('https://f95zone.to/threads/the-programmer-v1-0.321809/', DEFAULT_SITE.origin).threadId, '321809');
  assert.equal(threadReference('/threads/321809/', DEFAULT_SITE.origin).threadId, '321809');
  assert.throws(() => threadReference('https://other.test/threads/game.321809/', DEFAULT_SITE.origin));
  assert.throws(() => threadReference('https://f95zone.to/dl/22149368/', DEFAULT_SITE.origin));
  assert.throws(() => siteOrigin('file:///private/tmp'));
});
test('XenForo thread fixture extracts tags, version, and stable identity', () => {
  const result = parseThread(`<h1 class="p-title-value"><span class="label">Ren'Py</span> The Programmer [v1.0] [SyntheVeil]</h1><div class="message-body">Version: 1.0\nA story about a programmer.</div>`, 'https://f95zone.to/threads/the-programmer.321809/', DEFAULT_SITE.origin);
  assert.equal(result.engine, 'renpy'); assert.equal(result.threadId, '321809'); assert.equal(result.latestVersion, '1.0'); assert.equal(result.title, 'The Programmer');
  assert.throws(() => parseThread('<form action="/login/login"></form>', 'https://f95zone.to/threads/1/', DEFAULT_SITE.origin), /sign in/);
});
test('engine detection distinguishes RPG Maker versions and Unity subtypes', () => {
  assert.equal(detectEngine('RPG Maker VX Ace'), 'rpgvxa'); assert.equal(detectEngine('RPG Maker MV'), 'rpgmv');
  assert.equal(detectEngine('Unity Naninovel'), 'naninovel'); assert.equal(detectEngine('Ren’Py'), 'renpy');
});
test('feed parsing accepts epoch seconds and rejects an error payload', () => {
  const entries = parseLatest({ msg: { data: [{ thread_id: 7, version: 'Chapter 2', ts: 1700000000 }, { thread_id: 9, version: '1.2', ts: 1700000100 }] } });
  assert.equal(entries[0].timestamp, 1700000000000);
  assert.throws(() => parseLatest({ status: 'error', msg: 'Login required' }));
});
test('duplicate exit-page titles do not pick a random game; versions remain separate', () => {
  const first = newGame({ origin: DEFAULT_SITE.origin, threadId: '1', title: 'Same game', latestVersion: '2.0' });
  const second = newGame({ origin: DEFAULT_SITE.origin, threadId: '2', title: 'Same game', latestVersion: '2.0' });
  assert.equal(matchExitTitle('Same game', [first, second], DEFAULT_SITE.origin), null);
  assert.equal(hasUpdate(first), false); first.installedVersion = '1.0'; assert.equal(hasUpdate(first), true);
});
test('popup rules allow provider tabs while blocking known ads and non-web protocols', () => {
  assert.equal(popupAllowed('https://f95zone.to/dl/2/', DEFAULT_SITE), true);
  assert.equal(popupAllowed('https://popads.net/x', DEFAULT_SITE), false);
  assert.equal(popupAllowed('https://sub.popads.net/x', DEFAULT_SITE), false);
  assert.equal(popupAllowed('https://new-host.test/x', DEFAULT_SITE), true);
  assert.equal(popupAllowed('file:///etc/passwd', DEFAULT_SITE), false);
  assert.equal(popupAllowed('javascript:alert(1)', DEFAULT_SITE), false);
});
test('overlapping feed pages cannot replace a newer release with an older duplicate', () => {
  const rows = [
    { threadId: '1', version: '2.0', timestamp: 200 },
    { threadId: '2', version: 'Chapter 3', timestamp: 250 },
    { threadId: '1', version: '1.9', timestamp: 100 }
  ];
  assert.equal(latestPerThread(rows).find(row => row.threadId === '1').version, '2.0');
  assert.equal(latestPerThread([...rows].reverse()).find(row => row.threadId === '1').version, '2.0');
});
test('version-prefix differences do not produce false update alerts', () => {
  assert.equal(hasUpdate({ installedVersion: 'v1.0', latestVersion: '1.0' }), false);
  assert.equal(hasUpdate({ installedVersion: 'Chapter 1', latestVersion: 'Chapter 2' }), true);
  assert.equal(parseLatest({ data: [{ id: 1, version: 'v1.2' }] })[0].version, '1.2');
});
test('partial or cancelled downloads cannot enter any assisted-install path', () => {
  for (const status of ['failed', 'cancelled', 'downloading', 'installed', 'installing']) assert.equal(canInstallArchive({ status, path: '/tmp/partial.zip' }), false);
  assert.equal(canInstallArchive({ status: 'downloaded', path: '/tmp/complete.zip' }), true);
  assert.equal(canInstallArchive({ status: 'awaiting-folder', path: '/tmp/complete.zip' }), true);
  assert.equal(canInstallArchive({ status: 'downloaded', path: '/tmp/complete.zip', archiveRemoved: true }), false);
});

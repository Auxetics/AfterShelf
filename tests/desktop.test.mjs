import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { profileDirectory, availableUpdateCount, syncDockBadge } from '../app/core/desktop.mjs';

test('AfterShelf reuses existing library and login profiles and honours isolated overrides', () => {
  const data = path.resolve('fixture-app-data');
  assert.equal(profileDirectory(data, () => true, {}), path.join(data, 'LC Library'));
  assert.equal(profileDirectory(data, () => false, {}), path.join(data, 'AfterShelf'));
  assert.equal(profileDirectory(data, () => true, { AFTERSHELF_DATA: 'isolated', LC_LIBRARY_DATA: 'old-override' }), path.resolve('isolated'));
  assert.equal(profileDirectory(data, () => true, { LC_LIBRARY_DATA: 'old-override' }), path.resolve('old-override'));
});

test('Dock badge counts newer releases for installed linked games, not the library inventory', () => {
  const game = { installation: { root: '/fixture/game' }, threadId: '1', threadUrl: 'https://forum.test/threads/1/', installedVersion: '1.0', latestVersion: '1.0' };
  const games = [game, { ...game, installedVersion: '2.0' }, { ...game, installedVersion: '' }, { ...game, latestVersion: 'Chapter 2' }, { ...game, installation: null, latestVersion: '2.0' }, { ...game, threadId: '', latestVersion: '2.0' }];
  const badges = [], app = { dock: { setBadge: text => badges.push(text) } };
  assert.equal(availableUpdateCount(games), 0); syncDockBadge(app, games, 'darwin');
  const updated = { ...game, latestVersion: '2.0' }; games.push(updated);
  assert.equal(syncDockBadge(app, games, 'darwin'), 1);
  updated.installedVersion = '2.0'; assert.equal(syncDockBadge(app, games, 'darwin'), 0);
  assert.deepEqual(badges, ['', '1', '']);
  syncDockBadge(app, games, 'win32'); assert.equal(badges.length, 3);
});

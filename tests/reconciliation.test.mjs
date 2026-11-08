import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectLibraryPresence, applyLibraryPresence, archiveMatchesInstalled } from '../app/core/reconciliation.mjs';
import { discoverGames } from '../app/core/discovery.mjs';
import { canLaunchGame, isInstalled } from '../app/core/model.mjs';

async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aftershelf-presence-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
async function file(root, relative, content = 'fixture') { const target = path.join(root, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content); return target; }
test('startup presence checks mark removed games not installed while retaining their thread, paths and metadata', async t => {
  const root = await fixture(t), launch = await file(root, 'Example/index.html');
  const game = { id: 'known', title: 'Example', threadId: '123', threadUrl: 'https://forum.test/threads/123/', installedVersion: '1.0', installation: { root: path.dirname(launch), launch }, previous: [] };
  const state = { games: [game] }; applyLibraryPresence(state, await inspectLibraryPresence(state.games, root)); assert.equal(canLaunchGame(game), true);
  await fs.rm(path.dirname(launch), { recursive: true }); applyLibraryPresence(state, await inspectLibraryPresence(state.games, root));
  assert.equal(isInstalled(game), false); assert.equal(canLaunchGame(game), false); assert.equal(game.threadId, '123'); assert.equal(game.installedVersion, '1.0'); assert.equal(game.installation.launch, launch);
  await file(root, 'Example/index.html'); applyLibraryPresence(state, await inspectLibraryPresence(state.games, root)); assert.equal(canLaunchGame(game), true);
});
test('offline games roots are distinct from deleted games and recover when reconnected', async t => {
  const parent = await fixture(t), root = path.join(parent, 'drive'), launch = await file(root, 'Example/index.html');
  const state = { games: [{ id: 'known', installation: { root: path.dirname(launch), launch } }] };
  await fs.rename(root, path.join(parent, 'offline')); const result = await inspectLibraryPresence(state.games, root); applyLibraryPresence(state, result);
  assert.equal(result.rootAvailable, false); assert.equal(state.games[0].availability.status, 'offline'); assert.equal(canLaunchGame(state.games[0]), false); assert.equal(isInstalled(state.games[0]), true);
  await fs.rename(path.join(parent, 'offline'), root); applyLibraryPresence(state, await inspectLibraryPresence(state.games, root)); assert.equal(canLaunchGame(state.games[0]), true);
});
test('a stale scan cannot overwrite a different installation committed during the scan', async t => {
  const root = await fixture(t), game = { id: 'known', installation: { root: path.join(root, 'old'), launch: path.join(root, 'old/run') } };
  const result = await inspectLibraryPresence([game], root); game.installation = { root: root, launch: 'new' }; game.availability = { status: 'available' };
  applyLibraryPresence({ games: [game] }, result); assert.equal(game.availability.status, 'available');
});
test('same-name installed archives are hidden without hiding new releases from Downloads or deleting anything', async t => {
  const root = await fixture(t), launch = await file(root, 'Example/index.html'), zip = await file(root, 'Example-1.0-mac.zip', 'keep archive');
  const games = [{ title: 'Example', installation: { root: path.dirname(launch), launch } }];
  const result = await discoverGames(root, { installedGames: games, existing: [path.dirname(launch)] });
  assert.equal(result.candidates.some(item => item.kind === 'archive'), false); assert.equal(await fs.readFile(zip, 'utf8'), 'keep archive');
  assert.equal(archiveMatchesInstalled('Other.zip', games), false); games[0].availability = { status: 'missing' };
  assert.equal(archiveMatchesInstalled('Example-1.0-mac.zip', games), false);
});
test('an archive with the same name as a pending game is not treated as an installed game', () => {
  assert.equal(archiveMatchesInstalled('Example.zip', [{ title: 'Example', installation: null }]), false);
});
test('documentation wrappers do not become HTML games or conceal extracted Windows games', async t => {
  const root = await fixture(t); await file(root, 'Release/Readme.html'); await file(root, 'Release/Example/Game.exe'); await file(root, 'Release/Example/renpy/runtime.txt'); await file(root, 'Release/Example/game/options.rpy', 'define config.name = "Example"');
  const result = await discoverGames(root, { platform: 'win32' }); assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].engine, 'renpy'); assert.equal(result.candidates[0].title, 'Example');
});

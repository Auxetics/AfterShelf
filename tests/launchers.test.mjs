import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { detectLauncher } from '../app/core/launchers.mjs';
import { inspectInstallation } from '../app/core/saves.mjs';
import { checkInstalledVersion } from '../app/core/install-version.mjs';

async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aftershelf-launcher-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const file of files) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), 'fixture'); }
  return root;
}
test('macOS automatically selects the app instead of its readme, shell helpers or bundled executable', async t => {
  const root = await fixture(t, ['Example.APP/Contents/Info.plist', 'Example.APP/Contents/Resources/autorun/game/options.rpy', 'Example.APP/Contents/MacOS/game.sh', 'Readme.html']);
  const result = await detectLauncher(root, await inspectInstallation(root, 'renpy'), { platform: 'darwin', title: 'Example' });
  assert.equal(result.launch, path.join(root, 'Example.APP')); assert.equal(result.root, result.launch);
});
test('Windows RenPy selects the matching architecture without confusing its runtime and documentation for launchers', async t => {
  const root = await fixture(t, ['Example.exe', 'Example-32.exe', 'renpy/runtime.exe', 'game/options.rpy', 'manual.html', 'Uninstall.exe']);
  const info = await inspectInstallation(root, 'renpy');
  assert.equal((await detectLauncher(root, info, { platform: 'win32', arch: 'x64', title: 'Example' })).launch, path.join(root, 'Example.exe'));
  assert.equal((await detectLauncher(root, info, { platform: 'win32', arch: 'ia32', title: 'Example' })).launch, path.join(root, 'Example-32.exe'));
});
test('Unity selects the player with matching game data instead of an unrelated executable', async t => {
  const root = await fixture(t, ['Example.exe', 'Example_Data/globalgamemanagers', 'UnityPlayer.dll', 'Other.exe', 'UnityCrashHandler64.exe']);
  const result = await detectLauncher(root, await inspectInstallation(root, 'unity'), { platform: 'win32' });
  assert.equal(result.launch, path.join(root, 'Example.exe'));
});
test('RPG Maker selects Game.exe and HTML games select index.html without a picker', async t => {
  let root = await fixture(t, ['Game.exe', 'nw.exe', 'www/index.html', 'www/js/rmmz_core.js']);
  assert.equal((await detectLauncher(root, await inspectInstallation(root, 'rpgmz'), { platform: 'win32' })).launch, path.join(root, 'Game.exe'));
  root = await fixture(t, ['index.html', 'Readme.html', 'docs/manual.html']);
  assert.equal((await detectLauncher(root, await inspectInstallation(root, 'html'), { platform: 'darwin' })).launch, path.join(root, 'index.html'));
});
test('Godot prefers the game over its console executable', async t => {
  const root = await fixture(t, ['Example.exe', 'Example.console.exe', 'Example.pck']);
  assert.equal((await detectLauncher(root, await inspectInstallation(root, 'godot'), { platform: 'win32' })).launch, path.join(root, 'Example.exe'));
});
test('unresolved or incompatible releases report detection failure instead of choosing by file order', async t => {
  const root = await fixture(t, ['First.exe', 'Second.exe']);
  const info = await inspectInstallation(root, 'custom');
  assert.equal((await detectLauncher(root, info, { platform: 'win32' })).launch, '');
  assert.equal((await detectLauncher(root, info, { platform: 'darwin' })).launch, '');
});
test('install version checks distinguish local proof, mismatches and missing evidence', () => {
  assert.equal(checkInstalledVersion({ version: 'v1.0' }, '1.0.0').status, 'matched');
  assert.equal(checkInstalledVersion({ version: '1.0' }, '2.0').status, 'mismatch');
  assert.equal(checkInstalledVersion({ version: 'Chapter 1' }, 'Chapter 2').status, 'mismatch');
  assert.equal(checkInstalledVersion({ version: '' }, '2.0').status, 'unverified');
  assert.equal(checkInstalledVersion({ version: '1.0' }, '').status, 'unverified');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { savePlan, transferSaves } from '../app/core/saves.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-rpg-saves-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const old = path.join(root, 'old'), fresh = path.join(root, 'new');
  await fs.mkdir(old); await fs.mkdir(fresh);
  return { old, fresh };
}
async function file(root, relative, content) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

for (const [engine, contentRoot, extension, core] of [
  ['rpgmv', 'www', 'rpgsave', 'rpg_core.js'],
  ['rpgmv', '', 'rpgsave', 'rpg_core.js'],
  ['rpgmz', '', 'rmmzsave', 'rmmz_core.js'],
  ['rpgmz', 'www', 'rmmzsave', 'rmmz_core.js'],
  ['rpgmv', 'Contents/Resources/app.nw', 'rpgsave', 'rpg_core.js'],
  ['rpgmz', 'Contents/Resources/app.nw', 'rmmzsave', 'rmmz_core.js']
]) test(`${engine} transfers the complete save set from ${contentRoot || 'the game root'} without old program files`, async t => {
  const { old, fresh } = await fixture(t), saves = path.join(contentRoot, 'save');
  await file(old, path.join(contentRoot, 'js', core), 'OLD RUNTIME');
  await file(fresh, path.join(contentRoot, 'js', core), 'NEW RUNTIME');
  await file(old, 'Game.ini', 'OLD LAUNCH SETTINGS'); await file(fresh, 'Game.ini', 'NEW LAUNCH SETTINGS');
  const data = {
    [`file1.${extension}`]: 'progress', [`global.${extension}`]: 'slot index',
    [`config.${extension}`]: 'preferences', [`nested/file2.${extension}.bak`]: 'existing game backup'
  };
  for (const [name, value] of Object.entries(data)) await file(old, path.join(saves, name), value);
  await file(fresh, path.join(saves, `file1.${extension}`), 'bundled default');
  const plan = await savePlan(old, engine);
  assert.equal(plan.local.length, 4);
  assert.equal(plan.local.filter(item => item.kind === 'preferences').length, 1);
  assert.equal(await transferSaves(plan, old, fresh), 4);
  for (const [name, value] of Object.entries(data)) {
    assert.equal(await fs.readFile(path.join(fresh, saves, name), 'utf8'), value);
    assert.equal(await fs.readFile(path.join(old, saves, name), 'utf8'), value);
  }
  assert.equal(await fs.readFile(path.join(fresh, contentRoot, 'js', core), 'utf8'), 'NEW RUNTIME');
  assert.equal(await fs.readFile(path.join(fresh, 'Game.ini'), 'utf8'), 'NEW LAUNCH SETTINGS');
});

for (const [engine, name] of [
  ['rpgxp', 'Save1.rxdata'], ['rpgvx', 'Save1.rvdata'],
  ['rpgvxa', 'Save01.rvdata2'], ['rpg2k', 'Save01.lsd']
]) test(`${engine} transfers its root-level save files without old game data`, async t => {
  const { old, fresh } = await fixture(t);
  await file(old, name, 'progress');
  await file(old, 'Game.ini', 'OLD PROGRAM CONFIG'); await file(fresh, 'Game.ini', 'NEW PROGRAM CONFIG');
  await file(old, 'Data/Actors.rxdata', 'OLD DATABASE'); await file(fresh, 'Data/Actors.rxdata', 'NEW DATABASE');
  const plan = await savePlan(old, engine);
  assert.deepEqual(plan.local.map(item => item.relative), [name]);
  assert.equal(await transferSaves(plan, old, fresh), 1);
  assert.equal(await fs.readFile(path.join(fresh, name), 'utf8'), 'progress');
  assert.equal(await fs.readFile(path.join(old, name), 'utf8'), 'progress');
  assert.equal(await fs.readFile(path.join(fresh, 'Game.ini'), 'utf8'), 'NEW PROGRAM CONFIG');
  assert.equal(await fs.readFile(path.join(fresh, 'Data/Actors.rxdata'), 'utf8'), 'NEW DATABASE');
});

test('RPG Maker updates with missing or empty local save locations need no transfer or external-save discovery', async t => {
  for (const engine of ['rpgmv', 'rpgmz', 'rpgxp', 'rpgvx', 'rpgvxa', 'rpg2k']) {
    for (const emptyFolders of [false, true]) {
      const { old, fresh } = await fixture(t);
      if (emptyFolders) for (const folder of ['save', 'www/save', 'Save']) await fs.mkdir(path.join(old, folder), { recursive: true });
      const plan = await savePlan(old, engine);
      assert.equal(plan.local.length, 0);
      assert.equal(plan.status, 'expected-external/no-local-data');
      assert.deepEqual(plan.predicted, []);
      assert.equal(await transferSaves(plan, old, fresh), 0);
      assert.deepEqual(await fs.readdir(fresh), []);
    }
  }
});

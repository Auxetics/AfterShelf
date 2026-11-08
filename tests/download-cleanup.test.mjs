import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { removePartialDownload } from '../app/core/download-cleanup.mjs';
import { manualInstallReason } from '../app/core/install-policy.mjs';

async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aftershelf-partial-')); t.after(() => fs.rm(root, { recursive: true, force: true })); const file = path.join(root, 'release.zip'); await fs.writeFile(file, 'partial'); return { root, file }; }
test('only failed/cancelled app-managed partial files are removed', async t => {
  const { root, file } = await fixture(t);
  for (const status of ['downloading', 'downloaded', 'installed']) assert.equal(await removePartialDownload({ status, path: file, managedDownload: true }, { gamesRoot: root }), false);
  assert.equal(await removePartialDownload({ status: 'failed', path: file }, { gamesRoot: root }), false);
  assert.equal(await fs.readFile(file, 'utf8'), 'partial');
  assert.equal(await removePartialDownload({ status: 'failed', path: file, managedDownload: true }, { gamesRoot: root }), true);
  await assert.rejects(fs.access(file));
  assert.equal(await removePartialDownload({ status: 'cancelled', path: file, managedDownload: true }, { gamesRoot: root }), true);
});
test('partial cleanup cannot remove an installed game file or another completed archive', async t => {
  const { root, file } = await fixture(t), job = { id: 'failed', status: 'failed', path: file, managedDownload: true };
  await assert.rejects(removePartialDownload(job, { gamesRoot: root, games: [{ installation: { root } }] }), /installed game/);
  await assert.rejects(removePartialDownload(job, { gamesRoot: root, downloads: [{ id: 'done', status: 'downloaded', path: file }] }), /completed download/);
  assert.equal(await fs.readFile(file, 'utf8'), 'partial');
});
test('cleanup refuses paths outside the root, symlinks and directories', async t => {
  const a = await fixture(t), b = await fixture(t), job = { status: 'failed', path: b.file, managedDownload: true };
  await assert.rejects(removePartialDownload(job, { gamesRoot: a.root }), /outside/);
  const link = path.join(a.root, 'linked.zip'); await fs.symlink(b.file, link);
  await assert.rejects(removePartialDownload({ ...job, path: link }, { gamesRoot: a.root }), /Symbolic links/);
  await fs.mkdir(path.join(a.root, 'folder'));
  await assert.rejects(removePartialDownload({ ...job, path: path.join(a.root, 'folder') }, { gamesRoot: a.root }), /incomplete downloaded file/);
  assert.equal(await fs.readFile(b.file, 'utf8'), 'partial');
});
test('known profiles remain available and unknown engines/patches stay manual', () => {
  for (const engine of ['renpy', 'rpgmv', 'rpgmz', 'unity', 'godot', 'unreal', 'wolf', 'html']) assert.equal(manualInstallReason({ filename: 'Full-release.zip' }, engine), '');
  assert.match(manualInstallReason({ filename: 'Full.zip' }, 'custom'), /Unknown engines/);
  assert.match(manualInstallReason({ filename: 'Example-patch-1.2.zip' }, 'renpy'), /Patches/);
  assert.equal(manualInstallReason({ filename: 'Patchwork-1.2.zip' }, 'renpy'), '');
});

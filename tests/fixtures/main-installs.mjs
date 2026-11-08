import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { initialState, newGame } from '../../app/core/model.mjs';
import { zipFixture } from './zip.mjs';
import { createServer } from 'node:http';

export async function checkMainInstalls() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aftershelf-main-sources-installs-'));
  const requests = [];
  const release = (title, version) => process.platform === 'darwin' ? [
    [`Release/${title}.app/Contents/Info.plist`, `<plist><dict><key>CFBundleName</key><string>${title}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`],
    [`Release/${title}.app/Contents/Resources/autorun/game/options.rpy`, `define config.name = "${title}"\ndefine config.version = "${version}"`],
    [`Release/${title}.app/Contents/MacOS/launch.sh`, '#!/bin/sh', 0o100755], ['Release/Readme.html', 'documentation']
  ] : [[`Release/${title}.exe`, 'launcher'], ['Release/renpy/runtime.txt', 'runtime'], ['Release/game/options.rpy', `define config.name = "${title}"\ndefine config.version = "${version}"`], ['Release/Readme.html', 'documentation']];
  const promptArchive = zipFixture(release('Prompt', '2.0'));
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/download/Prompt.zip') { res.setHeader('Content-Disposition', 'attachment; filename="Prompt.zip"'); res.end(promptArchive); return; }
    if (req.url.includes('.1002/')) { res.writeHead(503); res.end('Fixture temporarily unavailable'); return; }
    const title = req.url.includes('.1001/') ? 'Mismatch' : 'Prompt';
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>Fixture ${title}</title><h1 class="p-title-value"><span class="label">RenPy</span> ${title} [v2.0]</h1><article class="message-threadStarterPost"><div class="message-body">Developer: Fixture Creator<br>Version: 2.0<br>Fixture overview.</div></article><a id="download" href="/download/Prompt.zip">Download</a>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const state = initialState();
    await fs.mkdir(path.join(directory, 'games'));
    const root = await fs.realpath(path.join(directory, 'games'));
    Object.assign(state.settings, { setupCompleted: true, gamesRoot: root, downloadMode: 'assisted' });
    // Every configured origin is a disposable loopback fixture.
    for (const source of Object.values(state.settings.sources)) source.origin = origin;
    state.settings.site = { ...state.settings.sources.f95 };
    for (const id of ['external', 'resume', 'zip']) {
      state.games.push(newGame({ id, origin, title: id, engine: 'renpy', threadId: '', threadUrl: '' }));
      const archive = path.join(root, `${id}.${id === 'zip' ? 'zip' : 'rar'}`);
      await fs.writeFile(archive, id === 'zip' ? zipFixture([['Release/a.html', 'new code'], ['Release/b.html', 'new code']]) : 'fixture archive');
      state.downloads.push({ id, gameId: id, path: archive, filename: path.basename(archive), status: id === 'resume' ? 'awaiting-folder' : 'downloaded', version: '2.0', archiveRemoved: false });
      if (id !== 'zip') {
        await fs.mkdir(path.join(root, id), { recursive: true });
        await fs.writeFile(path.join(root, id, 'index.html'), 'new release');
      }
    }
    state.games.push(newGame({ id: 'prompt', origin, title: 'Prompt', engine: 'custom', threadId: '1000', threadUrl: origin + '/threads/prompt.1000/', latestVersion: '1.0' }));
    for (const [id, threadId, version] of [['button', '', '2.0'], ['mismatch', '1001', '1.0'], ['offline', '1002', '1.0']]) {
      state.games.push(newGame({ id, origin, title: id, engine: 'renpy', threadId, threadUrl: threadId ? `${origin}/threads/${id}.${threadId}/` : '', latestVersion: '1.0' }));
      const archive = path.join(root, `${id}.zip`);
      await fs.writeFile(archive, zipFixture(release(id, version)));
      state.downloads.push({ id, gameId: id, path: archive, filename: path.basename(archive), status: 'downloaded', version: '1.0', archiveRemoved: false });
    }
    // Exercise save-only transfer when finishing an already-extracted update.
    const old = path.join(root, 'old-resume');
    await fs.mkdir(path.join(old, 'game', 'saves'), { recursive: true });
    await fs.writeFile(path.join(old, 'game', 'saves', 'slot.save'), 'saved progress');
    await fs.writeFile(path.join(old, 'index.html'), 'old code');
    state.games.find(game => game.id === 'resume').installation = { root: old, container: old, launch: path.join(old, 'index.html'), managed: false };
    state.games.push(newGame({ id: 'missing', origin, title: 'Missing fixture', engine: 'renpy', threadId: '', threadUrl: '', installation: { root: path.join(root, 'removed-game'), launch: path.join(root, 'removed-game', 'run'), managed: false } }));
    const detected = process.platform === 'darwin' ? path.join(root, 'Detected.app') : path.join(root, 'Detected');
    const content = process.platform === 'darwin' ? path.join(detected, 'Contents', 'Resources', 'autorun') : detected;
    await fs.mkdir(path.join(content, 'game'), { recursive: true }); await fs.mkdir(path.join(content, 'renpy'), { recursive: true });
    await fs.writeFile(path.join(content, 'game', 'options.rpy'), 'define config.name = "Detected fixture"');
    if (process.platform === 'darwin') await fs.writeFile(path.join(detected, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleName</key><string>Detected fixture</string></dict></plist>');
    else await fs.writeFile(path.join(detected, 'Game.exe'), 'fixture');
    const partial = path.join(root, 'interrupted.zip'); await fs.writeFile(partial, 'incomplete bytes');
    state.downloads.push({ id: 'partial', gameId: 'prompt', path: partial, filename: 'interrupted.zip', managedDownload: true, status: 'cancelled', archiveRemoved: false });
    await fs.writeFile(path.join(directory, 'library.json'), JSON.stringify(state));
    const entry = fileURLToPath(new URL('../electron-main-installs-smoke.mjs', import.meta.url));
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry], { env: { ...process.env, AFTERSHELF_DATA: directory }, stdio: ['ignore', 'inherit', 'inherit'] });
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Main installation fixture exited with ${code}.`)));
    });
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'library.json'), 'utf8'));
    assert.equal(saved.games.length, 9);
    assert.ok(saved.games.every(game => game.installation?.launch));
    assert.ok(saved.downloads.filter(job => job.id !== 'partial').every(job => job.status === 'installed' && job.archiveRemoved));
    assert.equal(saved.games.find(game => game.id === 'missing').availability.status, 'missing');
    assert.equal(saved.games.find(game => game.title === 'Detected fixture').discoveredLocally, true);
    assert.equal(saved.downloads.find(job => job.id === 'partial').partialRemoved, true); await assert.rejects(fs.access(partial));
    assert.equal(requests.filter(url => url === '/download/Prompt.zip').length, 1, 'recovery opens the forum thread instead of automatically retrying a provider download');
    assert.equal(await fs.readFile(path.join(root, 'resume', 'game', 'saves', 'slot.save'), 'utf8'), 'saved progress');
    assert.equal(await fs.readFile(path.join(root, 'resume', 'index.html'), 'utf8'), 'new release');
    assert.equal(await fs.readFile(path.join(old, 'game', 'saves', 'slot.save'), 'utf8'), 'saved progress');
    assert.equal((await fs.readdir(path.join(root, '.library', 'staging'))).length, 0);
    const prompt = saved.games.find(game => game.id === 'prompt');
    assert.equal(prompt.installedVersion, '2.0'); assert.equal(prompt.latestVersion, '2.0'); assert.equal(prompt.engine, 'renpy');
    assert.equal(prompt.creator, 'Fixture Creator'); assert.match(prompt.description, /Fixture overview/);
    assert.equal(prompt.installationCheck.status, 'matched');
    assert.equal(saved.games.find(game => game.id === 'button').installedVersion, '2.0', 'local release evidence overrides the old download label');
    const mismatch = saved.games.find(game => game.id === 'mismatch');
    assert.equal(mismatch.installedVersion, '1.0'); assert.equal(mismatch.latestVersion, '2.0'); assert.equal(mismatch.installationCheck.status, 'mismatch');
    assert.ok(saved.games.find(game => game.id === 'offline').installationCheck.metadataWarning.includes('503'));
    assert.equal(saved.games.find(game => game.id === 'offline').installationCheck.status, 'unverified');
    assert.ok(requests.some(url => url.includes('.1000/'))); assert.ok(requests.some(url => url.includes('.1001/')));
    console.log('PASS actual main installation, startup missing-game detection/discovery, partial cleanup and manual thread recovery (11 scenarios)');
  } finally { server.close(); await fs.rm(directory, { recursive: true, force: true }); }
}

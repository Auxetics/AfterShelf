// Exercise the actual main-process IPC wiring. Both configured forum origins
// are disposable loopback servers; this never opens the real sites/profile.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { initialState, newGame } from '../../app/core/model.mjs';

export async function checkMainSources() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aftershelf-main-sources-'));
  const servers = [], requests = [];
  async function serve(id, version) {
    const server = createServer((req, res) => {
      requests.push({ id, path: req.url });
      const pathname = new URL(req.url, 'http://fixture').pathname;
      if (pathname === '/feed') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ thread_id: 123, title: 'F95 Fixture', version }] })); }
      else if (pathname === '/latest-updates') {
        // Mimic a full 60-card listing that ignores its date/page filters.
        const cards = Array.from({ length: 60 }, (_, i) => `<div class="structItem"><div class="structItem-title"><a href="/threads/example.${i ? 500 + i : 123}/">LC Fixture ${i || ''} [v${version}]</a></div></div>`).join('');
        res.setHeader('Content-Type', 'text/html'); res.end(`<main id="games">Loading updates…</main><script>setTimeout(()=>{document.querySelector('#games').innerHTML=${JSON.stringify(cards)};window.open('/blocked-listing-popup');},75);</script>`);
      }
      else if (pathname.startsWith('/threads/')) { res.setHeader('Content-Type', 'text/html'); res.end(`<title>${id} Fixture</title><h1 class="p-title-value">${id} Fixture [v${version}]</h1><article class="message-threadStarterPost"><div class="message-body">Engine: Ren'Py</div></article>`); }
      else { res.setHeader('Content-Type', 'text/html'); res.end(`<title>${id} Fixture Forum</title><main>Local source fixture</main>`); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }
  const f95 = await serve('F95', '2.0'), lc = await serve('LC', '3.0');
  const state = initialState(); state.settings.setupCompleted = true;
  Object.assign(state.settings.sources.f95, { origin: f95, latestPath: '/feed?page={page}' });
  Object.assign(state.settings.sources.lc, { origin: lc, latestPath: '/latest-updates?page={page}&per_page=60&only_new_days=7' });
  state.settings.site = { ...state.settings.sources.f95 };
  for (const source of Object.values(state.settings.sources)) state.games.push(newGame({ origin: source.origin, threadId: '123', threadUrl: source.origin + '/threads/example.123/', title: source.shortName + ' Fixture', engine: 'renpy', latestVersion: '1.0', installedVersion: '1.0', installation: { root: path.join(directory, source.id), launch: path.join(directory, source.id, 'run') } }));
  await fs.writeFile(path.join(directory, 'library.json'), JSON.stringify(state));
  try {
    const entry = fileURLToPath(new URL('../electron-main-sources-smoke.mjs', import.meta.url));
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry], { env: { ...process.env, AFTERSHELF_DATA: directory }, stdio: ['ignore', 'inherit', 'inherit'] });
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Actual main-source fixture exited with ${code}.`)));
    });
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'library.json'), 'utf8'));
    assert.equal(saved.games.find(game => game.origin === f95).latestVersion, '2.0');
    assert.equal(saved.games.find(game => game.origin === lc).latestVersion, '3.0');
    assert.equal(saved.games.every(game => game.installedVersion === '1.0'), true);
    assert.equal(Object.keys(saved.checkpoints).length, 2);
    assert.equal(requests.filter(request => request.path.startsWith('/threads/')).length, 2);
    const listings = requests.filter(request => request.path.startsWith('/feed') || request.path.startsWith('/latest-updates'));
    assert.equal(listings.length, 9, 'three F95 JSON requests plus three LC HTML-and-rendered pairs');
    assert.ok(listings.every(request => new URL(request.path, 'http://fixture').searchParams.get('page') === '1'), 'baseline and unchanged checks never crawl beyond the first page');
    assert.equal(saved.sourceStatus.lc.listingMode, 'rendered');
    assert.equal(requests.some(request => request.path.startsWith('/blocked-listing-popup')), false);
    assert.equal(saved.downloads.length, 0);
    console.log('PASS actual main IPC parses the JS-populated LC fixture, blocks its popup, persists source-specific updates and opens both source tabs (1 scenario)');
  } finally {
    for (const server of servers) server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

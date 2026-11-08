// Native Chromium regression check. Uses only loopback fixtures and an isolated
// temporary profile, never the running app's forum session or live websites.
import { app, BrowserWindow, WebContentsView, session } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ForumBrowser } from '../app/browser.mjs';
import { initialState } from '../app/core/model.mjs';
import { checkRenderer } from './fixtures/renderer-downloads.mjs';
import { checkMetadataRedirects } from './fixtures/metadata-redirects.mjs';
import { syncDockBadge } from '../app/core/desktop.mjs';
import { checkMainSources } from './fixtures/main-sources.mjs';
import { checkMainInstalls } from './fixtures/main-installs.mjs';
import { checkRenderedListing } from './fixtures/rendered-listing.mjs';

app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'lc-popup-test-')));
app.commandLine.appendSwitch('disable-background-networking');
app.enableSandbox();
let browser, window, server;
const watchdog = setTimeout(() => { console.error('Native browser/renderer check timed out.'); app.exit(1); }, 60000);
process.on('uncaughtException', error => { console.error(error); app.exit(1); });

async function waitFor(condition) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await condition();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Expected popup fixture state was not reached.');
}
async function openPopup(source, script, title, opener = false) {
  const previous = new Set(browser.views.keys());
  await source.view.webContents.executeJavaScript(script, true);
  const tab = await waitFor(() => [...browser.views.values()].find(item => !previous.has(item.view.webContents.id)));
  await waitFor(() => tab.title === title && !tab.loading);
  const security = tab.view.webContents.getLastWebPreferences();
  assert.equal(security.sandbox, true);
  assert.equal(security.contextIsolation, true);
  assert.equal(security.nodeIntegration, false);
  assert.equal(security.webSecurity, true);
  assert.equal(await tab.view.webContents.executeJavaScript('Boolean(window.opener)'), opener);
  return tab;
}

async function run() {
try {
  console.log('Starting isolated native popup fixture…');
  server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/post') {
      let body = ''; for await (const chunk of request) body += chunk;
      response.end(`<title>POST popup</title><p id="method">${request.method}</p><p id="body">${body}</p>`);
    } else if (request.url === '/child') response.end('<title>Link popup</title><a id="nested" target="_blank" href="/nested">Nested</a>');
    else if (request.url === '/nested') response.end('<title>Nested popup</title>');
    else response.end('<title>Source fixture</title><a id="link" target="_blank" href="/child">Open game</a><form id="post" method="post" target="_blank" action="/post"><input name="token" value="fixture-value"></form>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  console.log('Electron ready; loading loopback fixture…');
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const store = { data: initialState(), log: async () => {} };
  browser = new ForumBrowser(window, store, () => {}, () => {}, { WebContentsView, session });
  browser.layout({ x: 0, y: 0, width: 800, height: 600 });
  await browser.open(`http://127.0.0.1:${server.address().port}/`, 'fixture-game');
  console.log('Source loaded; opening popup…');
  const source = browser.views.get(browser.activeId);
  const link = await openPopup(source, "document.querySelector('#link').click()", 'Link popup');
  assert.equal(browser.activeId, link.view.webContents.id);
  assert.equal(link.gameId, 'fixture-game');
  console.log('PASS native target=_blank link opens as an embedded tab');

  const nested = await openPopup(link, "document.querySelector('#nested').click()", 'Nested popup');
  assert.equal(nested.gameId, 'fixture-game');
  console.log('PASS nested popup retains download context and native noopener behavior');

  const post = await openPopup(source, "document.querySelector('#post').submit()", 'POST popup');
  assert.equal(await post.view.webContents.executeJavaScript("document.querySelector('#method').textContent"), 'POST');
  assert.equal(await post.view.webContents.executeJavaScript("document.querySelector('#body').textContent"), 'token=fixture-value');
  console.log('PASS native popup preserves form POST body');

  const blank = await openPopup(source, "window.fixtureChild = window.open('about:blank'); window.fixtureChild.document.write('<title>Scripted popup</title>'); window.fixtureChild.document.close(); true", 'Scripted popup', true);
  assert.equal(blank.view.webContents.getURL(), 'about:blank');
  console.log('PASS scripted blank popup stays connected to its opener');
  browser.close(blank.view.webContents.id);
  assert.equal(browser.views.has(blank.view.webContents.id), false);
  console.log('Native popup checks passed (4 scenarios).');
  const f95Origin = browser.store.data.settings.site.origin;
  const lcOrigin = 'https://lc.fixture.invalid';
  browser.store.data.settings.sources.lc.origin = lcOrigin;
  await browser.session.cookies.set({ url: f95Origin, name: 'fixture_source_login', value: 'F95 fixture' });
  await browser.session.cookies.set({ url: lcOrigin, name: 'fixture_source_login', value: 'LC fixture' });
  browser.createTab({ sourceId: 'lc' });
  await browser.logout('lc');
  assert.equal((await browser.session.cookies.get({ url: lcOrigin })).some(cookie => cookie.name === 'fixture_source_login'), false);
  assert.equal((await browser.session.cookies.get({ url: f95Origin })).some(cookie => cookie.name === 'fixture_source_login'), true);
  console.log('PASS native source-scoped logout clears LC cookies while retaining F95 login (1 scenario)');
  browser.destroy();
  await checkRenderer(BrowserWindow);
  console.log('Native renderer checks passed (10 scenarios).');
  if (process.platform === 'darwin') {
    const installed = { installation: { root: '/fixture/game' }, threadId: '1', threadUrl: 'https://forum.test/threads/1/', installedVersion: '1.0', latestVersion: '1.0' };
    syncDockBadge(app, [installed]); assert.equal(app.dock.getBadge(), '');
    installed.latestVersion = '2.0'; syncDockBadge(app, [installed]); assert.equal(app.dock.getBadge(), '1');
    installed.installedVersion = '2.0'; syncDockBadge(app, [installed]); assert.equal(app.dock.getBadge(), '');
    console.log('PASS native macOS Dock badge shows available updates and clears after installation (1 scenario)');
  }
  await checkMetadataRedirects();
  console.log('Native metadata transport/update checks passed (7 scenarios).');
  await checkRenderedListing(BrowserWindow, session);
  await checkMainSources();
  await checkMainInstalls();
  clearTimeout(watchdog);
  browser.destroy(); window.destroy(); server.close(); app.exit(0);
} catch (error) {
  console.error(error);
  clearTimeout(watchdog);
  browser?.destroy(); window?.destroy(); server?.close(); app.exit(1);
}
}
app.whenReady().then(run);

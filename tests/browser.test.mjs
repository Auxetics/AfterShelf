import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ForumBrowser } from '../app/browser.mjs';
import { initialState, gameKey } from '../app/core/model.mjs';

// These doubles exercise the browser controller without opening sites, reading
// cookies, or attaching to the user's logged-in Electron process.
function harness() {
  let nextId = 1;
  class Contents extends EventEmitter {
    constructor() { super(); this.id = nextId++; this.loads = []; this.url = ''; this.closed = false; this.navigationHistory = { canGoBack: () => this.loads.length > 1, canGoForward: () => false, goBack() {}, goForward() {} }; }
    setWindowOpenHandler(handler) { this.popup = handler; }
    async loadURL(url) { this.loads.push(url); this.url = url; this.emit('did-start-loading'); this.emit('did-navigate', {}, url); this.emit('did-stop-loading'); }
    getURL() { return this.url; }
    async executeJavaScript() { return this.html || '<h1 class="p-title-value"><span class="label">Ren’Py</span> Fixture Game [v1.2]</h1>'; }
    close() { const event = { prevented: false, preventDefault() { this.prevented = true; } }; this.emit('close', event); if (!event.prevented && !this.closed) { this.closed = true; this.emit('destroyed'); } }
    reload() { this.reloaded = true; }
  }
  class View { constructor(options) { this.options = options; this.webContents = options.webContents || new Contents(); } setBounds(bounds) { this.bounds = bounds; } }
  const forum = new EventEmitter(); forum.setPermissionRequestHandler = fn => { forum.permissions = fn; }; forum.setPermissionCheckHandler = fn => { forum.permissionCheck = fn; }; forum.webRequest = { onBeforeRequest(fn) { forum.filter = fn; } };
  forum.cleared = []; forum.clearStorageData = async options => forum.cleared.push(options);
  const children = new Set();
  const window = { getContentSize: () => [1200, 800], contentView: {
    addChildView(view) { assert.ok(!children.has(view), 'same native view should not attach twice'); children.add(view); },
    removeChildView(view) { assert.ok(children.has(view), 'only attached native views should detach'); children.delete(view); }
  } };
  const store = { data: initialState(), log: async () => {} }, messages = [], downloads = [];
  const browser = new ForumBrowser(window, store, state => messages.push(state), (item, id, thread) => downloads.push({ item, id, thread }), { WebContentsView: View, session: { fromPartition: partition => { assert.equal(partition, 'persist:forum'); return forum; } } });
  return { browser, store, forum, children, messages, downloads, Contents };
}
test('tabs detach/reappear without destroying their session or attaching twice', async () => {
  const { browser, children } = harness();
  await browser.open('https://forum.test/');
  const id = browser.activeId, tab = browser.views.get(id);
  assert.equal(children.size, 0);
  browser.layout({ x: 225, y: 70, width: 2000, height: 2000 });
  assert.deepEqual(tab.view.bounds, { x: 225, y: 70, width: 975, height: 730 });
  browser.layout({ x: 225, y: 70, width: 900, height: 600 });
  browser.layout(null); assert.equal(children.size, 0); assert.equal(tab.view.webContents.closed, false);
  browser.layout({ x: 225, y: 70, width: 900, height: 600 }); assert.equal(children.size, 1);
  browser.layout({ x: NaN, y: 0, width: 900, height: 600 }); assert.equal(children.size, 0);
});
test('closing a background tab leaves the foreground view attached', async () => {
  const { browser, children } = harness(); browser.layout({ x: 0, y: 0, width: 1000, height: 700 });
  await browser.open('https://forum.test/first'); const first = browser.activeId;
  await browser.open('https://forum.test/second', null, true); const second = browser.activeId;
  browser.close(first); assert.equal(browser.activeId, second); assert.equal(children.size, 1);
  browser.close(second); assert.equal(browser.activeId, null); assert.equal(children.size, 0);
});
test('popup requests are delegated to Chromium in secure tabs, not reissued as GET', async () => {
  const { browser, forum, Contents } = harness();
  const source = browser.createTab({ gameId: 'thread-A' });
  browser.createTab({ gameId: 'thread-B' }); const selected = browser.activeId;
  const response = source.view.webContents.popup({ url: 'https://provider.test/download', disposition: 'background-tab', postBody: { data: [{ bytes: Buffer.from('token=value') }] } });
  assert.equal(response.action, 'allow');
  const guest = new Contents();
  const contents = response.createWindow({ webContents: guest, webPreferences: { openerId: source.view.webContents.id, nodeIntegration: true, preload: '/untrusted.cjs', webSecurity: false } });
  const child = browser.views.get(contents.id);
  assert.equal(contents, guest, 'the view must adopt Electron’s supplied guest WebContents');
  assert.equal(child.view.options.webContents, guest);
  assert.equal(response.overrideBrowserWindowOptions.webPreferences.session, forum);
  assert.equal(response.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false);
  assert.equal(response.overrideBrowserWindowOptions.webPreferences.sandbox, true);
  assert.equal(contents.loads.length, 0, 'Electron must execute the original popup request');
  assert.equal(child.gameId, 'thread-A'); assert.equal(browser.activeId, selected);
  assert.equal(child.view.options.webPreferences.session, forum); assert.equal(child.view.options.webPreferences.openerId, source.view.webContents.id);
  assert.equal(child.view.options.webPreferences.nodeIntegration, false); assert.equal(child.view.options.webPreferences.sandbox, true);
  assert.equal(child.view.options.webPreferences.preload, undefined); assert.equal(child.view.options.webPreferences.webSecurity, true);
});
test('blank scripted popups work; ads and local-file popups stay blocked', () => {
  const { browser } = harness(), source = browser.createTab();
  assert.equal(source.view.webContents.popup({ url: 'about:blank', disposition: 'new-window' }).action, 'allow');
  assert.equal(source.view.webContents.popup({ url: 'file:///etc/passwd' }).action, 'deny');
  assert.equal(source.view.webContents.popup({ url: 'https://sub.popads.net/click' }).action, 'deny');
  const navigation = { prevented: false, preventDefault() { this.prevented = true; } };
  source.view.webContents.emit('will-navigate', navigation, 'file:///etc/passwd'); assert.equal(navigation.prevented, true);
});
test('thread context follows exits/providers but clears when returning to the forum index', async () => {
  const { browser } = harness(); await browser.open('https://f95zone.to/threads/example.321809/');
  const tab = browser.views.get(browser.activeId), wc = tab.view.webContents;
  const expected = gameKey('https://f95zone.to', '321809'); assert.equal(tab.gameId, expected);
  wc.emit('did-navigate', {}, 'https://f95zone.to/dl/100/'); assert.equal(tab.gameId, expected);
  wc.emit('did-navigate', {}, 'https://provider.test/archive'); assert.equal(tab.gameId, expected);
  wc.emit('did-navigate', {}, 'https://f95zone.to/'); assert.equal(tab.gameId, null);
});
test('a destroyed popup removes its tab and updates selection', () => {
  const { browser } = harness(), first = browser.createTab(), second = browser.createTab();
  second.view.webContents.close(); assert.equal(second.view.webContents.closed, true);
  assert.equal(browser.views.has(second.view.webContents.id), false); assert.equal(browser.activeId, first.view.webContents.id);
});
test('downloads are attributed to the initiating tab rather than the selected tab', () => {
  const { browser, forum, downloads } = harness(); const source = browser.createTab({ gameId: 'thread-A' });
  browser.createTab({ gameId: 'thread-B' });
  forum.emit('will-download', {}, { filename: 'game.zip' }, source.view.webContents);
  assert.equal(downloads[0].id, 'thread-A'); assert.equal(browser.state().tabs[0].url, undefined);
});
test('local imports keep their stable identity after linking a forum thread',async()=>{
  const {browser,store}=harness();store.data.games.push({id:'local:stable',origin:'https://f95zone.to',threadId:'321809'});
  await browser.open('https://f95zone.to/threads/example.321809/');assert.equal(browser.views.get(browser.activeId).gameId,'local:stable');
});
test('an unregistered thread carries metadata through provider popups into its download',async()=>{
  const {browser,forum,downloads,Contents}=harness();
  await browser.open('https://f95zone.to/threads/fixture.12345/');
  const source=browser.views.get(browser.activeId), wc=source.view.webContents;
  wc.emit('dom-ready');await new Promise(resolve=>setImmediate(resolve));
  const popup=wc.popup({url:'https://provider.test/file',disposition:'foreground-tab'});
  const guest=popup.createWindow({webContents:new Contents()});
  await guest.loadURL('https://provider.test/file');
  // Navigating the original tab elsewhere must not rewrite the child context.
  await wc.loadURL('https://f95zone.to/threads/other.54321/');
  forum.emit('will-download',{}, {filename:'file.zip'},guest);
  const result=downloads[0];assert.equal(result.thread.threadId,'12345');assert.equal(result.thread.title,'Fixture Game');assert.equal(result.thread.engine,'renpy');assert.equal(result.thread.latestVersion,'1.2');
  source.thread.title='Changed later';assert.equal(result.thread.title,'Fixture Game','download context is a snapshot');
});
test('unreadable metadata still retains the source thread and forum index clears it',async()=>{
  const {browser,forum,downloads}=harness();await browser.open('https://f95zone.to/threads/fixture.12345/');
  const tab=browser.views.get(browser.activeId), wc=tab.view.webContents;
  wc.html='<title>Just a moment</title>';wc.emit('dom-ready');await new Promise(resolve=>setImmediate(resolve));
  forum.emit('will-download',{}, {},wc);assert.equal(downloads[0].thread.threadId,'12345');assert.equal(downloads[0].thread.title,undefined);
  await wc.loadURL('https://f95zone.to/');forum.emit('will-download',{}, {},wc);assert.equal(downloads[1].thread,null);
});

test('F95 and LC tabs with identical thread numbers retain their own source and popup download context', async () => {
  const { browser, forum, downloads, Contents } = harness();
  await browser.open('https://f95zone.to/threads/example.123/'); const first = browser.views.get(browser.activeId);
  await browser.open('https://lewdcorner.com/threads/example.123/', null, true); const second = browser.views.get(browser.activeId);
  assert.equal(first.sourceId, 'f95'); assert.equal(second.sourceId, 'lc'); assert.notEqual(first.gameId, second.gameId);
  const popup = second.view.webContents.popup({ url: 'https://provider.test/archive', disposition: 'foreground-tab' });
  const guest = popup.createWindow({ webContents: new Contents() }); await guest.loadURL('https://provider.test/archive');
  forum.emit('will-download', {}, {}, guest); assert.equal(downloads[0].thread.origin, 'https://lewdcorner.com');
  await browser.logout('lc'); assert.equal(forum.cleared[0].origin, 'https://lewdcorner.com');
  assert.equal(browser.views.has(first.view.webContents.id), true); assert.equal(browser.views.has(second.view.webContents.id), false);
});

test('downloads started by a background metadata page are cancelled before entering the user queue', () => {
  const { browser, forum, downloads, Contents } = harness(), contents = new Contents();
  browser.metadataContents.add(contents.id);
  let cancelled = false;
  forum.emit('will-download', {}, { cancel() { cancelled = true; } }, contents);
  assert.equal(cancelled, true); assert.deepEqual(downloads, []);
});

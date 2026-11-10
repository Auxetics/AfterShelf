import { httpUrl, threadReference, popupAllowed, hostMatches, parseThread } from './core/site.mjs';
import { gameKey } from './core/model.mjs';
import { sourceForUrl, sourceById, sourceId as siteId } from './core/sources.mjs';
import { remotePreferences } from './core/remote-preferences.mjs';
import { readRenderedListing } from './core/rendered-listing.mjs';

export class ForumBrowser {
  constructor(window, store, notify, onDownload, { WebContentsView, session, BrowserWindow }) {
    this.window = window; this.store = store; this.notify = notify; this.views = new Map(); this.activeId = null; this.bounds = null; this.attachedId = null;
    this.WebContentsView = WebContentsView;
    this.BrowserWindow = BrowserWindow; this.metadataContents = new Set();
    this.session = session.fromPartition('persist:forum');
    this.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler(() => false);
    this.session.on('will-download', (_event, item, contents) => { if (this.metadataContents.has(contents?.id)) { item.cancel(); return; } const source = this.views.get(contents?.id); onDownload(item, source?.gameId || null, source?.thread ? structuredClone(source.thread) : null); });
    this.session.webRequest.onBeforeRequest((details, callback) => {
      let blocked = false;
      try { blocked = this.store.data.settings.site.blockedHosts.some(domain => hostMatches(new URL(details.url).hostname, domain)); } catch {}
      callback({ cancel: blocked });
    });
  }
  state() {
    return { activeId: this.activeId, tabs: [...this.views.values()].map(tab => ({ id: tab.view.webContents.id, title: tab.title || 'New tab', loading: tab.loading, gameId: tab.gameId, sourceId: tab.sourceId, error: tab.error || '', canGoBack: tab.view.webContents.navigationHistory.canGoBack(), canGoForward: tab.view.webContents.navigationHistory.canGoForward() })) };
  }
  publish() { this.notify(this.state()); }
  createTab({ gameId = null, thread = null, sourceId = siteId(this.store.data.settings.site), active = true, webContents, webPreferences = {} } = {}) {
      const view = new this.WebContentsView({ ...(webContents ? { webContents } : {}), webPreferences: remotePreferences(this.session, webPreferences) });
      const tab = { view, gameId, thread, sourceId, title: 'New tab', url: '', loading: false, error: '' };
      const wc = view.webContents;
      this.views.set(wc.id, tab);
      wc.on('did-start-loading', () => { tab.loading = true; this.publish(); });
      wc.on('did-stop-loading', () => { tab.loading = false; this.publish(); });
      const navigated = (_event, next) => {
        tab.url = next; tab.error = '';
        try {
          const site = sourceForUrl(this.store.data.settings, next); tab.sourceId = site.id;
          const ref = threadReference(next, site.origin);
          tab.gameId = this.store.data.games.find(game => game.origin === ref.origin && game.threadId === ref.threadId)?.id || gameKey(ref.origin, ref.threadId);
          if (tab.thread?.origin !== ref.origin || tab.thread?.threadId !== ref.threadId) tab.thread = { ...ref };
        }
        catch { try { const destination = new URL(next), site = sourceForUrl(this.store.data.settings, next); tab.sourceId = site.id; if (!destination.pathname.startsWith('/dl/')) { tab.gameId = null; tab.thread = null; } } catch {} }
        this.publish();
      };
      wc.on('did-navigate', navigated); wc.on('did-navigate-in-page', navigated);
      wc.on('dom-ready', () => {
        // Cache metadata while the user is on the thread. Provider pages and
        // popup tabs carry this context without refetching the forum later.
        const context = tab.thread, url = wc.getURL();
        let ref; try { ref = threadReference(url, sourceForUrl(this.store.data.settings, url).origin); } catch { return; }
        if (!context || context.origin !== ref.origin || context.threadId !== ref.threadId) return;
        void wc.executeJavaScript('document.documentElement.outerHTML.slice(0, 2000000)', false).then(html => {
          const meta = parseThread(html, url, ref.origin);
          delete meta.coverUrl;
          delete meta.coverCandidates;
          Object.assign(context, meta);
        }).catch(() => {});
      });
      wc.on('page-title-updated', (_event, title) => { tab.title = title; this.publish(); });
      wc.on('did-fail-load', (_event, code, text, _url, isMainFrame) => { if (code !== -3 && isMainFrame) { tab.error = `Page could not load (${code}): ${text}`; this.publish(); } });
      for (const name of ['will-navigate', 'will-redirect']) wc.on(name, (event, next) => { if (!httpUrl(next)) event.preventDefault(); });
      wc.on('will-prevent-unload', event => event.preventDefault());
      wc.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || !(input.meta || input.control) || input.alt) return;
        if (input.key.toLowerCase() === 't') { event.preventDefault(); void this.open(sourceById(this.store.data.settings, tab.sourceId).origin, null, true).catch(error => this.store.log('New tab could not open', error.message)); }
        if (input.key.toLowerCase() === 'w') { event.preventDefault(); this.close(wc.id); }
      });
      wc.setWindowOpenHandler(details => {
        const site = sourceById(this.store.data.settings, tab.sourceId);
        if (details.url !== 'about:blank' && !popupAllowed(details.url, site)) { void this.store.log('Blocked popup'); return { action: 'deny' }; }
        // Let Chromium complete the original request in an embedded tab. Manually
        // loading its URL would drop form POST data, referrers, and window.opener.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { webPreferences: remotePreferences(this.session) },
          // Electron supplies the already-created guest WebContents here. The
          // view must adopt that exact instance, preserving its pending request
          // and opener; creating another WebContents triggers openGuestWindow.
          createWindow: options => this.createTab({ gameId: tab.gameId, thread: tab.thread, sourceId: tab.sourceId, active: details.disposition !== 'background-tab', webContents: options.webContents, webPreferences: options.webPreferences }).view.webContents
        };
      });
      wc.on('destroyed', () => { if (this.views.has(wc.id)) this.removeTab(wc.id); });
      if (active || this.activeId === null) this.activate(wc.id); else this.publish();
      return tab;
  }
  async open(url, gameId = null, newTab = false) {
    if (!httpUrl(url)) throw new Error('Only HTTP and HTTPS addresses can be opened in Browse.');
    const current = newTab || !this.activeId || !this.views.has(this.activeId) ? this.createTab({ gameId }) : this.views.get(this.activeId);
    current.gameId = gameId; current.url = url; current.error = '';
    const game = this.store.data.games.find(game => game.id === gameId);
    if (game?.threadUrl) { current.thread = { origin: game.origin, threadId: game.threadId, threadUrl: game.threadUrl, title: game.title, engine: game.engine, latestVersion: game.latestVersion }; try { current.sourceId = sourceForUrl(this.store.data.settings, game.threadUrl).id; } catch {} }
    try { await current.view.webContents.loadURL(url); } catch (error) { current.error = 'The page did not finish loading. Reload or check the address.'; this.publish(); }
    return this.state();
  }
  detach() {
    const attached = this.views.get(this.attachedId);
    if (attached) this.window.contentView.removeChildView(attached.view);
    this.attachedId = null;
  }
  activate(id) {
    if (!this.views.has(id)) throw new Error('Browser tab no longer exists.');
    if (this.attachedId !== id) this.detach();
    this.activeId = id;
    if (this.bounds) { const view = this.views.get(id).view; if (this.attachedId !== id) this.window.contentView.addChildView(view); this.attachedId = id; view.setBounds(this.bounds); }
    this.publish();
  }
  layout(rect) {
    if (!rect || !['x','y','width','height'].every(key => Number.isFinite(rect[key])) || rect.width < 10 || rect.height < 10) {
      this.detach();
      this.bounds = null; return;
    }
    const [width, height] = this.window.getContentSize();
    const x = Math.min(width, Math.max(0, Math.round(rect.x))), y = Math.min(height, Math.max(0, Math.round(rect.y)));
    this.bounds = { x, y, width: Math.min(width - x, Math.round(rect.width)), height: Math.min(height - y, Math.round(rect.height)) };
    const tab = this.views.get(this.activeId);
    if (tab) { if (this.attachedId !== this.activeId) { this.detach(); this.window.contentView.addChildView(tab.view); this.attachedId = this.activeId; } tab.view.setBounds(this.bounds); }
  }
  removeTab(id) {
    const ids = [...this.views.keys()], index = ids.indexOf(id);
    if (this.attachedId === id) this.detach();
    this.views.delete(id);
    if (this.activeId === id) { this.activeId = null; const next = ids[index + 1] ?? ids[index - 1]; if (next !== undefined) this.activate(next); }
    this.publish();
  }
  close(id) {
    const tab = this.views.get(id); if (!tab) return;
    this.removeTab(id); tab.view.webContents.close();
  }
  async command(command) {
    const wc = this.views.get(this.activeId)?.view.webContents;
    if (!wc) return;
    if (command === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (command === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    if (command === 'reload') wc.reload();
    return this.state();
  }
  async currentThread() {
    const wc = this.views.get(this.activeId)?.view.webContents;
    if (!wc) throw new Error('Open a game thread in Browse first.');
    const url = wc.getURL(); threadReference(url, sourceForUrl(this.store.data.settings, url).origin);
    return { url, html: await wc.executeJavaScript('document.documentElement.outerHTML', false) };
  }
  async readListing(url, site) {
    let id;
    const isSearch = new URL(url, site.origin).searchParams.has('search');
    return readRenderedListing({ BrowserWindow: this.BrowserWindow, session: this.session, url, origin: site.origin, timeout: isSearch ? 6000 : 15000,
      onCreated: contents => { id = contents.id; this.metadataContents.add(id); }, onDisposed: () => this.metadataContents.delete(id) });
  }
  async logout(sourceId = siteId(this.store.data.settings.site)) { const source = sourceById(this.store.data.settings, sourceId); await this.session.clearStorageData({ origin: source.origin, storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] }); for (const [id, tab] of [...this.views]) if (tab.sourceId === sourceId) this.close(id); }
  destroy() { for (const id of [...this.views.keys()]) this.close(id); }
}

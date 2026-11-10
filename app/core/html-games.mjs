import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, net, protocol, session } from 'electron';
import { archivePath, assertNoLinks, isInside, realDirectory } from './files.mjs';

const scheme = 'aftershelf-game';
const base = scheme + '://local';
const windows = new Map();
const policy = "default-src 'self' blob: data:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' blob: data:; object-src 'none'; frame-src 'self' blob: data:; form-action 'none'; base-uri 'self'";

export function registerHtmlScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
}

export function htmlGameOpen(id) { return Boolean(windows.get(id)); }
export function closeHtmlGames() { for (const window of windows.values()) window.destroy(); }

function allowed(url) { return url.startsWith(base + '/'); }

export async function launchHtmlGame(game, onSession) {
  const existing = windows.get(game.id);
  if (existing) { existing.focus(); return; }
  const { root: installedRoot, launch } = game.installation;
  if (!isInside(installedRoot, launch)) throw new Error('The HTML launcher must be inside the game folder.');
  const root = await realDirectory(installedRoot);
  const entry = path.relative(installedRoot, launch);
  await assertNoLinks(root, path.join(root, entry));
  const relative = entry.split(path.sep).map(encodeURIComponent).join('/');
  if (windows.has(game.id)) { windows.get(game.id).focus(); return; }
  const partition = 'persist:html-' + createHash('sha256').update(game.id).digest('hex');
  const storage = session.fromPartition(partition);
  storage.setPermissionCheckHandler(() => false);
  storage.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  storage.webRequest.onBeforeRequest((details, callback) => callback({
    cancel: !(allowed(details.url) || details.url.startsWith('blob:') || details.url.startsWith('data:'))
  }));
  const denyDownload = (_event, item) => item.cancel();
  storage.on('will-download', denyDownload);
  storage.protocol.handle(scheme, async request => {
    if (!allowed(request.url) || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 403 });
    try {
      const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
      const file = archivePath(root, name);
      await assertNoLinks(root, file);
      if (!(await fs.lstat(file)).isFile()) return new Response(null, { status: 404 });
      const response = await net.fetch(pathToFileURL(file).href, { method: request.method, headers: request.headers });
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', policy);
      headers.set('Cache-Control', 'no-store');
      return new Response(response.body, { status: response.status, headers });
    } catch { return new Response(null, { status: 404 }); }
  });
  const window = new BrowserWindow({
    title: game.title, width: 1100, height: 780, show: false, autoHideMenuBar: true,
    webPreferences: { partition, nodeIntegration: false, sandbox: true, contextIsolation: true, webSecurity: true }
  });
  windows.set(game.id, window);
  let started = 0, tick = 0;
  const version = game.installation.version || game.installedVersion || '';
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const event of ['will-frame-navigate', 'will-redirect']) {
    window.webContents.on(event, details => { if (!allowed(details.url)) details.preventDefault(); });
  }
  window.on('closed', () => {
    storage.flushStorageData();
    storage.protocol.unhandle(scheme);
    storage.removeListener('will-download', denyDownload);
    windows.delete(game.id);
    if (started) onSession?.({ at: started, version, duration: Math.round(performance.now() - tick) });
  });
  try {
    await window.loadURL(base + '/' + relative);
    if (!window.isDestroyed()) { started = Date.now(); tick = performance.now(); window.show(); }
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}

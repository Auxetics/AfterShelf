import { parseLatestHtml } from './site.mjs';
import { remotePreferences } from './remote-preferences.mjs';

// Used by the installed app when a listing is populated by the website's JS.
// No raw HTML is stored or exposed through IPC/diagnostics.
export async function readRenderedListing({ BrowserWindow, session, url, origin, onCreated = () => {}, onDisposed = () => {}, timeout = 15000, poll = 250 }) {
  if (typeof BrowserWindow !== 'function') throw new Error('Rendered listing support is unavailable. Restart the app and retry.');
  const expected = new URL(url);
  if (expected.origin !== origin) throw new Error('The rendered listing must belong to its configured source.');
  const window = new BrowserWindow({ show: false, width: 1280, height: 900, skipTaskbar: true,
    webPreferences: remotePreferences(session, { backgroundThrottling: false, disableDialogs: true }) });
  const contents = window.webContents;
  let timer, navigationError, prior = '', stable = 0, empty = false;
  onCreated(contents);
  const valid = destination => {
    const next = new URL(destination);
    return next.origin === origin && next.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '') && (next.searchParams.get('page') || '1') === (expected.searchParams.get('page') || '1');
  };
  for (const event of ['will-navigate', 'will-redirect']) contents.on(event, (e, destination) => {
    if (!valid(destination)) { e.preventDefault(); navigationError = new Error('The update listing redirected away from its configured page. Open the source in Browse to sign in, then retry.'); }
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-prevent-unload', event => event.preventDefault());
  try {
    return await Promise.race([
      (async () => {
        await contents.loadURL(url);
        for (;;) {
          if (navigationError) throw navigationError;
          if (contents.isDestroyed()) throw new Error('The rendered listing was interrupted. Retry the site check.');
          if (!valid(contents.getURL())) throw new Error('The listing opened a different page. Sign in through Browse, then retry.');
          const snapshot = await contents.executeJavaScript(`(() => {
            const copy = document.documentElement.cloneNode(true);
            copy.querySelectorAll('script, style, link, noscript, template').forEach(node => node.remove());
            return copy.outerHTML.slice(0, 3000000);
          })()`, false);
          let rows;
          try { rows = parseLatestHtml(snapshot, origin); }
          catch (error) {
            if (!/No game thread listing/.test(error.message)) throw error;
            prior = ''; stable = 0; empty = false;
          }
          if (rows?.length) {
            empty = false;
            const fingerprint = JSON.stringify(rows.map(row => [row.threadId, row.version, row.title]));
            stable = fingerprint === prior ? stable + 1 : 0; prior = fingerprint;
            if (stable >= 2) return rows;
          } else if (rows) {
            empty = true;
            stable = prior === '[]' ? stable + 1 : 0; prior = '[]';
            if (stable >= 2) return [];
          }
          await new Promise(resolve => setTimeout(resolve, poll));
        }
      })(),
      new Promise((resolve, reject) => { timer = setTimeout(() => empty ? resolve([]) : reject(new Error('The page loaded, but no supported game listing appeared. Its rendered markup needs a different listing rule.')), timeout); })
    ]);
  } finally {
    clearTimeout(timer);
    if (!window.isDestroyed()) window.destroy();
    onDisposed(contents);
  }
}

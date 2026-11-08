import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readRenderedListing } from '../../app/core/rendered-listing.mjs';

export async function checkRenderedListing(BrowserWindow, session) {
  let escaped = 0, disposed = 0;
  const outside = createServer((_req, res) => { escaped++; res.end('outside'); });
  await new Promise(resolve => outside.listen(0, '127.0.0.1', resolve));
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/redirect') res.end(`<main>Loading…</main><script>location.href='http://127.0.0.1:${outside.address().port}/outside';</script>`);
    else if (req.url === '/empty') res.end('<main>No games found</main>');
    else res.end('<main>An unexpected page</main>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, baseline = BrowserWindow.getAllWindows().length;
  const options = { BrowserWindow, session: session.fromPartition('rendered-listing-fixture'), origin, timeout: 1000, poll: 25,
    onCreated(contents) { const prefs = contents.getLastWebPreferences(); assert.equal(prefs.sandbox, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.disableDialogs, true); },
    onDisposed() { disposed++; } };
  try {
    await assert.rejects(readRenderedListing({ ...options, url: origin + '/redirect' }), /redirected away/);
    assert.equal(escaped, 0);
    assert.deepEqual(await readRenderedListing({ ...options, url: origin + '/empty' }), []);
    await assert.rejects(readRenderedListing({ ...options, url: origin + '/unexpected' }), /no supported game listing/);
    assert.equal(disposed, 3); assert.equal(BrowserWindow.getAllWindows().length, baseline);
    console.log('PASS native rendered-listing reader blocks foreign navigation, bounds empty/unsupported pages and closes its sandboxed windows (1 scenario)');
  } finally { server.close(); outside.close(); }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../app/core/model.mjs';
import { sourceById } from '../app/core/sources.mjs';
import { ForumMetadata } from '../app/core/forum-metadata.mjs';
import { parseLatestHtml } from '../app/core/site.mjs';

const site = sourceById(initialState().settings, 'lc');
const rendered = '<main><article class="game-card"><a href="/threads/example.123/"><img alt="Example Game"></a><span class="label">v2.0</span></article></main>';

test('an HTML shell falls back to the rendered page using the requested source, filters and page', async () => {
  const calls = [];
  const client = new ForumMetadata(site, async () => new Response('<main>Loading updates…</main>'), undefined, {
    async renderListing(url, source) { calls.push({ url, origin: source.origin }); return parseLatestHtml(rendered, source.origin); }
  });
  const rows = await client.latestPage(3);
  assert.equal(rows.length, 1); assert.equal(rows[0].threadId, '123'); assert.equal(rows[0].version, '2.0');
  assert.equal(new URL(calls[0].url).searchParams.get('page'), '3'); assert.equal(new URL(calls[0].url).searchParams.get('per_page'), '60');
  assert.equal(calls[0].origin, site.origin); assert.equal(client.lastListingMode, 'rendered');
});

test('server-rendered listings do not open a rendering window', async () => {
  const client = new ForumMetadata(site, async () => new Response(rendered), undefined, { renderListing() { throw new Error('must not render'); } });
  assert.equal((await client.latestPage(1)).length, 1); assert.equal(client.lastListingMode, 'server');
});

test('login and challenge pages never use the rendering fallback to retry authentication', async () => {
  for (const html of ['<title>Just a moment</title>', '<form action="/login/login"></form>']) {
    const client = new ForumMetadata(site, async () => new Response(html), undefined, { renderListing() { throw new Error('must not render'); } });
    await assert.rejects(client.latestPage(1), /sign in/);
  }
});

test('search matching works with game titles populated by JavaScript', async () => {
  const client = new ForumMetadata(site, async () => new Response('<main>Loading…</main>'), undefined, {
    async renderListing(url) { assert.equal(new URL(url).searchParams.get('search'), 'example game'); return parseLatestHtml(rendered, site.origin); }
  });
  const rows = await client.search('Example Game'); assert.equal(rows.length, 1); assert.equal(rows[0].exact, true);
});

test('site health reports that the rendered listing was parsed, without retaining HTML', async () => {
  const client = new ForumMetadata(site, async url => new Response(new URL(url).pathname === '/' ? '<title>Forum</title>' : '<main>Loading…</main>'), undefined, { async renderListing() { return parseLatestHtml(rendered, site.origin); } });
  const result = await client.availability();
  assert.equal(result.feedStatus, 'ok'); assert.equal(result.entries, 1); assert.equal(result.listingMode, 'rendered');
  assert.match(result.message, /after page loaded/); assert.equal(JSON.stringify(result).includes('<main>'), false);
});

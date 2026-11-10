import { createHash } from 'node:crypto';
import { parseLatest, parseLatestHtml, parseThread, threadReference, imageReference } from './site.mjs';
import { normalizedTitle } from './model.mjs';
import { archiveTitle } from './archive-names.mjs';

function searchText(value) {
  const title = String(value || '').trim();
  if (!title) return '';
  const name = archiveTitle(title.replace(/\s*\(\d+\)(?=\.[^.]+$)/, ''))
    .replace(/\.(?:app|exe)$/i, '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .trim()
    .replace(/[\s._-]+(?:v(?:ersion)?\.?\s*\d+(?:\.\d+)*|\d+(?:\.\d+)+)(?:[a-z]\d*)?(?:[\s._-]+(?:mac(?:os)?|osx|win(?:dows|32|64)?|linux|pc|x64|x86|arm64|universal|public|compressed))*$/i, '')
    .replace(/\s*-\s*(?:mac(?:os)?|osx|win(?:dows|32|64)?|linux|pc|x64|x86|arm64|universal)$/i, '');
  return normalizedTitle(name.replace(/[’']/g, '').replace(/([\p{Ll}\d])([\p{Lu}])/gu, '$1 $2')
    .normalize('NFKD').replace(/\p{M}/gu, ''));
}
function searchWords(value) { return searchText(value).split(' ').filter(word => word && !['a', 'an', 'the'].includes(word)); }
function matchScore(title, query) {
  const candidate = searchText(title), requested = searchText(query);
  if (!candidate || !requested) return 0;
  if (candidate.replaceAll(' ', '') === requested.replaceAll(' ', '')) return 100;
  const words = searchWords(query), titleWords = candidate.split(' ');
  if (!words.length || !words.every(word => titleWords.some(part => part.startsWith(word)))) return 0;
  return candidate.includes(words.join(' ')) ? 80 : 60;
}
export function searchUrl(site, title, page = 1) {
  return titleSearchUrl(site, fitSearchWords(searchWords(title)), page);
}
function fitSearchWords(words) {
  const phrase = words.join(' ');
  if (phrase.length <= 30) return phrase;
  const limit = phrase.lastIndexOf(' ', 30);
  return phrase.slice(0, limit > 0 ? limit : 30);
}
function titleSearchUrl(site, query, page) {
  if (query.length < 2) throw new Error('Enter at least two letters of the game title.');
  if (!site.latestPath) throw new Error('Map this source’s latest-updates endpoint in Settings first.');
  const url = new URL(site.latestPath.replaceAll('{page}', String(page)), site.origin);
  if (url.origin !== site.origin) throw new Error('The metadata search endpoint must belong to the configured forum.');
  url.searchParams.delete('title'); url.searchParams.delete('creator');
  url.searchParams.set('search', query); url.searchParams.set('page', String(page));
  if (site.feedFormat === 'html') { url.searchParams.set('per_page', '30'); url.searchParams.set('search_scope', 'title'); url.searchParams.delete('only_new_days'); }
  else { url.searchParams.set('rows', '30'); url.searchParams.set('sort', 'likes'); }
  return url.href;
}
export function updateFeedUrl(site, page = 1) {
  if (!site.latestPath) throw new Error('Map this source’s latest-updates endpoint in Settings first.');
  const url = new URL(site.latestPath.replaceAll('{page}', String(page)), site.origin);
  if (url.origin !== site.origin) throw new Error('The update endpoint must belong to the configured forum.');
  for (const key of ['search', 'title', 'creator']) url.searchParams.delete(key);
  url.searchParams.set('page', String(page));
  if (site.feedFormat !== 'html') { url.searchParams.set('sort', 'date'); url.searchParams.set('rows', '90'); url.searchParams.set('_', String(Date.now())); }
  return url.href;
}
async function bytes(response, max) {
  if (Number(response.headers.get('content-length')) > max) throw new Error('The metadata response was too large.');
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = []; let length = 0;
  try {
    while (true) { const item = await reader.read(); if (item.done) break; length += item.value.length; if (length > max) throw new Error('The metadata response was too large.'); chunks.push(Buffer.from(item.value)); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
export class ForumMetadata {
  constructor(site, fetch, decodeCover = () => '', { renderListing } = {}) { this.site = site; this.fetch = fetch; this.decodeCover = decodeCover; this.renderListing = renderListing; this.lastListingMode = 'server'; }
  get pageSize() {
    const url = new URL(updateFeedUrl(this.site));
    const value = Number(url.searchParams.get(this.site.feedFormat === 'html' ? 'per_page' : 'rows'));
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  get windowDays() {
    const value = Number(new URL(updateFeedUrl(this.site)).searchParams.get('only_new_days'));
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  async htmlRows(html, url) {
    let rows;
    this.lastListingMode = 'server';
    try { rows = parseLatestHtml(html, this.site.origin); }
    catch (error) { if (!this.renderListing || !/No game thread listing/.test(error.message)) throw error; }
    if (rows?.length || !this.renderListing) return rows;
    await this.listingProgress?.('Website reached; waiting for the game listing to load…');
    rows = await this.renderListing(url, this.site);
    if (!Array.isArray(rows)) throw new Error('The rendered listing returned no recognised game data.');
    this.lastListingMode = 'rendered';
    return rows;
  }
  async response(url, siteOnly = true, headers) {
    const validate = destination => {
      const parsed = new URL(destination);
      if (siteOnly ? parsed.origin !== this.site.origin : !imageReference(destination, this.site.origin)) throw new Error('The metadata destination was not allowed.');
    };
    for (let redirects = 0; redirects < 5; redirects++) {
      validate(url);
      const response = await this.fetch(url, { redirect: 'manual', onRedirect: validate, signal: AbortSignal.timeout(20000), ...(headers ? { headers } : {}) });
      if ([301, 302, 303, 307, 308].includes(response.status)) { const next = response.headers.get('location'); await response.body?.cancel(); if (!next) throw new Error('The forum returned an invalid redirect.'); url = new URL(next, url).href; continue; }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Metadata request returned HTTP ${response.status}. Open Browse to sign in, then retry.`); }
      return response;
    }
    throw new Error('The metadata request redirected too many times.');
  }
  async search(title) {
    const query = fitSearchWords(searchWords(title));
    const queryWords = query.split(' ');
    const alternate = queryWords.reduce((longest, word) => word.length > longest.length ? word : longest, '');
    const found = new Map();
    const searchPage = async (phrase, page, seen) => {
      const url = titleSearchUrl(this.site, phrase, page), response = await this.response(url);
      const body = (await bytes(response, 5_000_000)).toString('utf8');
      let rows;
      if (this.site.feedFormat === 'html') rows = await this.htmlRows(body, url);
      else { let payload; try { payload = JSON.parse(body); } catch { throw new Error('Search returned a page instead of game data. Sign in through Browse, then retry.'); } rows = parseLatest(payload); }
      let newRows = 0;
      for (const row of rows) {
        if (seen.has(row.threadId)) continue;
        seen.add(row.threadId); newRows++;
        const score = matchScore(row.title, title);
        if (!score || found.get(row.threadId)?.score >= score) continue;
        const ref = threadReference(`/threads/${row.threadId}/`, this.site.origin);
        found.set(row.threadId, { ...ref, title: row.title, latestVersion: row.version, engine: row.engine, creator: row.creator, exact: score === 100, score });
      }
      return { total: rows.length, newRows };
    };
    const seen = new Set();
    let repeatedPage = false;
    for (let page = 1; page <= 3; page++) {
      const { total, newRows } = await searchPage(query, page, seen);
      repeatedPage = total > 0 && !newRows;
      if (total < 30 || repeatedPage) break;
    }
    // The endpoint can require a literal phrase. Try one distinctive word, but
    // score its results against the full title to keep unrelated rows out.
    if (!found.size && !repeatedPage && alternate !== query) await searchPage(alternate, 1, new Set());
    return [...found.values()].sort((a, b) => b.score - a.score).slice(0, 60);
  }
  async latestPage(page) {
    const response = await this.response(updateFeedUrl(this.site, page), true, { 'Cache-Control': 'no-cache' });
    let payload;
    const text = (await bytes(response, 5_000_000)).toString('utf8');
    if (this.site.feedFormat === 'html') {
      if (response.url && new URL(response.url).pathname.replace(/\/$/, '') !== new URL(updateFeedUrl(this.site, page)).pathname.replace(/\/$/, '')) throw new Error('The latest-updates listing redirected elsewhere. Open this source in Browse to sign in, then retry.');
      return this.htmlRows(text, updateFeedUrl(this.site, page));
    }
    try { payload = JSON.parse(text); } catch { throw new Error('The site returned a page instead of update data. Open Browse to sign in, then retry.'); }
    return parseLatest(payload);
  }
  async availability(progress = () => {}) {
    this.listingProgress = progress;
    try { return await this.inspectAvailability(progress); }
    finally { this.listingProgress = undefined; }
  }
  async inspectAvailability(progress) {
    await progress('Checking website…');
    let response;
    try { response = await this.response(this.site.origin + '/'); }
    catch (error) { return { status: /HTTP (?:401|403)/.test(error.message) ? 'login-required' : 'error', message: error.message, feedStatus: 'unchecked' }; }
    const html = (await bytes(response, 3_000_000)).toString('utf8');
    if (/just a moment|attention required|<form[^>]+action=["'][^"']*login\/login/i.test(html)) return { status: 'login-required', message: 'Website reached. Open it in Browse to sign in or complete its site check.', feedStatus: 'unchecked' };
    if (!this.site.latestPath) return { status: 'reachable', message: 'Website reached. Map its latest-updates endpoint in Settings.', feedStatus: 'unconfigured' };
    await progress('Website reached; reading the update endpoint…');
    try { const rows = await this.latestPage(1); return { status: 'reachable', message: `Website reached · update listing parsed${this.lastListingMode === 'rendered' ? ' after page loaded' : ''} (${rows.length} entries on page 1). Use Check for updates to scan newer entries against the saved checkpoint.`, feedStatus: 'ok', entries: rows.length, listingMode: this.lastListingMode }; }
    catch (error) { return { status: 'reachable', message: `Website reached; update listing needs attention. ${error.message}`, feedStatus: 'error' }; }
  }
  async thread(url, { cover = true, gallery = false } = {}) {
    const ref = threadReference(url, this.site.origin), response = await this.response(ref.threadUrl, true, { 'Cache-Control': 'no-cache' });
    let finalRef = ref;
    if (response.url) {
      try { finalRef = threadReference(response.url, this.site.origin); } catch { throw new Error('The forum redirected away from the thread. Open Browse to sign in, then retry.'); }
      if (finalRef.threadId !== ref.threadId) throw new Error('This URL redirects to a different thread. View it in Browse and confirm its correct thread before linking.');
    }
    const metadata = parseThread((await bytes(response, 3_000_000)).toString('utf8'), finalRef.threadUrl, ref.origin);
    if (!cover) {
      delete metadata.coverUrl; delete metadata.coverCandidates;
      if (!gallery) delete metadata.imageGroups;
      return metadata;
    }
    return this.withCover(metadata);
  }
  async photo(url, gallery = false) {
    const image = await this.response(url, false, { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5', Referer: this.site.origin + '/' });
    if (!/^image\/(?:png|jpe?g|webp|gif|avif)(?:;|$)/i.test(image.headers.get('content-type') || '')) {
      await image.body?.cancel();
      throw new Error('The cover response was not a supported image.');
    }
    const data = await bytes(image, 8_000_000);
    const src = this.decodeCover(data, { gallery });
    if (!src) throw new Error('The cover image could not be decoded.');
    return { id: createHash('sha256').update(data).digest('hex'), src };
  }
  async withCover(metadata) {
    metadata = { ...metadata };
    const candidates = [...new Set([...(metadata.coverCandidates || []), metadata.coverUrl].filter(Boolean))].slice(0, 4);
    delete metadata.coverUrl; delete metadata.coverCandidates; delete metadata.imageGroups;
    let reason = 'No supported cover image was found in the opening post.';
    for (const coverUrl of candidates) {
      try {
        const photo = await this.photo(coverUrl);
        metadata.cover = photo.src; metadata.coverImageId = photo.id;
        metadata.coverStatus = 'cached'; metadata.coverError = ''; return metadata;
      } catch (error) {
        const status = /HTTP (\d{3})/.exec(error.message)?.[1];
        reason = status ? `Image host returned HTTP ${status}.` : /not a supported image/.test(error.message) ? 'Image host returned a page or unsupported format instead of an image.' : /decoded/.test(error.message) ? 'The downloaded image could not be decoded.' : /too large/.test(error.message) ? 'The image exceeded the size limit.' : /not allowed/.test(error.message) ? 'The image link did not lead to a supported HTTPS destination.' : 'The image request failed or was interrupted.';
      }
    }
    metadata.coverStatus = candidates.length ? 'failed' : 'not-found';
    metadata.coverError = `Thread details loaded, but the cover could not be downloaded. ${reason} Refresh details to retry.`;
    return metadata;
  }
}

import * as cheerio from 'cheerio';
import { detectEngine, normalizeVersion } from './model.mjs';
import { siteOrigin, threadReference } from './site-url.mjs';
export { siteOrigin, threadReference } from './site-url.mjs';

export function httpUrl(value) {
  try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
}
export function versionFromTitle(title = '') {
  const labels = [...title.matchAll(/\[([^\]]+)\]/g)].map(match => match[1].trim());
  return normalizeVersion(labels.find(value => /^(?:v?\d|(?:chapter|ch\.?|episode|ep\.?|season|part|build|release)\s*\d|(?:final|demo|alpha|beta)\b)/i.test(value)) || '');
}
export function imageReference(value, base) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value, base), host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || /^(?:localhost|.*\.localhost|.*\.local)$/.test(host) || /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return '';
    return url.href;
  } catch { return ''; }
}
function threadImages($, content, url) {
  const groups = new Map();
  const attachment = /\.(?:png|jpe?g|gif|webp|avif)(?:[?#]|$)|\/attachments\//i;
  const imageLink = node => node.is('[data-fancybox], .js-lbImage, .bbImageWrapper') || attachment.test(node.attr('href') || '');
  const group = element => {
    if (!groups.has(element)) groups.set(element, []);
    return groups.get(element);
  };
  content.find('.bbImageWrapper, .js-lbImage, img, picture source, a[data-fancybox], a[href]').each((_i, element) => {
    const node = $(element);
    if (node.is('a') && !imageLink(node)) return;
    const anchor = node.closest('a');
    const parent = (imageLink(anchor) && anchor.get(0)) || node.closest('.bbImageWrapper, picture').get(0) || element;
    const urls = group(parent);
    for (const attribute of ['data-src', 'data-url', 'data-original', 'data-lazy-src']) urls.push(node.attr(attribute));
    const srcset = node.attr('data-srcset') || node.attr('srcset');
    if (srcset) urls.push(...srcset.split(',').map(value => value.trim().split(/\s+/)[0]).reverse());
    urls.push(node.attr('src'));
    if (node.is('a')) urls.push(node.attr('href'));
  });
  groups.set(null, [$('meta[property="og:image"]').attr('content')]);
  const seen = new Set();
  return [...groups.values()].map(values => [...new Set(values
    .filter(value => value && !/smilies|avatars|emoji|spacer|placeholder|transparent|loading\.(?:gif|png)|\/logos?\//i.test(value))
    .map(value => imageReference(value, url)).filter(Boolean))]
    .filter(value => { if (seen.has(value)) return false; seen.add(value); return true; }).slice(0, 4))
    .filter(values => values.length).slice(0, 40);
}
export function parseThread(html, url, origin) {
  const ref = threadReference(url, origin);
  const $ = cheerio.load(html);
  if ($('form[action*="login/login"]').length || /just a moment/i.test($('title').text())) throw new Error('Open Browse and sign in or complete the site check, then try again.');
  const heading = $('.p-title-value').first().clone();
  const tags = [...$('.p-title-value .label, .tagItem, .p-description .label').map((_, el) => $(el).text()).get()];
  heading.find('.label, .labelLink').remove();
  const fullTitle = (heading.text() || $('meta[property="og:title"]').attr('content') || $('title').text()).replace(/\s*\|\s*(?:F95zone|LewdCorner)\s*$/i, '').trim();
  if (!fullTitle) throw new Error('No thread title found. This site may need a different thread selector.');
  // A selector union is ordered by the document, not by selector priority.
  // Prefer the actual starter post over earlier widget/lightbox wrappers.
  let first = $();
  for (const selector of ['.message-threadStarterPost .message-body', 'article.message--post .message-body', '.message--post .message-body', '.message-body', '.bbWrapper']) {
    const found = $(selector).first(); if (found.length) { first = found; break; }
  }
  const wrapper = first.children('.bbWrapper').first();
  if (wrapper.length) first = wrapper;
  const content = first.clone();
  content.find('script, style, template, noscript, iframe, button, form, blockquote, .bbCodeBlock--quote, .message-signature, .message-lastEdit, .bbCodeBlock-expandLink, .lb-container, .lightboxContainer, .fancybox-container').remove();
  const textBody = content.clone(); textBody.find('br').replaceWith('\n');
  textBody.find('p, div, li, h1, h2, h3, h4, tr').append('\n');
  textBody.find('strong, b').each((_i, element) => { if (/^(?:overview|description|developer|creator|version|game version|engine|thread updated|release date|os|language|download|installation|changelog)\s*:/i.test($(element).text().trim())) $(element).before('\n'); });
  const body = textBody.text().replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').slice(0, 100000);
  const fieldVersion = /(?:game\s+)?version\s*:\s*([^\n\r]+)/i.exec(body)?.[1]?.trim();
  const imageGroups = threadImages($, content, url);
  const coverCandidates = imageGroups.flat().slice(0, 12);
  const creatorField = /(?:developer|creator)\s*:\s*([^\n\r]+)/i.exec(body)?.[1]?.trim().slice(0, 200);
  const creator = creatorField || [...fullTitle.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]).filter(value => !versionFromTitle(`[${value}]`) && detectEngine(value) === 'custom').at(-1) || '';
  const overview = /(?:^|\n)\s*(?:overview|description)\s*:\s*([\s\S]*?)(?=\n\s*(?:thread updated|release date|developer|creator|version|engine|os|language|download(?:s| links)?|installation|changelog|screenshots)\s*:|$)/i.exec(body)?.[1] || body;
  const changelog = /(?:^|\n)\s*(?:change\s*log|what[’']?s new)\s*:\s*([\s\S]*?)(?=\n\s*(?:download(?:s| links)?|installation|screenshots|overview|description)\s*:|$)/i.exec(body)?.[1]?.trim() || '';
  const engineField = /(?:^|\n)\s*(?:game\s+)?engine\s*:\s*([^\n]+)/i.exec(body)?.[1] || '';
  return { ...ref, title: fullTitle.replace(/\[[^\]]*\]/g, '').trim() || fullTitle,
    latestVersion: versionFromTitle(fullTitle) || fieldVersion?.slice(0, 100) || '',
    engine: detectEngine(tags.join(' ') + ' ' + fullTitle + ' ' + engineField), tags: tags.slice(0, 50),
    description: overview.replace(/\s+/g, ' ').trim().slice(0, 400), changelog: changelog.slice(0, 1800), creator, coverUrl: coverCandidates[0] || '', coverCandidates, imageGroups, metadataParserVersion: 2, checkedAt: Date.now() };
}
export function parseLatest(payload) {
  const rows = payload?.msg?.data || payload?.data;
  if (payload?.success === false || payload?.status === false || /^(?:error|failed|failure)$/i.test(String(payload?.status || ''))) throw new Error('The update feed reported an error. Open Browse to sign in, then retry.');
  if (!Array.isArray(rows)) throw new Error('Latest-updates feed format was not recognised. Check the endpoint in Settings or sign in through Browse.');
  if (rows.some(row => !row || !/^\d+$/.test(String(row.thread_id ?? row.id ?? '')))) throw new Error('The update feed contained unrecognised game entries. The checkpoint was retained.');
  return rows.map(row => ({ threadId: String(row.thread_id ?? row.id ?? ''),
    title: String(row.title || row.name || ''), version: normalizeVersion(row.version),
    timestamp: parseTimestamp(row.ts ?? row.updated_at ?? row.timestamp ?? row.last_update ?? row.date),
    updatedAt: parseTimestamp(row.updated_at ?? row.last_updated_at ?? row.last_update ?? row.date_modified),
    engine: detectEngine(JSON.stringify(row.prefixes || row.tags || [])),
    creator: String(row.creator || row.developer || '').slice(0, 200),
    fingerprint: JSON.stringify([row.version, row.ts ?? row.updated_at, row.title])
  })).filter(row => /^\d+$/.test(row.threadId));
}
export function parseTimestamp(value) {
  if (value == null) return 0;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) return Number(value) < 1e12 ? Number(value) * 1000 : Number(value);
  return Date.parse(value) || 0;
}
export function parseLatestHtml(html, origin) {
  const $ = cheerio.load(html);
  if ($('form[action*="login/login"]').length || /just a moment|attention required/i.test($('title').text())) throw new Error('Open this source in Browse and sign in or complete its site check, then retry.');
  const entries = new Map();
  const scope = $('main, .p-body-main, .p-body-content').first();
  const links = (scope.length ? scope : $.root()).find('a[href*="/threads/"]');
  links.each((_index, element) => {
    const link = $(element);
    if (link.closest('nav, header, footer, .message, .message-body, .p-body-sidebar').length) return;
    let ref; try { ref = threadReference(link.attr('href'), origin); } catch { return; }
    const rawTitle = (link.attr('data-title') || link.text() || link.attr('title') || link.find('img[alt]').first().attr('alt') || '').replace(/\s+/g, ' ').trim();
    if (rawTitle.length < 2 || /^(?:\d+|\.{3}|read more|view thread|last post|new posts|unread|first post|go to.*)$/i.test(rawTitle)) return;
    const row = link.closest('.structItem, article, .game-card, .resourceList-item, .contentRow, .block-row, [data-thread-id]');
    const releaseLabel = row.find('.label, .badge').map((_i, label) => $(label).text().trim()).get().find(value => /^(?:v\d[\w.-]*|\d+\.\d[\w.-]*|final|demo)$/i.test(value));
    const version = normalizeVersion(row.attr('data-version') || row.find('[data-version]').first().attr('data-version') || row.find('.game-version, .version').first().text() || versionFromTitle(rawTitle) || releaseLabel);
    const updated = row.find('time[itemprop="dateModified"], time.game-update, time.last-update, time.updated, [itemprop="dateModified"][content]').first();
    const updatedAt = parseTimestamp(row.attr('data-updated-at') || row.attr('data-update-time') || row.find('[data-updated-at]').first().attr('data-updated-at') || row.find('[data-update-time]').first().attr('data-update-time') || updated.attr('data-time') || updated.attr('datetime') || updated.attr('content'));
    const entry = { threadId: ref.threadId, title: rawTitle, version, engine: detectEngine(row.find('.label, .tagItem').text()), creator: '', timestamp: parseTimestamp(row.find('time[data-time]').first().attr('data-time')), updatedAt, fingerprint: JSON.stringify([version, rawTitle]) };
    const previous = entries.get(ref.threadId);
    if (!previous || !previous.version && entry.version || entry.title.length > previous.title.length && !previous.version) entries.set(ref.threadId, entry);
  });
  if (!entries.size && !/no (?:games|threads|results|items)|nothing (?:found|to show)/i.test((scope.length ? scope : $('body')).text())) throw new Error('No game thread listing was recognised. Check this source’s latest-updates URL and feed format in Settings.');
  return [...entries.values()];
}
export function hostMatches(host, domain) { return host === domain || host.endsWith(`.${domain}`); }
export function popupAllowed(url, site) {
  if (!httpUrl(url)) return false;
  const dest = new URL(url);
  if (site.blockedHosts.some(host => hostMatches(dest.hostname, host))) return false;
  return true;
}

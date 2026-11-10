const providers = [
  ['MEGA', /\bmega(?:\.nz)?\b/i], ['MediaFire', /\bmediafire\b/i],
  ['Pixeldrain', /\bpixeldrain\b/i], ['GoFile', /\bgofile\b/i],
  ['Google Drive', /drive\.google\.com|\bgoogle drive\b|\bgdrive\b/i],
  ['Buzzheavier', /\bbuzzheavier\b/i], ['MixDrop', /\bmixdrop\b/i],
  ['Workupload', /\bworkupload\b/i], ['1fichier', /\b1fichier\b/i],
  ['Krakenfiles', /\bkrakenfiles\b/i], ['Dropbox', /\bdropbox\b/i],
  ['Bunkr', /\bbunkr\b/i], ['FileDitch', /\bfileditch\b/i],
  ['FastUpload', /\bfastupload\b/i], ['Uploadhaven', /\buploadhaven\b/i],
  ['AnonFiles', /\banonfiles\b/i], ['Qiwi', /\bqiwi\b/i], ['RPDL', /\brpdl\b/i]
];
const platforms = [
  ['Windows', /\b(?:windows|win(?:32|64)?|pc)\b/i], ['macOS', /\b(?:macos|mac(?:\s*os(?:\s*x)?)?|osx)\b/i],
  ['Linux', /\blinux\b/i], ['Android', /\b(?:android|apk)\b/i], ['Web', /\b(?:web|browser|html5)\b/i]
];
const block = /^(?:br|p|div|li|section|h[1-6]|tr|td|ul|ol|details|summary)$/;
const start = /^(?:downloads?(?:\s+links?)?|mirrors?)\s*(?::|[-–—]\s|$)/i;
const end = /^(?:install(?:ation)?(?:\s+(?:instructions|guide))?|changelog|change log|screenshots?|gallery|overview|description|developer(?: notes)?|support|archive password|password|extras?|patch(?:es)?|walkthrough|mods?|translations?)\s*(?::|[-–—]\s|$)/i;
const archive = /\.(?:zip|7z|rar|apk)(?:$|[?#])/i;

export function openingPostDownloads($, content, threadUrl) {
  const forum = new URL(threadUrl);
  const rows = [], seen = new Set();
  let pending = '', group = '', inDownloads = false;

  function readHeading() {
    let heading = pending.trim().replace(/^(?:spoiler\s*:\s*|[\s*•]+)+/i, '');
    pending = '';
    if (!heading || heading.length > 110) return;
    if (end.test(heading)) { inDownloads = false; group = ''; return; }
    if (start.test(heading)) {
      inDownloads = true;
      group = '';
      heading = heading.replace(start, '').trim();
    }
    const matches = platforms.filter(([, pattern]) => pattern.test(heading));
    if (matches.length && (/[:\]]$/.test(heading) || /^(?:windows|win(?:32|64)?|pc|mac|osx|linux|android|apk|web|browser|html5)/i.test(heading) || inDownloads)) {
      group = matches.map(([platform]) => platform).join(' / ');
    }
  }

  function addLink(node) {
    readHeading();
    const anchor = $(node);
    const label = (anchor.text().trim() || anchor.find('img[alt]').first().attr('alt') || '').replace(/\s+/g, ' ').slice(0, 80);
    let url;
    try { url = new URL(anchor.attr('href'), threadUrl); } catch { return; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.') ||
      /^(?:localhost|.*\.localhost|.*\.local)$|^[\d.]+$/i.test(url.hostname) || url.hostname.includes(':')) return;
    const exit = url.origin === forum.origin && /^\/dl\/[^/]+/i.test(url.pathname);
    const provider = providers.find(([, pattern]) => pattern.test(exit ? label : url.hostname))?.[0];
    const file = archive.test(url.pathname);
    const markedDownload = /\b(?:download|mirror|part\s*\d+)\b/i.test(label);
    if (exit ? !inDownloads && !group && !provider && !markedDownload
      : (!inDownloads && !group) || (!provider && !file && !(url.origin !== forum.origin && markedDownload))) return;
    const linkPlatforms = platforms.filter(([, pattern]) => pattern.test(label) && !/^https?:/i.test(label)).map(([platform]) => platform);
    const platform = linkPlatforms.join(' / ') || group || 'Other downloads';
    const key = platform + '\n' + url.href;
    if (seen.has(key)) return;
    seen.add(key);
    const display = label && !/^https?:/i.test(label) ? label : provider || (exit ? 'Forum download' : url.hostname);
    rows.push({ platform, label: display, url: url.href });
  }

  function visit(node) {
    if (rows.length >= 60) return;
    if (node.type === 'text') { pending += node.data; return; }
    if (node.name === 'a' && node.attribs.href) { addLink(node); return; }
    const boundary = block.test(node.name || '');
    if (boundary) readHeading();
    for (const child of node.children || []) visit(child);
    if (boundary) readHeading();
  }
  for (const node of content.contents().toArray()) visit(node);
  return rows;
}

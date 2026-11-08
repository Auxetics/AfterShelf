// URL identity helpers are shared by the main process and local renderer.
export function siteOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Enter an HTTPS site address without credentials.');
  return url.origin;
}
export function threadReference(value, origin) {
  const url = new URL(value, origin);
  if (url.origin !== new URL(origin).origin) throw new Error('This thread belongs to a different site. Choose its website source first.');
  const match = /^\/threads\/(?:[^/]*\.)?(\d+)(?:\/|$)/.exec(url.pathname);
  if (!match) throw new Error('Open or paste a game thread URL, such as /threads/game-name.12345/.');
  return { origin: url.origin, threadId: match[1], threadUrl: `${url.origin}${url.pathname.replace(/\/page-\d+\/?$/, '/')}` };
}

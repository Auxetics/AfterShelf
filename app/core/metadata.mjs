import path from 'node:path';
import * as cheerio from 'cheerio';
import { assertNoLinks, readSmall } from './files.mjs';
import { normalizeVersion, versionKnown, versionRelation, updateSkipped } from './model.mjs';
import { sameThread } from './sources.mjs';
import { previouslyNotified, recordForumRelease, rememberWatchedRelease } from './release-history.mjs';

function plistValues(text) {
  const $ = cheerio.load(text, { xml: true }), result = {};
  $('plist > dict > key').each((_index, key) => { const value = $(key).next(); if (value.is('string')) result[$(key).text()] = value.text(); });
  return result;
}
function literal(text, field) {
  const expression = new RegExp(`^\\s*(?:define\\s+)?config\\.${field}\\s*=\\s*(?:_\\(\\s*)?(["'])([^\\r\\n]*?)\\1\\s*\\)?\\s*(?:#.*)?$`, 'm');
  const match = expression.exec(text);
  // Accept literal values only, never concatenate/evaluate game expressions.
  return match && !/["'\\]/.test(match[2]) ? match[2].trim().slice(0, 200) : '';
}
export async function readLocalMetadata(root, engine = 'custom') {
  const result = { title: '', version: '', versionSource: '', checkedAt: Date.now(), warnings: [] };
  async function read(relative) {
    try { const file = path.join(root, relative); await assertNoLinks(root, file); return await readSmall(file, 512000); }
    catch (error) { result.warnings.push(`Could not read ${relative}: ${error.code || error.message}`); return ''; }
  }
  if (/\.app$/i.test(root)) {
    const plist = plistValues(await read('Contents/Info.plist'));
    result.title = (plist.CFBundleDisplayName || plist.CFBundleName || '').slice(0, 200);
    if (versionKnown(plist.CFBundleShortVersionString)) {
      result.version = normalizeVersion(plist.CFBundleShortVersionString).slice(0, 100);
      result.versionSource = 'Contents/Info.plist · CFBundleShortVersionString';
    }
    // CFBundleVersion is often a build timestamp; it is not a game release.
  }
  if (engine === 'renpy') {
    for (const relative of ['game/options.rpy', 'Contents/Resources/autorun/game/options.rpy', 'Contents/Resources/game/options.rpy']) {
      const text = await read(relative), name = literal(text, 'name'), version = literal(text, 'version');
      if (name) result.title = name;
      if (versionKnown(version)) { result.version = normalizeVersion(version).slice(0, 100); result.versionSource = `${relative} · config.version`; break; }
    }
  }
  return result;
}
export function applyLocalMetadata(game, metadata, { force = false } = {}) {
  game.localMetadata = metadata;
  if (!game.installation || !versionKnown(metadata.version)) return;
  if (force || !versionKnown(game.installedVersion) || game.installedVersionSource && game.installedVersionSource !== 'manual') {
    game.installedVersion = metadata.version;
    game.installation.version = metadata.version;
    game.installedVersionSource = metadata.versionSource;
  }
}
export function applyForumMetadata(state, id, metadata, { onWatchedRelease, now = Date.now() } = {}) {
  const game = state.games.find(item => item.id === id);
  if (!game) throw new Error('This game is no longer in your library.');
  const before = sameThread(game, metadata) ? game.latestVersion : '';
  const change = versionRelation(before, metadata.latestVersion);
  if (state.games.some(item => item.id !== id && sameThread(item.alternateThread, metadata))) throw new Error('That thread is an alternate link on another game.');
  const duplicate = state.games.find(item => item.id !== id && item.origin === metadata.origin && item.threadId === metadata.threadId);
  if (duplicate?.installation && duplicate.installation.root !== game.installation?.root) throw new Error('That thread already belongs to another installed game. Remove the duplicate library entry or choose another thread first.');
  if (game.origin !== metadata.origin || String(game.threadId) !== String(metadata.threadId)) { delete game.lastFeedFingerprint; delete game.versionVerifiedAt; }
  if (game.alternateThread?.origin === metadata.origin) {
    game.alternateThread = game.threadUrl && game.origin !== metadata.origin
      ? { origin: game.origin, threadId: game.threadId, threadUrl: game.threadUrl } : null;
  }
  if (duplicate) {
    for (const job of state.downloads) if (job.gameId === duplicate.id) job.gameId = id;
    state.games = state.games.filter(item => item.id !== duplicate.id);
    if (!game.cover && duplicate.cover) game.cover = duplicate.cover;
  }
  for (const key of ['origin', 'threadId', 'threadUrl', 'title', 'latestVersion', 'description', 'creator', 'archivePassword', 'tags', 'checkedAt', 'metadataParserVersion']) {
    if (metadata[key] != null) game[key] = metadata[key];
  }
  if (!game.coverPinned) {
    if (metadata.cover) {
      game.cover = metadata.cover;
      game.coverImageId = metadata.coverImageId || '';
    }
    for (const key of ['coverStatus', 'coverError']) if (metadata[key] != null) game[key] = metadata[key];
  }
  const detected = recordForumRelease(game, metadata, now);
  const release = detected || { origin: metadata.origin, threadId: metadata.threadId, version: metadata.latestVersion };
  if (onWatchedRelease && game.watching && (change === 'newer' || change === 'different') && !updateSkipped(game) && !previouslyNotified(game, release)) {
    rememberWatchedRelease(game, release, now);
    onWatchedRelease({ gameId: game.id, ...release });
  }
  if (metadata.engine && metadata.engine !== 'custom') game.engine = metadata.engine;
  if (versionKnown(metadata.latestVersion)) game.versionVerifiedAt = metadata.checkedAt || Date.now();
  if (metadata.metadataParserVersion >= 2) game.metadataNeedsRefresh = false;
  return game;
}

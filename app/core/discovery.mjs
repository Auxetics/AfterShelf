import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertNoLinks, exists, isInside, readSmall, realDirectory } from './files.mjs';
import { newGame } from './model.mjs';
import { archiveTitle, isArchiveName } from './archive-names.mjs';
import { readLocalMetadata } from './metadata.mjs';
import { archiveMatchesInstalled } from './reconciliation.mjs';

const SKIP = new Set(['.library', '.git', 'node_modules', '__MACOSX', 'renpy', 'lib', 'libs', 'game', 'www', 'js', 'assets', 'images', 'audio', 'video', 'saves', 'save', 'savedata', 'cache', 'docs', 'documentation', 'manual', 'screenshots']);
const HELPER = /(?:crash|unins|notification|setup|installer|redist)/i;
function titleFromFolder(value) { return value.replace(/\.(?:app|exe|html?|sh)$/i, '').replace(/[_-]+/g, ' ').trim() || value; }
async function marker(root, relative) {
  const file = path.join(root, relative);
  await assertNoLinks(root, file);
  return exists(file);
}
async function identify(root, entries, platform) {
  const files = entries.filter(item => item.isFile()).map(item => item.name);
  const directories = entries.filter(item => item.isDirectory()).map(item => item.name);
  const nativeApps = directories.filter(name => /\.app$/i.test(name));
  const executables = files.filter(name => /\.(exe|sh)$/i.test(name) && !HELPER.test(name));
  const html = files.filter(name => /\.html?$/i.test(name) && !/^(?:readme|manual|changelog|licen[cs]e|credits)(?:[._ -]|$)/i.test(name));
  const appBundle = /\.app$/i.test(root) && directories.includes('Contents');
  // Readmes, launch helpers, and other loose files in an extracted wrapper must
  // not turn that wrapper into a different game and hide its application(s).
  if (!appBundle && nativeApps.length) return null;
  let engine = 'custom', title = titleFromFolder(path.basename(root));
  if (directories.includes('renpy') || await marker(root, 'Contents/Resources/autorun/renpy')) engine = 'renpy';
  else if (await marker(root, 'js/rmmz_core.js') || await marker(root, 'www/js/rmmz_core.js')) engine = 'rpgmz';
  else if (await marker(root, 'js/rpg_core.js') || await marker(root, 'www/js/rpg_core.js')) engine = 'rpgmv';
  else if (files.some(name => /UnityPlayer\.dll$/i.test(name)) || await marker(root, 'Contents/Frameworks/UnityPlayer.dylib')) engine = 'unity';
  else if (files.some(name => /project\.godot$|\.pck$/i.test(name))) engine = 'godot';
  else if (files.some(name => /^data\.win$/i.test(name))) engine = 'gamemaker';
  else if (await marker(root, 'data/system/Config.tjs')) engine = 'tyrano';
  else if (files.some(name => /^RGSS3.*\.dll$/i.test(name))) engine = 'rpgvxa';
  else if (files.some(name => /^RGSS2.*\.dll$/i.test(name))) engine = 'rpgvx';
  else if (files.some(name => /^RGSS1.*\.dll$/i.test(name))) engine = 'rpgxp';
  else if (files.some(name => /^RPG_RT\.exe$/i.test(name))) engine = 'rpg2k';
  else if (files.some(name => /\.xp3$/i.test(name))) engine = 'kirikiri';
  else if (await marker(root, 'Data/Data.wolf')) engine = 'wolf';
  else if (directories.includes('Engine') && executables.length) engine = 'unreal';
  else if (html.length) {
    const sample = await readSmall(path.join(root, html.find(name => /^index\.html?$/i.test(name)) || html[0]), 4_000_000);
    engine = /SugarCube|format="SugarCube"/i.test(sample) ? 'sugarcube' : /format="Harlowe"|harlowe/i.test(sample) ? 'harlowe' : 'html';
  }
  if (!appBundle && !executables.length && !html.length && engine === 'custom') return null;
  // An application bundle is the installation and launch target, not its parent.
  const launchers = appBundle ? [root] : platform === 'darwin'
    ? [...nativeApps.map(name => path.join(root, name)), ...executables.filter(name => /\.sh$/i.test(name)).map(name => path.join(root, name)), ...html.map(name => path.join(root, name))]
    : [...executables.filter(name => /\.exe$/i.test(name)).map(name => path.join(root, name)), ...html.map(name => path.join(root, name))];
  if (appBundle) {
    const plist = await readSmall(path.join(root, 'Contents', 'Info.plist'));
    title = /<key>CFBundleDisplayName<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] || title;
  }
  const primary = launchers.find(file => /(?:^|\/)index\.html?$/i.test(file)) || (launchers.length === 1 ? launchers[0] : '');
  const metadata = await readLocalMetadata(root, engine);
  return { id: createHash('sha256').update(root).digest('hex').slice(0, 24), root, title: metadata.title || title, engine, launch: primary, launchers, localMetadata: metadata, platformCompatible: launchers.length > 0 };
}

export async function discoverGames(folder, { platform = process.platform, existing = [], installedGames = [], downloads = [], maxDirectories = 3000, maxDepth = 5, signal, progress = () => {} } = {}) {
  const root = await realDirectory(folder), candidates = [], warnings = [], excluded = [];
  for (const item of existing) { try { excluded.push(await fs.realpath(item)); } catch { excluded.push(path.resolve(item)); } }
  const knownDownloads = new Map();
  for (const job of downloads) { if (job.path && !job.archiveRemoved) { try { knownDownloads.set(await fs.realpath(job.path), job); } catch {} } }
  let count = 0, limitReached = false;
  async function visit(directory, depth) {
    signal?.throwIfAborted();
    if (excluded.some(item => directory === item || isInside(item, directory))) return;
    if (++count > maxDirectories) { limitReached = true; return; }
    if (count % 20 === 0) progress({ count, found: candidates.length });
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { warnings.push(`Could not read ${path.relative(root, directory) || '.'} (${error.code || 'error'}).`); return; }
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (!entry.isFile() || !isArchiveName(entry.name) || entry.name.startsWith('.')) continue;
      if (archiveMatchesInstalled(entry.name, installedGames)) continue;
      const file = path.join(directory, entry.name), known = knownDownloads.get(file);
      if (known && (known.gameId || !['downloaded', 'awaiting-folder'].includes(known.status))) continue;
      try {
        const stat = await fs.stat(file);
        candidates.push({ id: createHash('sha256').update(file).digest('hex').slice(0, 24), kind: 'archive', path: file, root: directory, filename: entry.name, title: archiveTitle(entry.name), engine: 'custom', size: stat.size, modified: stat.mtimeMs, downloadId: known?.id || null });
      } catch (error) { warnings.push(`Could not inspect archive ${entry.name} (${error.code || 'error'}).`); }
    }
    let candidate;
    // The selected library directory is a collection. Loose executables or HTML
    // documents there must not end traversal before checking its game folders.
    // A directly selected .app remains a valid individual installation.
    try { if (directory !== root || /\.app$/i.test(root)) candidate = await identify(directory, entries.filter(item => !item.isSymbolicLink()), platform); }
    catch (error) { warnings.push(`Could not inspect ${path.relative(root, directory) || '.'}: ${error.message}`); }
    if (candidate) { candidates.push({ ...candidate, kind: 'installation' }); return; }
    if (depth >= maxDepth) return;
    for (const item of entries) {
      if (limitReached) break;
      if (!item.isDirectory() || item.isSymbolicLink() || item.name.startsWith('.') || SKIP.has(item.name.toLowerCase())) continue;
      await visit(path.join(directory, item.name), depth + 1);
    }
  }
  await visit(root, 0);
  if (limitReached) warnings.push(`Stopped after ${maxDirectories} folders. Scan a more specific games folder to find the rest.`);
  return { root, candidates, warnings, inspected: Math.min(count, maxDirectories) };
}

export function localGame(candidate, origin) {
  return newGame({ id: `local:${candidate.id}`, origin, threadId: '', threadUrl: '', title: candidate.title, engine: candidate.engine,
    installedVersion: candidate.localMetadata?.version || '', installedVersionSource: candidate.localMetadata?.versionSource || '', localMetadata: candidate.localMetadata,
    installation: { root: candidate.root, container: candidate.root, launch: candidate.launch, managed: false, version: candidate.localMetadata?.version || '', at: Date.now() },
    needsLaunchTarget: !candidate.launch, discoveredLocally: true });
}

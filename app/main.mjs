import { app, BrowserWindow, WebContentsView, session, ipcMain, dialog, shell, clipboard, Menu, nativeImage, net, Notification } from 'electron';
import fs from 'node:fs/promises';
import { existsSync, accessSync, constants, lstatSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Store } from './core/store.mjs';
import { newGame, gameKey, ENGINES, ACTIVE_DOWNLOADS, canInstallArchive, offerInstallation, canLaunchGame, normalizedTitle, PLAY_STATUSES, LAUNCH_LOCALES, hasUpdate, updateSkipped } from './core/model.mjs';
import { isWindowsX86Executable, LOCALE_EMULATOR_PROFILE } from './core/launch-locale.mjs';
import { parseThread, detectImageMime } from './core/site.mjs';
import { safeName, exists, realDirectory, isInside, walk, assertNoLinks } from './core/files.mjs';
import { savePlan, inspectInstallation, transferSaves } from './core/saves.mjs';
import { extractZip, zipInstallContainer, zipExpandedSize } from './core/archive.mjs';
import { ForumBrowser } from './browser.mjs';
import { discoverGames, localGame } from './core/discovery.mjs';
import { ensureDownloadGame, importArchive, dismissDownloads, applyDownloadSource, assignDownloadGame } from './core/downloads.mjs';
import { readLocalMetadata, applyLocalMetadata, applyForumMetadata } from './core/metadata.mjs';
import { detectLauncher } from './core/launchers.mjs';
import { checkInstalledVersion } from './core/install-version.mjs';
import { inspectLibraryPresence, applyLibraryPresence } from './core/reconciliation.mjs';
import { removePartialDownload } from './core/download-cleanup.mjs';
import { manualInstallReason } from './core/install-policy.mjs';
import { planGameDeletion, deleteGameFiles, removalRoots, forgetGame } from './core/removal.mjs';
import { ForumMetadata } from './core/forum-metadata.mjs';
import { sessionResponse } from './core/session-response.mjs';
import { checkAllSourceUpdates } from './core/update-checker.mjs';
import { APP_NAME, profileDirectory, syncDockBadge } from './core/desktop.mjs';
import { configuredSources, sourceById, sourceForUrl, sourceThreadReference, sourceId, updateSourceSettings, checkSourceStatus, sameThread, gameMatchesThread, gameSearchSource } from './core/sources.mjs';
import { AppUpdater, restartBlockReason } from './core/app-updater.mjs';
import { listGameSaves, readRenpySlot, readRenpySave, editRenpySave, readRpgSave, editRpgSave, labelRpgFields } from './core/save-tools.mjs';
import { exportLibraryPayload, importLibraryPayload } from './core/library-transfer.mjs';
import { installationFolder, measureStorage, storageByDrive } from './core/game-storage.mjs';
import { gamesFolders, gamesFolderFor, containingGamesFolder } from './core/game-folders.mjs';
import { registerHtmlScheme, htmlGameOpen, launchHtmlGame, closeHtmlGames } from './core/html-games.mjs';

import { recordForumRelease, recordHtmlSession } from './core/release-history.mjs';
import { isArchiveName } from './core/archive-names.mjs';
import { ThreadGallery } from './core/thread-gallery.mjs';

registerHtmlScheme();

const directory = path.dirname(fileURLToPath(import.meta.url));
const uiFile = path.join(directory, 'ui', 'index.html');
const localeEmulator = path.join(app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), '.cache'), 'locale-emulator', 'LEProc.exe');
const profile = profileDirectory(app.getPath('appData'), existsSync);
const threadGallery = new ThreadGallery(path.join(profile, 'thread-photos'));
mkdirSync(profile, { recursive: true });
app.setName(APP_NAME);
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.enableSandbox();
let window, store, browser, appUpdater, quitConfirmed = false, interval, closingForFlush = false;
let libraryScanController;
const activeItems = new Map(), operations = new Map();
const watchNotifications = new Set();
const detailOperations = new Set();
let metadataRequests = Promise.resolve(), nextMetadataRequest = 0;
let downloadPicker;
const currentRuntime = () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  activeDownloads: activeItems.size,
  activeInstallations: operations.size,
  activeDetailScans: detailOperations.size,
  activeLibraryScan: Boolean(libraryScanController),
  appUpdate: appUpdater ? appUpdater.snapshot() : { status: 'idle', version: '', received: 0, total: 0, percent: 0 }
});
const notify = () => { syncDockBadge(app, store.data.games); browser?.syncOverlays(); if (window && !window.isDestroyed()) window.webContents.send('library:state', { ...store.snapshot(), runtime: currentRuntime() }); };
const getGame = id => { const game = store.data.games.find(game => game.id === id); if (!game) throw new Error('Game no longer exists in the library.'); return game; };
const getJob = id => { const job = store.data.downloads.find(job => job.id === id); if (!job) throw new Error('Download no longer exists.'); return job; };
const updateJob = (id, changes) => store.update(state => { const job = state.downloads.find(item => item.id === id); if (job) Object.assign(job, changes); });
const activeWork = () => activeItems.size > 0 || operations.size > 0;
const text = value => typeof value === 'string' ? value.trim() : '';
function deletionOptions(roots, signal) {
  return {
    collectionRoot: store.data.settings.gamesRoot,
    protectedRoots: [...gamesFolders(store.data.settings), ...(store.data.ignoredGameRoots || []).filter(root => !roots.includes(root)), ...['home', 'desktop', 'documents', 'downloads', 'appData'].map(name => app.getPath(name))],
    protectedTrees: [app.getPath('userData'), app.getAppPath(), app.getPath('exe')],
    signal
  };
}
async function gameSave(id, file) {
  const inventory = await listGameSaves(getGame(id));
  const save = inventory.files.find(item => item.file === file);
  if (!save) throw new Error('This save is no longer available. Refresh the Saves panel.');
  return save;
}
function retainedVersion(game, root) {
  const version = game.previous.find(item => item.root === root);
  if (!version) throw new Error('This version is no longer in the library.');
  return version;
}
async function chooseFolder(title, defaultPath) {
  const result = await dialog.showOpenDialog(window, { title, defaultPath: defaultPath || store.data.settings.gamesRoot || app.getPath('home'), properties: ['openDirectory', 'createDirectory', 'treatPackageAsDirectory'] });
  return result.canceled ? null : realDirectory(result.filePaths[0]);
}
async function requireRoot(root = store.data.settings.gamesRoot) {
  if (!root) throw new Error('Choose your games folder in Settings first.');
  try { const resolved = await realDirectory(root); await fs.access(resolved, constants.W_OK); return resolved; }
  catch { throw new Error('Games folder is offline or not writable: ' + root); }
}
async function addMeta(meta) {
  if (!meta.coverStatus) meta = await metadataClient(meta.origin).withCover(meta);
  const match = store.data.games.find(game => gameMatchesThread(game, meta));
  if (sameThread(match?.alternateThread, meta)) return match.id;
  const id = match?.id || gameKey(meta.origin, meta.threadId);
  await store.update(state => {
    const existing = state.games.find(game => game.id === id);
    if (existing) applyForumMetadata(state, existing.id, meta);
    else {
      const game = newGame(meta);
      recordForumRelease(game, meta);
      state.games.unshift(game);
    }
  });
  return id;
}
function metadataClient(source = store.data.settings.site) {
  const site = typeof source === 'string' ? sourceForUrl(store.data.settings, source) : source;
  return new ForumMetadata(structuredClone(site), (url, options) => {
    const request = metadataRequests.then(async () => {
      const delay = nextMetadataRequest - Date.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      nextMetadataRequest = Date.now() + (options?.headers?.Accept?.startsWith('image/') ? 200 : 1000);
      return sessionResponse(requestOptions => net.request(requestOptions), browser.session, url, options);
    });
    metadataRequests = request.then(() => {}, () => {});
    return request;
  }, (data, { gallery = false } = {}) => {
    const image = nativeImage.createFromBuffer(data);
    if (!image.isEmpty()) {
      const size = image.getSize(), scale = Math.min(1, (gallery ? 1280 : 640) / size.width, (gallery ? 850 : 400) / size.height);
      const resized = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) });
      return gallery ? 'data:image/jpeg;base64,' + resized.toJPEG(82).toString('base64') : resized.toDataURL();
    }
    const mime = detectImageMime(data);
    if (!mime) throw new Error('The cover image could not be decoded.');
    return `data:${mime};base64,${Buffer.from(data).toString('base64')}`;
  }, { renderListing: (url, source) => browser.readListing(url, source) });
}
async function refreshLocalDetails(id) {
  const game = getGame(id); if (!game.installation) return;
  const root = game.installation.root, metadata = await readLocalMetadata(root, game.engine);
  await store.update(state => {
    const target = state.games.find(item => item.id === id);
    if (!target || target.installation?.root !== root) return;
    applyLocalMetadata(target, metadata);
  });
}
async function gameUsesJapaneseLocale(game) {
  if (process.platform !== 'win32' || game.launchLocale === 'default') return false;
  const forced = game.launchLocale === 'ja-JP';
  let suggested = game.installation.threadJapaneseLocale ?? game.threadJapaneseLocale;
  if (!forced && (suggested === false || suggested === undefined && !game.threadUrl)) return false;
  if (!await isWindowsX86Executable(game.installation.launch)) {
    if (forced) throw new Error('Japanese locale mode requires a 32-bit Windows game executable. Choose System default in Edit details to launch this build.');
    return false;
  }
  if (forced || suggested === true) return true;
  // Existing library entries may predate locale detection. Read their opening post once.
  const { id, origin, threadUrl } = game;
  try {
    const metadata = await metadataClient(origin).thread(threadUrl, { cover: false });
    if (typeof metadata.threadJapaneseLocale === 'boolean') {
      suggested = metadata.threadJapaneseLocale;
      await store.update(state => {
        const current = state.games.find(item => item.id === id);
        if (sameThread(current, metadata) && current.threadJapaneseLocale === undefined) current.threadJapaneseLocale = suggested;
      });
    }
  } catch (error) {
    await store.log('Launch locale could not be checked', error.message);
  }
  const current = getGame(id);
  return current.launchLocale === 'ja-JP' || current.launchLocale !== 'default' &&
    (current.installation?.threadJapaneseLocale ?? current.threadJapaneseLocale) === true;
}
async function refreshDetails(id) {
  if (detailOperations.has(id)) throw new Error('Details are already being scanned for this game.');
  detailOperations.add(id); notify();
  try {
    await refreshLocalDetails(id);
    const game = getGame(id);
    if (game.threadUrl) {
      const metadata = await metadataClient(game.origin).thread(game.threadUrl, { cover: !game.coverPinned });
      await store.update(state => { applyForumMetadata(state, id, metadata); });
      if (metadata.coverError) await store.log('Cover needs attention', metadata.coverError);
    }
    return { linked: Boolean(game.threadUrl), version: getGame(id).installedVersion, coverError: getGame(id).coverError || '' };
  } finally { detailOperations.delete(id); notify(); }
}
async function scanLibrary({ startup = false } = {}) {
  if (store.data.libraryScan.active) throw new Error('A folder scan is already running.');
  const roots = gamesFolders(store.data.settings), root = roots[0];
  if (!root) { if (startup) return; throw new Error('Choose your games folder in Settings first.'); }
  libraryScanController = new AbortController();
  const signal = libraryScanController.signal;
  await store.update(state => { state.libraryScan = { active: true, message: 'Looking for existing games…', candidates: [], warnings: [] }; });
  try {
    const presence = await inspectLibraryPresence([...store.data.games], roots, { signal });
    await store.update(state => applyLibraryPresence(state, presence));
    const result = { root, candidates: [], warnings: [], inspected: 0 };
    let last = 0;
    for (const folder of roots) {
      if (presence.unavailable.has(folder)) {
        result.warnings.push('Games folder unavailable: ' + folder + ' (' + presence.unavailable.get(folder) + ').');
        continue;
      }
      const scan = await discoverGames(folder, { signal, installedGames: store.data.games, existing: [...store.data.games.flatMap(game => [game.installation?.root, ...game.previous.map(item => item.root)]).filter(Boolean), ...(startup ? store.data.ignoredGameRoots || [] : [])], downloads: store.data.downloads, progress: ({ count, found }) => {
        if (Date.now() - last > 300) { last = Date.now(); void store.update(state => { state.libraryScan.message = 'Checked ' + (result.inspected + count) + ' folders · ' + (result.candidates.length + found) + ' items found'; }); }
      }});
      result.inspected += scan.inspected;
      result.candidates.push(...scan.candidates.map(candidate => ({ ...candidate, collectionRoot: folder })));
      result.warnings.push(...scan.warnings);
    }
    await store.update(state => {
      let added = 0;
      if (startup) for (const candidate of result.candidates) {
        if (candidate.kind !== 'installation' || candidate.engine === 'custom' || !candidate.platformCompatible) continue;
        // Similar names may be another version or a pending extraction. Leave
        // those for explicit review instead of inventing a thread association.
        if (state.games.some(game => game.installation?.root === candidate.root || normalizedTitle(game.localMetadata?.title || game.title) === normalizedTitle(candidate.title))) continue;
        state.games.unshift(localGame(candidate, state.settings.site.origin)); added++;
      }
      state.libraryScan = { active: false, message: `${result.inspected} folders checked · ${result.candidates.length} items found${startup ? ` · ${added} new games added` : ''}`, candidates: result.candidates, warnings: result.warnings };
    });
    return result;
  } catch (error) {
    await store.update(state => { state.libraryScan.active = false; state.libraryScan.message = error.name === 'AbortError' ? 'Folder scan cancelled' : error.message; });
    if (error.name === 'AbortError') return { root, candidates: [], warnings: [], cancelled: true };
    throw error;
  } finally { libraryScanController = null; }
}
async function prepareImports(ids = []) {
  if (!Array.isArray(ids) || ids.length > 500) throw new Error('Choose up to 500 discovered games at a time.');
  if (store.data.libraryScan.active) throw new Error('Wait for the folder scan to finish.');
  const imports = [];
  for (const id of new Set(ids)) {
    const candidate = store.data.libraryScan.candidates.find(item => item.id === id);
    if (!candidate || !gamesFolders(store.data.settings).includes(candidate.collectionRoot)) throw new Error('A selected result is no longer available. Scan your games folders again.');
    const root = await realDirectory(candidate.collectionRoot);
    await assertNoLinks(root, candidate.root);
    if (await realDirectory(candidate.root) !== candidate.root) throw new Error('A game folder moved since the scan. Scan again.');
    if (candidate.kind === 'archive') {
      await assertNoLinks(root, candidate.path);
      const stat = await fs.stat(candidate.path);
      if (!stat.isFile() || stat.size !== candidate.size || stat.mtimeMs !== candidate.modified) throw new Error('An archive changed since the scan. Wait for it to finish downloading, then scan again.');
      imports.push(candidate); continue;
    }
    if (store.data.games.some(game => game.installation?.root === candidate.root || game.previous.some(item => item.root === candidate.root))) continue;
    if (candidate.launch && !await exists(candidate.launch)) throw new Error('A discovered launch file moved. Scan again.');
    imports.push(localGame(candidate, store.data.settings.site.origin));
  }
  return imports;
}
function applyImports(state, imports) {
  let added = 0;
  for (const entry of imports) {
    if (entry.kind === 'archive') { if (importArchive(state, entry).added) added++; }
    else if (!state.games.some(game => game.id === entry.id)) { state.games.unshift(entry); state.ignoredGameRoots = (state.ignoredGameRoots || []).filter(root => !isInside(root, entry.installation.root, true)); added++; }
  }
  return added;
}
async function chooseLaunch(root, engine, { automatic = false, title = '' } = {}) {
  const info = await inspectInstallation(root, engine);
  const detected = await detectLauncher(root, info, { title });
  let launch = detected.launch;
  if (!launch) {
    if (automatic) throw new Error(detected.reason);
    const result = await dialog.showOpenDialog(window, { title: 'Select the game executable, .app, or HTML file', defaultPath: root, properties: ['openFile', 'openDirectory'], filters: process.platform === 'win32' ? [{ name: 'Game', extensions: ['exe', 'html', 'htm'] }] : [] });
    if (result.canceled) return null;
    launch = result.filePaths[0];
  }
  if (!isInside(root, launch, true)) throw new Error('Choose a launch target inside the selected game folder.');
  return { launch, info, root: launch === detected.launch ? detected.root : /\.app$/i.test(launch) ? launch : root };
}
async function cleanupArchive(job) {
  if (!job.path || job.status !== 'installed') return;
  try { await fs.unlink(job.path); await updateJob(job.id, { archiveRemoved: true, error: '' }); }
  catch (error) {
    if (error.code === 'ENOENT') await updateJob(job.id, { archiveRemoved: true });
    else await updateJob(job.id, { error: 'Game installed successfully, but its archive could not be deleted. Use Retry cleanup.' });
  }
}
async function cleanupPartial(id) {
  const job = getJob(id);
  try {
    if (await removePartialDownload(job, { gamesRoot: job.downloadRoot || containingGamesFolder(store.data.settings, job.path), games: store.data.games, downloads: store.data.downloads })) await updateJob(id, { partialRemoved: true, partialCleanupError: '', phase: 'Incomplete file removed. Open the game thread to download again.' });
  } catch (error) { await updateJob(id, { partialCleanupError: error.message }); }
}
function placeManagedRelease(root, container, gameRoot, title) {
  const standaloneApp = container === gameRoot && /\.app$/i.test(container);
  const extension = standaloneApp ? '.app' : '';
  const name = safeName(standaloneApp ? path.basename(container, path.extname(container)) : title).replace(/^\.+/, '') || 'Game';
  const base = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(name) ? '_' + name : name;
  let destination = path.join(root, base + extension);
  for (let n = 2; lstatSync(destination, { throwIfNoEntry: false }); n++) {
    destination = path.join(root, base + ' (' + n + ')' + extension);
  }
  // Keep the collision check and move together across concurrent installs.
  renameSync(container, destination);
  return destination;
}
function installGamesFolder(job, game) {
  const settings = store.data.settings;
  if ((job.extractedPath || job.stagingPath) && job.installRoot) return job.installRoot;
  if (game.preferredGamesRoot || game.installation) return gamesFolderFor(settings, game);
  return job.downloadRoot || containingGamesFolder(settings, job.path) || gamesFolderFor(settings, game);
}
function displaySize(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GiB';
  return (bytes / 1024 ** 2).toFixed(1) + ' MiB';
}
async function reviewInstall({ root, job, game, mode, original, signal, fromDownload }) {
  const engine = job.thread?.engine && job.thread.engine !== 'custom' ? job.thread.engine : game.engine;
  const plan = original ? await savePlan(original.root, engine, game.saveOverrides) : null;
  const files = new Set(plan?.local.map(item => path.dirname(item.source)) || []);
  const saves = [...[...files].map(folder => 'Local: ' + folder), ...(plan?.external || []).map(folder => 'External: ' + folder)];
  let required = mode === 'zip' ? await zipExpandedSize(job.path, signal) : 0;
  for (const item of plan?.local || []) required += (await fs.stat(item.source)).size;
  const volume = await fs.statfs(root).catch(error => {
    if (['ENOSYS', 'ENOTSUP'].includes(error.code)) return null;
    throw error;
  });
  const free = volume ? volume.bavail * volume.bsize : null;
  if (free != null && required > free && (mode === 'zip' || mode === 'resume' && job.stagingPath)) {
    throw new Error('Not enough space in ' + root + '. Need at least ' + displaySize(required) + '; available ' + displaySize(free) + '.');
  }
  signal.throwIfAborted();
  const update = original ? 'Update' : 'Install';
  const detail = [
    (mode === 'zip' ? 'Destination: ' : 'Games folder: ') + root,
    'Available space: ' + (free == null ? 'Unavailable' : displaySize(free)) + (mode === 'zip' ? ' · Estimated extraction and saves: ' + displaySize(required) : ''),
    ...(saves.length ? ['Detected save locations:', ...saves.slice(0, 8), ...(saves.length > 8 ? [String(saves.length - 8) + ' more in the Saves panel.'] : [])] : ['No save locations detected.']),
    ...(mode === 'resume' && job.extractedPath ? ['Resume from: ' + job.extractedPath] : []),
    ...(mode === 'folder' || mode === 'external'
      ? [manualInstallReason(job, engine) || 'You’ll select the extracted game folder to finish.'] : []),
    'Close the game before continuing.'
  ].join('\n');
  const choice = await dialog.showMessageBox(window, {
    type: 'question', message: fromDownload ? job.filename + ' is ready. ' + update + ' the game?' : update + ' ' + game.title + '?',
    detail, buttons: [fromDownload ? 'Keep download only' : 'Cancel', update + ' game'], defaultId: 1, cancelId: 0
  });
  return choice.response === 1;
}
async function discardStaging(root, staging) {
  const parent = path.join(root, '.library', 'staging');
  if (path.dirname(staging) !== parent || !/^[0-9a-f-]{36}$/i.test(path.basename(staging))) return;
  await assertNoLinks(root, staging);
  await fs.rm(staging, { recursive: true, force: true });
}
async function install(id, mode = 'auto', fromDownload = false) {
  const job = getJob(id), game = getGame(job.gameId);
  let alternateDownload = false;
  if (job.thread?.threadUrl) {
    const ref = sourceThreadReference(store.data.settings, job.thread.threadUrl);
    if (store.data.games.some(other => other.id !== game.id && other.installation && gameMatchesThread(other, ref))) throw new Error('This source thread already belongs to another installed game. Choose its library entry first.');
    alternateDownload = sameThread(game.alternateThread, ref);
  }
  const extractedAvailable = job.extractedPath && await exists(job.extractedPath);
  if (!canInstallArchive(job) || !extractedAvailable && !await exists(job.path)) throw new Error('The archive and any previous extraction are unavailable. Download the release again.');
  if (mode === 'external' && !await exists(job.path)) throw new Error('The archive is unavailable. Select the extracted game folder instead.');
  if (operations.has(game.id)) throw new Error('This game already has an active installation.');
  if (htmlGameOpen(game.id)) throw new Error('Close the game window before installing an update.');
  // Normal ZIP installation is managed end to end, even if an external app
  // is configured for other formats or explicit manual extraction.
  if (mode === 'auto') {
    const zip = /\.zip$/i.test(job.path);
    mode = extractedAvailable || job.status === 'awaiting-folder' && !(zip && job.stagingPath) ? 'resume' : zip ? 'zip' : 'external';
  }
  const root = await requireRoot(installGamesFolder(job, game)), controller = new AbortController();
  if (operations.has(game.id)) throw new Error('This game already has an active installation.');
  operations.set(game.id, controller);
  let original;
  let forumMetadata, metadataWarning = '';
  let installGame = { ...game, ...job.thread };
  const stagingRoot = path.join(root, '.library', 'staging');
  let staging = '', newRoot = '';
  try {
    original = game.installation && await exists(game.installation.root) ? game.installation : null;
    const previousRoot = game.installation?.gamesRoot || containingGamesFolder(store.data.settings, game.installation?.root);
    if (!original && previousRoot && !await exists(previousRoot)) throw new Error('Reconnect the current game drive before updating so its saves can be transferred.');
    if (!await reviewInstall({ root, job, game, mode, original, signal: controller.signal, fromDownload })) return;
    await updateJob(id, { status: 'installing', installRoot: root, error: '', phase: 'Preparing installation' });
    const threadUrl = job.thread?.threadUrl || game.threadUrl;
    if (threadUrl) {
      await updateJob(id, { phase: 'Reading linked forum details and cover' });
      try {
        const ref = sourceThreadReference(store.data.settings, threadUrl);
        forumMetadata = await metadataClient(ref.origin).thread(ref.threadUrl);
        installGame = { ...installGame, ...forumMetadata };
      } catch (error) { metadataWarning = `Installed using available game details. Forum refresh failed: ${error.message}`; }
    }
    controller.signal.throwIfAborted();
    const manualReason = manualInstallReason(job, installGame.engine);
    if (manualReason && mode !== 'external') throw new Error(manualReason);
    if (mode === 'external') {
      const extractor = store.data.settings.extractor;
      if (extractor && process.platform === 'darwin' && extractor.endsWith('.app')) spawn('/usr/bin/open', ['-a', extractor, job.path], { detached: true, stdio: 'ignore' }).unref();
      else if (extractor) { const process = spawn(extractor, [job.path], { detached: true, stdio: 'ignore', cwd: root }); process.on('error', error => store.log('External extractor failed', error.message)); process.unref(); }
      else { const error = await shell.openPath(job.path); if (error) throw new Error(error); }
      await updateJob(id, { status: 'awaiting-folder', phase: 'Extract using your chosen app, then select its output' });
      if (manualReason) { await updateJob(id, { phase: manualReason }); return; }
      const answer = await dialog.showMessageBox(window, { type: 'info', message: 'Finish installation after extraction', detail: 'Your extraction app has opened. When extraction finishes, select the extracted game folder or .app so AfterShelf can register its launcher and transfer saves. To do this later, choose Finish installation in the library or Downloads.', buttons: ['Later', 'Select extracted game'], defaultId: 1, cancelId: 0 });
      if (!answer.response) return;
      mode = 'folder';
    }
    if (mode === 'resume' && job.extractedPath && await exists(job.extractedPath)) {
      newRoot = await realDirectory(job.extractedPath);
    } else if (mode === 'folder' || mode === 'resume') {
      newRoot = await chooseFolder('Select the extracted game folder or .app', job.extractedPath || root);
      if (!newRoot) { await updateJob(id, { status: 'awaiting-folder' }); return; }
      if (newRoot === root) throw new Error('Choose the extracted game’s own folder, rather than your entire games directory.');
    } else {
      if (!/\.zip$/i.test(job.path)) throw new Error('Use your external extractor for this format, then select the extracted folder. Patches and installers require manual installation.');
      await assertNoLinks(root, stagingRoot);
      await fs.mkdir(stagingRoot, { recursive: true });
      if (job.stagingPath) await discardStaging(root, job.stagingPath);
      staging = path.join(stagingRoot, randomUUID());
      await updateJob(id, { stagingPath: staging, extractedPath: '', phase: 'Extracting the ZIP' });
      let last = 0;
      newRoot = await extractZip(job.path, staging, { signal: controller.signal, progress: (count, total) => {
        if (Date.now() - last > 500) { last = Date.now(); void updateJob(id, { phase: `Extracting ${count} of ${total} files` }); }
      }});
    }
    // Keep extracted output resumable if launch selection is cancelled or the app closes.
    if (!staging && job.stagingPath && isInside(stagingRoot, job.stagingPath) && isInside(job.stagingPath, newRoot, true)) staging = job.stagingPath;
    await updateJob(id, { extractedPath: newRoot, stagingPath: staging, phase: 'Confirming extracted game and launch file' });
    controller.signal.throwIfAborted();
    if (original && (isInside(original.root, newRoot, true) || isInside(newRoot, original.root, true))) throw new Error('The new release must be in a separate folder from the original game.');
    const selected = await chooseLaunch(newRoot, installGame.engine, { automatic: mode !== 'folder', title: installGame.title });
    if (!selected) { await updateJob(id, { status: 'awaiting-folder', extractedPath: newRoot, phase: 'Select the extracted folder and launch file to finish' }); return; }
    newRoot = selected.root;
    if (staging) await assertNoLinks(root, newRoot);
    let transferred = 0;
    if (original) {
      await updateJob(id, { phase: 'Transferring saves and preferences' });
      const plan = await savePlan(original.root, installGame.engine, game.saveOverrides);
      transferred = await transferSaves(plan, original.root, newRoot, controller.signal);
    }
    controller.signal.throwIfAborted();
    const managed = Boolean(staging);
    const container = managed ? await zipInstallContainer(staging, newRoot) : newRoot;
    const manifest = (await walk(container, { max: 100000, depth: 30 })).filter(item => !item.directory).map(item => item.relative);
    await updateJob(id, { phase: 'Reading installed release and checking forum version' });
    const localMetadata = await readLocalMetadata(newRoot, installGame.engine === 'custom' ? selected.info.engine : installGame.engine);
    const versionCheck = checkInstalledVersion(localMetadata, forumMetadata?.latestVersion || '');
    controller.signal.throwIfAborted();
    const destination = managed ? placeManagedRelease(root, container, newRoot, installGame.title) : container;
    const installedRoot = path.join(destination, path.relative(container, newRoot));
    const launch = path.join(destination, path.relative(container, selected.launch));
    const installation = { root: installedRoot, container: destination, gamesRoot: managed ? root : containingGamesFolder(store.data.settings, installedRoot), launch, managed, manifest, at: Date.now(), version: localMetadata.version || job.version || '' };
    await store.update(state => {
      applyDownloadSource(state, game.id, job);
      if (forumMetadata && !alternateDownload) applyForumMetadata(state, game.id, forumMetadata);
      const target = state.games.find(item => item.id === game.id);
      if (alternateDownload && forumMetadata) recordForumRelease(target, forumMetadata);
      const alternateLocale = forumMetadata?.threadJapaneseLocale ?? job.thread?.threadJapaneseLocale;
      if (alternateDownload && typeof alternateLocale === 'boolean') installation.threadJapaneseLocale = alternateLocale;
      if (original) target.previous.push(original);
      target.installation = installation; target.installedVersion = installation.version;
      target.availability = { status: 'available', reason: '', checkedAt: Date.now() };
      target.localMetadata = localMetadata; target.installedVersionSource = localMetadata.versionSource || (job.version ? 'Download label (not verified from local files)' : 'Unknown');
      target.installationCheck = { ...versionCheck, metadataWarning, checkedAt: Date.now() };
      if (target.engine === 'custom') target.engine = selected.info.engine;
      const download = state.downloads.find(item => item.id === id);
      Object.assign(download, { status: 'installed', extractedPath: installedRoot, stagingPath: '', phase: `${versionCheck.message} ${transferred} save/preference files transferred.`, metadataWarning, error: '' });
    });
    if (managed && container !== staging) {
      try { await assertNoLinks(root, staging); await fs.rm(staging, { recursive: true }); }
      catch (error) { await store.log('Extraction staging cleanup failed', error.message); }
    }
    await cleanupArchive(getJob(id));
    await store.log('Installation completed', `Thread ${game.threadId}; engine=${game.engine}; transferred=${transferred}`);
    const retention = game.retention === 'default' ? store.data.settings.retention : game.retention;
    const previous = getGame(game.id).previous;
    const remove = retention === 'delete' ? previous : retention === 'previous' ? previous.slice(0, -1) : [];
    for (const old of remove) if (old.managed && old.container && !isInside(old.container, installedRoot, true)) {
      const oldRoot = old.gamesRoot || containingGamesFolder(store.data.settings, old.container);
      if (!oldRoot || !isInside(oldRoot, old.container)) continue;
      try {
        await assertNoLinks(oldRoot, old.container); await fs.rm(old.container, { recursive: true });
        await store.update(state => { const target = state.games.find(item => item.id === game.id); target.previous = target.previous.filter(item => item.container !== old.container); });
      } catch (error) { await store.log('Old-version cleanup failed', error.message); }
    }
  } catch (error) {
    if (getJob(id).status !== 'installed') {
      if (staging && !getJob(id).extractedPath) {
        try { await discardStaging(root, staging); await updateJob(id, { stagingPath: '' }); }
        catch (cleanupError) { await store.log('Extraction staging cleanup failed', cleanupError.message); }
      }
      const ready = Boolean(getJob(id).extractedPath);
      await updateJob(id, { status: ready ? 'awaiting-folder' : 'downloaded', error: error.message,
        phase: ready ? 'Extraction is ready. Finish installation or select its launcher.' : 'Installation stopped. Retry or use the external extractor.' });
    }
    await store.log('Installation did not complete', `Thread ${game.threadId}: ${error.message}`);
    throw error;
  } finally { operations.delete(game.id); notify(); }
}
async function captureDownload(item, sourceGameId, thread) {
  const id = randomUUID();
  try {
    // Electron must receive the destination during the synchronous will-download event.
    const settings = store.data.settings;
    const ref = thread?.threadUrl ? sourceThreadReference(settings, thread.threadUrl) : null;
    const game = ref ? store.data.games.find(item => gameMatchesThread(item, ref)) : store.data.games.find(item => item.id === sourceGameId);
    const root = gamesFolderFor(settings, game);
    if (!root) throw new Error('Choose your games folder in Settings before downloading.');
    try { accessSync(root, constants.W_OK); } catch { throw new Error('Games folder is offline or not writable: ' + root); }
    const filename = safeName(item.getFilename());
    let savePath = path.join(root, filename);
    if (existsSync(savePath)) savePath = path.join(root, `${id.slice(0, 6)}-${filename}`);
    item.setSavePath(savePath);
    const job = { id, gameId: null, thread: thread || null, filename: path.basename(savePath), path: savePath, downloadRoot: root, managedDownload: true, status: 'downloading', received: 0, total: item.getTotalBytes(), at: Date.now(), version: '', error: '', archiveRemoved: false };
    void store.update(state => {
      const game = ensureDownloadGame(state, { gameId: sourceGameId, thread });
      job.gameId = game?.id || null; job.version = thread?.latestVersion || (ref && !sameThread(game, ref) ? '' : game?.latestVersion) || '';
      state.downloads.unshift(job);
    });
    activeItems.set(id, item);
    let last = 0;
    item.on('updated', (_event, status) => {
      if (Date.now() - last < 500 && status !== 'interrupted') return; last = Date.now();
      void updateJob(id, { received: item.getReceivedBytes(), total: item.getTotalBytes(), speed: typeof item.getCurrentBytesPerSecond === 'function' ? item.getCurrentBytesPerSecond() : 0, error: status === 'interrupted' ? 'Connection interrupted. Retry or return to the game thread.' : '' });
    });
    item.once('done', (_event, status) => {
      activeItems.delete(id);
      void (async () => {
        await updateJob(id, { received: item.getReceivedBytes(), status: status === 'completed' ? 'downloaded' : status === 'cancelled' ? 'cancelled' : 'failed', error: status === 'completed' ? '' : 'Download did not complete. Retry or clear it and choose a new link from the thread.' });
        if (status !== 'completed') await cleanupPartial(id);
        const completed = getJob(id);
        if (status === 'completed' && offerInstallation(store.data.settings, completed) && !operations.has(completed.gameId)) {
          await install(id, 'auto', true);
        }
      })().catch(error => { if (window && !window.isDestroyed()) window.webContents.send('library:notice', error.message); void store.log('Download completion needs attention', error.message); });
    });
  } catch (error) { item.cancel(); if (window && !window.isDestroyed()) window.webContents.send('library:notice', error.message); await store.log('Download could not start', error.message); }
}
async function checkUpdates(full = false) {
  const watched = [];
  const result = await checkAllSourceUpdates({ store, clientForSource: site => metadataClient(site), full, onWatchedRelease: release => watched.push(release) });
  if (!watched.length) return result;
  await store.update(state => {
    for (const release of watched) state.history.unshift({ at: Date.now(), message: 'Watched release available', details: release.version, gameId: release.gameId });
    state.history = state.history.slice(0, 200);
  });
  if (window?.isFocused() || !Notification.isSupported()) {
    window?.webContents.send('library:notice', watched.length === 1 ? 'A watched game has a new release. See Activity.' : watched.length + ' watched releases are available. See Activity.');
    return result;
  }
  for (const release of watched) {
    const notice = new Notification({ title: 'AfterShelf', body: 'A watched game has a new release.' });
    watchNotifications.add(notice);
    for (const event of ['close', 'failed']) notice.once(event, () => watchNotifications.delete(notice));
    notice.once('click', () => {
      watchNotifications.delete(notice);
      if (!window || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      window.webContents.send('library:show-game', release.gameId);
    });
    notice.show();
  }
  return result;
}
async function attachArchive(id, input) {
  const game = getGame(id);
  if (operations.has(id)) throw new Error('Wait for this game’s active work to finish.');
  if (typeof input !== 'string' || !path.isAbsolute(input) || !isArchiveName(path.basename(input))) throw new Error('Choose one full-release archive.');
  const file = await fs.realpath(input);
  if (!isArchiveName(path.basename(file))) throw new Error('Choose a supported archive file.');
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('Choose a regular archive file.');
  const job = { id: randomUUID(), gameId: game.id, filename: path.basename(file), path: file, status: 'downloaded', at: Date.now(), version: game.latestVersion, total: stat.size, received: stat.size, error: '', archiveRemoved: false };
  await store.update(state => {
    getGame(id);
    if (operations.has(id)) throw new Error('Wait for this game’s active work to finish.');
    if (state.downloads.some(item => item.path === file && !item.archiveRemoved && !item.partialRemoved)) throw new Error('That archive is already in Downloads.');
    state.downloads.unshift(job);
  });
  return job.id;
}

const actions = {
  snapshot: () => ({ ...store.snapshot(), runtime: currentRuntime(), browser: browser.state() }),
  'apply-app-update': async () => {
    if (!appUpdater) throw new Error('Application updater is not initialized.');
    const result = await appUpdater.applyOnRestart();
    closeHtmlGames();
    await store.flush();
    quitConfirmed = true;
    app.quit();
    return result;
  },
  'choose-root': async () => {
    const root = await chooseFolder('Choose your default games and downloads folder');
    if (!root) return null;
    await store.update(({ settings }) => {
      const extra = (settings.extraGamesRoots || []).filter(folder => folder !== root);
      if (extra.some(folder => isInside(folder, root) || isInside(root, folder))) throw new Error('Choose a folder that does not overlap an additional games folder.');
      const previous = settings.gamesRoot;
      if (previous && previous !== root && !isInside(root, previous) && !isInside(previous, root)) extra.push(previous);
      settings.gamesRoot = root;
      settings.extraGamesRoots = [...new Set(extra)];
    });
    return root;
  },
  'add-games-root': async () => {
    const root = await chooseFolder('Choose an additional games folder');
    if (!root) return;
    await store.update(({ settings }) => {
      const roots = gamesFolders(settings);
      if (roots.includes(root)) return;
      if (roots.some(folder => isInside(folder, root) || isInside(root, folder))) throw new Error('Choose a folder outside the other games folders.');
      settings.extraGamesRoots = [...(settings.extraGamesRoots || []), root];
    });
  },
  'remove-games-root': root => store.update(state => {
    if (!(state.settings.extraGamesRoots || []).includes(root)) return;
    const used = state.games.some(game => game.preferredGamesRoot === root || [game.installation, ...game.previous].some(install =>
      install?.root && (install.gamesRoot === root || isInside(root, install.root, true))));
    const pending = state.downloads.some(job => !job.archiveRemoved && !job.partialRemoved && job.path && isInside(root, job.path));
    if (used || pending) throw new Error('This folder is still used by games or downloads in your library.');
    state.settings.extraGamesRoots = state.settings.extraGamesRoots.filter(folder => folder !== root);
  }),
  'set-game-folder': ({ id, root }) => {
    const game = getGame(id);
    if (operations.has(id)) throw new Error('Wait for this game’s active work to finish.');
    if (root && !gamesFolders(store.data.settings).includes(root)) throw new Error('Choose a configured games folder.');
    return store.update(() => { game.preferredGamesRoot = root || ''; });
  },
  'skip-game-update': ({ id, version }) => {
    const game = getGame(id);
    if (!game.installation || !hasUpdate(game) || game.latestVersion !== version) throw new Error('The current release changed. Refresh the game details.');
    return store.update(() => { game.skippedUpdate = { origin: game.origin, threadId: game.threadId, version }; });
  },
  'restore-game-update': id => {
    const game = getGame(id);
    if (updateSkipped(game)) return store.update(() => { delete game.skippedUpdate; });
  },
  'set-alternate-thread': ({ id, url }) => {
    const game = getGame(id);
    if (!game.threadUrl) throw new Error('Link a primary forum thread first.');
    if (operations.has(id)) throw new Error('Wait for this game’s active work to finish.');
    const ref = text(url) ? sourceThreadReference(store.data.settings, text(url)) : null;
    if (ref?.origin === game.origin) throw new Error('Use the other website for the alternate thread.');
    if (ref && store.data.games.some(other => other.id !== id && gameMatchesThread(other, ref))) throw new Error('That thread is already linked to another game.');
    return store.update(() => { game.alternateThread = ref; });
  },
  'promote-alternate-thread': async id => {
    const game = getGame(id), ref = game.alternateThread;
    if (!ref) throw new Error('Add an alternate thread first.');
    if (operations.has(id) || store.data.scan.active) throw new Error('Wait for the current installation or update check.');
    const meta = await metadataClient(ref.origin).thread(ref.threadUrl);
    await store.update(state => {
      if (getGame(id).alternateThread !== ref || operations.has(id) || state.scan.active) throw new Error('The game link or operation changed. Try again.');
      // Clear the former source's version if the new thread does not report one.
      applyForumMetadata(state, id, { latestVersion: '', ...meta });
    });
  },
  'choose-extractor': async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Select your extraction application', defaultPath: process.platform === 'darwin' ? '/Applications' : undefined, properties: ['openFile', 'openDirectory'] });
    if (!result.canceled) await store.update(state => { state.settings.extractor = result.filePaths[0]; });
  },
  'scan-library': () => scanLibrary(),
  'cancel-library-scan': () => libraryScanController?.abort(),
  'import-discovered': async input => {
    const imports = await prepareImports(input?.ids);
    let imported = 0;
    await store.update(state => { imported = applyImports(state, imports); });
    return imported;
  },
  'finish-setup': async input => {
    await requireRoot();
    if (!['download-only', 'assisted'].includes(input?.downloadMode)) throw new Error('Choose how to handle completed downloads.');
    if (!['keep', 'previous', 'delete'].includes(input?.retention)) throw new Error('Choose what to do with old versions.');
    const imports = await prepareImports(input?.ids || []);
    let imported = 0;
    await store.update(state => {
      Object.assign(state.settings, { setupCompleted: true, downloadMode: input.downloadMode, retention: input.retention });
      imported = applyImports(state, imports);
    });
    await store.log('Setup completed', `Mode=${input.downloadMode}; imported=${imported}`);
    return { imported };
  },
  'save-settings': async input => {
    await store.update(state => {
      if (input.intervalMinutes != null) state.settings.intervalMinutes = Math.min(120, Math.max(5, Number(input.intervalMinutes) || 15));
      if (['keep', 'previous', 'delete'].includes(input.retention)) state.settings.retention = input.retention;
      if (['dark', 'light'].includes(input.theme)) state.settings.theme = input.theme;
      if (['download-only', 'assisted'].includes(input.downloadMode)) state.settings.downloadMode = input.downloadMode;
      if (input.resetExtractor) state.settings.extractor = '';
    });
    scheduleChecks();
  },
  'save-source': async input => { await store.update(state => updateSourceSettings(state, input)); },
  'check-source-status': id => checkSourceStatus({ store, id, client: metadataClient(sourceById(store.data.settings, id)) }),
  'browser-open-source': async id => { const source = sourceById(store.data.settings, id); await store.update(state => { state.settings.site = { ...source }; }); return browser.open(source.origin, null, true); },
  'browser-open': input => browser.open(text(input?.url) || store.data.settings.site.origin, input?.gameId || null, Boolean(input?.newTab)),
  'game-download-options': async id => {
    const game = getGame(id);
    if (!game.threadUrl) return { options: [] };
    const token = randomUUID();
    const picker = { token, id, threadUrl: game.threadUrl, options: [] };
    downloadPicker = picker;
    const { downloadOptions, origin, threadId, threadUrl, title, engine, latestVersion, archivePassword, threadJapaneseLocale } =
      await metadataClient(game.origin).thread(game.threadUrl, { cover: false, downloads: true });
    picker.thread = { origin, threadId, threadUrl, title, engine, latestVersion, archivePassword, threadJapaneseLocale };
    picker.options = downloadOptions || [];
    return { token, options: picker.options.map(({ platform, label }, index) => ({ platform, label, index })) };
  },
  'browser-open-download-option': ({ token, index }) => {
    const picker = downloadPicker;
    if (!picker || picker.token !== token || !Number.isInteger(index) || !picker.options[index] ||
      getGame(picker.id).threadUrl !== picker.threadUrl) throw new Error('These download options expired. Open the picker again.');
    return browser.open(picker.options[index].url, picker.id, true, picker.thread);
  },
  'browser-layout': input => browser.layout(input),
  'browser-command': input => browser.command(input),
  'browser-tab': input => browser.activate(Number(input)),
  'browser-close-tab': input => browser.close(Number(input)),
  'browser-logout': async id => { await browser.logout(id || sourceId(store.data.settings.site)); await store.log('Forum session cleared', id || sourceId(store.data.settings.site)); },
  'add-current-thread': async () => { const current = await browser.currentThread(); return addMeta(parseThread(current.html, current.url, sourceForUrl(store.data.settings, current.url).origin)); },
  'add-thread': async input => {
    const url = text(input?.url); const ref = sourceThreadReference(store.data.settings, url);
    if (input?.manual) return addMeta({ ...ref, title: text(input.title) || `Thread ${ref.threadId}`, engine: ENGINES.some(([id]) => id === input.engine) ? input.engine : 'custom', latestVersion: text(input.version).slice(0,100) });
    return addMeta(await metadataClient(ref.origin).thread(ref.threadUrl));
  },
  'refresh-game-details': id => refreshDetails(id),
  'game-gallery-preview': async id => {
    const game = getGame(id);
    if (!game.threadUrl) return [];
    const ref = sourceThreadReference(store.data.settings, game.threadUrl);
    const photos = await threadGallery.preview(ref);
    return sameThread(getGame(id), ref) ? photos : [];
  },
  'game-gallery': async ({ id, mode }) => {
    const game = getGame(id);
    if (!game.threadUrl) return { photos: [], hasMore: false, failed: 0 };
    const ref = sourceThreadReference(store.data.settings, game.threadUrl);
    const gallery = await threadGallery.load(ref, metadataClient(ref.origin), mode);
    const current = getGame(id);
    if (!sameThread(current, ref)) throw new Error('The linked thread changed. Reopen the gallery to load its photos.');
    const first = gallery.photos[0];
    if (first && !current.coverPinned && (!current.coverImageId || mode === 'refresh') && current.coverImageId !== first.id) {
      await store.update(() => {
        Object.assign(current, { cover: first.src, coverImageId: first.id, coverStatus: 'cached', coverError: '' });
      });
    }
    return gallery;
  },
  'choose-game-cover': async ({ id, photoId }) => {
    const game = getGame(id);
    const ref = sourceThreadReference(store.data.settings, game.threadUrl);
    const photo = await threadGallery.choose(ref, photoId);
    if (!photo) throw new Error('This photo is unavailable. Load the gallery again to choose a cover.');
    await store.update(() => {
      const current = getGame(id);
      if (!sameThread(current, ref)) throw new Error('The linked thread changed. Reopen the gallery.');
      Object.assign(current, { cover: photo.src, coverImageId: photo.id, coverPinned: Boolean(photoId), coverStatus: 'cached', coverError: '' });
    });
  },
  'refresh-library-details': async () => {
    if (store.data.detailScan.active) throw new Error('Library details are already being refreshed.');
    const results = { refreshed: 0, unmatched: 0, coverWarnings: 0, errors: [] };
    await store.update(state => { state.detailScan = { active: true, message: 'Reading game details…' }; });
    try {
      const ids = store.data.games.map(game => game.id);
      for (const [index, id] of ids.entries()) {
        await store.update(state => { state.detailScan.message = `Reading details · ${index + 1} of ${ids.length}`; });
        try { const result = await refreshDetails(id); results.refreshed++; if (!result.linked) results.unmatched++; if (result.coverError) results.coverWarnings++; }
        catch (error) { results.errors.push(error.message); await store.log('Game details need attention', error.message); }
      }
      return results;
    } finally { await store.update(state => { state.detailScan.active = false; }); }
  },
  'find-forum-game': async input => {
    const query = text(input.query);
    if (!query) await refreshLocalDetails(input.id);
    const game = getGame(input.id);
    const settings = store.data.settings;
    const primary = input.sourceId ? sourceById(settings, input.sourceId) : gameSearchSource(settings, game);
    const searchSource = async source => {
      const client = metadataClient(source);
      const tag = rows => rows.map(row => ({ ...row, sourceId: source.id, sourceName: source.shortName }));
      if (query) return tag(await client.search(query));
      const title = game.localMetadata?.title || game.title;
      const matches = await client.search(title);
      return tag(matches.length || title === game.title ? matches : await client.search(game.title));
    };
    let primaryError;
    try {
      const matches = await searchSource(primary);
      if (matches.length) return matches;
    } catch (error) {
      primaryError = error;
    }
    for (const other of configuredSources(settings)) {
      if (other.id === primary.id || !other.latestPath) continue;
      try {
        const matches = await searchSource(other);
        if (matches.length) return matches;
      } catch {}
    }
    if (primaryError) throw primaryError;
    return [];
  },
  'link-forum-game': async input => {
    getGame(input.id);
    const metadata = await metadataClient(sourceForUrl(store.data.settings, text(input.threadUrl))).thread(text(input.threadUrl));
    await store.update(state => { applyForumMetadata(state, input.id, metadata); });
    await refreshLocalDetails(input.id);
    return { coverError: metadata.coverError || '' };
  },
  'edit-game': async input => {
    const original = getGame(input.id);
    let ref;
    if (text(input.threadUrl)) {
      ref = sourceThreadReference(store.data.settings, text(input.threadUrl));
    }
    const metadata = ref && (ref.threadId !== original.threadId || ref.origin !== original.origin) ? await metadataClient(ref.origin).thread(ref.threadUrl) : null;
    await store.update(state => {
      const game = state.games.find(game => game.id === input.id);
      if (metadata) applyForumMetadata(state, game.id, metadata);
      else { if (ref) Object.assign(game, ref); game.title = text(input.title).slice(0,200) || game.title; if (ENGINES.some(([id]) => id === input.engine)) game.engine = input.engine; game.latestVersion = text(input.latestVersion).slice(0,100); }
      if (input.installedVersion != null && text(input.installedVersion) !== game.installedVersion) { game.installedVersion = text(input.installedVersion).slice(0,100); game.installedVersionSource = 'manual'; if (game.installation) game.installation.version = game.installedVersion; }
      if (['default', 'keep', 'previous', 'delete'].includes(input.retention)) game.retention = input.retention;
      if (typeof input.notes === 'string') game.notes = input.notes.trim().slice(0, 4000);
      if (PLAY_STATUSES.some(([status]) => status === input.playStatus)) game.playStatus = input.playStatus;
      if (LAUNCH_LOCALES.some(([mode]) => mode === input.launchLocale)) game.launchLocale = input.launchLocale;
    });
  },
  'register-game': async input => {
    const game = getGame(input.id), root = await chooseFolder('Select the installed or manually extracted game folder');
    if (!root) return;
    const selected = await chooseLaunch(root, game.engine); if (!selected) return;
    const metadata = await readLocalMetadata(root, game.engine === 'custom' ? selected.info.engine : game.engine);
    await store.update(state => { const target = state.games.find(item => item.id === game.id); target.installation = { root, container: root, gamesRoot: containingGamesFolder(state.settings, root), launch: selected.launch, managed: false, version: text(input.version) || metadata.version || '', at: Date.now() }; target.availability = { status: 'available', reason: '', checkedAt: Date.now() }; target.installedVersion = target.installation.version; target.installedVersionSource = text(input.version) ? 'manual' : metadata.versionSource; target.localMetadata = metadata; if (target.engine === 'custom') target.engine = selected.info.engine; });
  },
  'launch-game': async id => {
    const game = getGame(id);
    if (!canLaunchGame(game)) throw new Error(game.availability?.reason || 'Use Locate installed game to choose this game’s launch file first.');
    if (operations.has(id)) throw new Error('Wait for this game’s installation to finish.');
    const launchPath = game.installation.launch;
    const japaneseLocale = await gameUsesJapaneseLocale(game);
    if (operations.has(id) || getGame(id).installation?.launch !== launchPath) throw new Error('The game installation changed. Try Play again.');
    if (japaneseLocale) {
      try { await fs.access(localeEmulator); }
      catch { throw new Error('AfterShelf’s Locale Emulator is missing. Reinstall AfterShelf or choose System default in Edit details.'); }
      await new Promise((resolve, reject) => {
        const child = spawn(localeEmulator, ['-runas', LOCALE_EMULATOR_PROFILE, launchPath], { cwd: path.dirname(localeEmulator), detached: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
      });
    } else if (/\.html?$/i.test(launchPath)) {
      if (htmlGameOpen(id)) { await launchHtmlGame(game); return; }
      await launchHtmlGame(game, session => {
        void store.update(state => { const target = state.games.find(item => item.id === id); if (target) recordHtmlSession(target, session); })
          .catch(error => console.error('Play session could not be saved:', error.message));
      });
    }
    else {
      const startedAt = Date.now();
      const version = game.installedVersion || game.latestVersion || '';
      const recordNativeExit = () => {
        const duration = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
        if (duration < 2) return;
        void store.update(state => { const target = state.games.find(item => item.id === id); if (target) recordHtmlSession(target, { at: startedAt, duration, version }); })
          .catch(error => console.error('Play session could not be saved:', error.message));
      };
      if (process.platform === 'darwin' && /\.app\/?$/i.test(launchPath)) {
        const child = spawn('open', ['-W', launchPath], { detached: true, stdio: 'ignore' });
        child.once('error', () => { void shell.openPath(launchPath); });
        child.once('exit', recordNativeExit);
        child.unref();
      } else if (/\.(?:exe|sh|bat|command|appimage)$/i.test(launchPath) || process.platform === 'linux') {
        try {
          const child = spawn(launchPath, [], { cwd: path.dirname(launchPath), detached: true, stdio: 'ignore' });
          child.once('error', () => { void shell.openPath(launchPath); });
          child.once('exit', recordNativeExit);
          child.unref();
        } catch {
          const error = await shell.openPath(launchPath);
          if (error) throw new Error(error);
        }
      } else {
        const error = await shell.openPath(launchPath);
        if (error) throw new Error(error);
      }
    }
    await store.update(state => { const target = state.games.find(item => item.id === id); if (target) target.lastLaunchedAt = Date.now(); });
    await store.log('Game launched', game.threadId ? `Thread ${game.threadId}` : 'Local game');
  },
  'launch-html-browser': async id => {
    const game = getGame(id);
    if (!canLaunchGame(game) || !/\.html?$/i.test(game.installation.launch)) throw new Error('No HTML launcher is available.');
    const error = await shell.openPath(game.installation.launch);
    if (error) throw new Error(error);
  },
  'toggle-watch': id => {
    const game = getGame(id);
    if (!game.threadUrl) throw new Error('Link a forum thread before watching for releases.');
    return store.update(() => { game.watching = !game.watching; if (game.watching) recordForumRelease(game, game); });
  },
  'bulk-edit-games': async ({ ids, playStatus, watch, tagMode, tags }) => {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw new Error('Select games first.');
    const selection = new Set(ids);
    const games = store.data.games.filter(game => selection.has(game.id));
    if (!games.length) throw new Error('The selected games are no longer in the library.');
    const result = { changed: 0, skipped: selection.size - games.length };
    const tagList = typeof tags === 'string' ? [...new Set(tags.split(',').map(tag => tag.trim().slice(0, 60)).filter(Boolean))] : [];
    const validStatus = PLAY_STATUSES.some(([status]) => status === playStatus);
    const editTags = ['add', 'remove'].includes(tagMode) && tagList.length;
    if ([validStatus, typeof watch === 'boolean', Boolean(editTags)].filter(Boolean).length !== 1) throw new Error('Choose one change to apply.');
    await store.update(() => {
      for (const game of games) {
        if (validStatus) game.playStatus = playStatus;
        if (editTags) {
          const current = game.personalTags || [];
          const keys = new Set(tagList.map(tag => tag.toLowerCase()));
          game.personalTags = tagMode === 'remove' ? current.filter(tag => !keys.has(tag.toLowerCase()))
            : [...new Map([...tagList, ...current].map(tag => [tag.toLowerCase(), tag])).values()].slice(0, 50);
        }
        if (typeof watch === 'boolean') {
          if (watch && !game.threadUrl) { result.skipped++; continue; }
          if (watch && !game.watching) recordForumRelease(game, game);
          game.watching = watch;
        }
        result.changed++;
      }
    });
    return result;
  },
  'storage-by-drive': () => storageByDrive(store.snapshot(), gamesFolders(store.data.settings)),
  'toggle-favorite': id => {
    const game = getGame(id);
    return store.update(() => { game.favorite = !game.favorite; });
  },
  'reveal-game': async id => { const game = getGame(id); if (game.installation) shell.showItemInFolder(game.installation.launch); },
  'game-saves': id => listGameSaves(getGame(id)),
  'reveal-save': async ({ id, file }) => {
    const save = await gameSave(id, file);
    shell.showItemInFolder(save.file);
  },
  'inspect-save': async ({ id, file }) => {
    const root = getGame(id).installation?.root;
    const save = await gameSave(id, file);
    if (save.editor === 'renpy') {
      const { slot, fields, revision } = await readRenpySave(save.file);
      return { slot, fields, revision };
    }
    if (!['mv', 'mz'].includes(save.editor)) throw new Error('This save format does not have an editor.');
    const { fields, revision } = await readRpgSave(save.file, save.editor);
    return { fields: await labelRpgFields(root, file, fields), revision };
  },
  'export-save': async ({ id, file, revision, changes }) => {
    if (operations.has(id)) throw new Error('Wait for this game’s active work to finish.');
    const save = await gameSave(id, file);
    const extension = path.extname(save.name);
    const name = revision ? path.basename(save.name, extension) + '-edited' + extension : save.name;
    const result = await dialog.showSaveDialog(window, { title: 'Export a save copy', defaultPath: path.join(app.getPath('documents'), name) });
    if (result.canceled) return false;
    if (operations.has(id)) throw new Error('Wait for this game’s active work to finish.');
    await gameSave(id, file);
    if (!revision) await fs.copyFile(file, result.filePath, constants.COPYFILE_EXCL);
    else {
      if (!['mv', 'mz', 'renpy'].includes(save.editor) || path.extname(result.filePath).toLowerCase() !== extension.toLowerCase()) throw new Error('Use the original save file extension for the edited copy.');
      let output;
      if (save.editor === 'renpy') {
        const data = await readRenpySave(file);
        if (data.revision !== revision) throw new Error('The original save changed. Open it again before exporting.');
        output = editRenpySave(data, changes);
      } else {
        const data = await readRpgSave(file, save.editor);
        if (data.revision !== revision) throw new Error('The original save changed. Open it again before exporting.');
        output = editRpgSave(data, save.editor, changes);
      }
      const handle = await fs.open(result.filePath, 'wx', 0o600);
      try { await handle.writeFile(output); }
      catch (error) { await handle.close(); await fs.rm(result.filePath, { force: true }); throw error; }
      finally { await handle.close(); }
    }
    return true;
  },
  'game-storage': async id => {
    const game = getGame(id);
    const installs = [game.installation, ...game.previous].filter(Boolean);
    const downloads = store.data.downloads.filter(job => job.gameId === id && job.path && !job.archiveRemoved && !job.partialRemoved);
    return {
      gamesRoot: gamesFolderFor(store.data.settings, game),
      versions: await Promise.all(installs.map(async install => ({ root: install.root, ...await measureStorage(installationFolder(install), true) }))),
      archives: await Promise.all(downloads.map(async job => ({ id: job.id, ...await measureStorage(job.path) })))
    };
  },
  'reveal-version': async ({ id, root }) => {
    const folder = installationFolder(retainedVersion(getGame(id), root));
    if (!await exists(folder)) throw new Error('The version folder is unavailable.');
    shell.showItemInFolder(folder);
  },
  'rollback-version': async ({ id, root }) => {
    const game = getGame(id), targetVersion = retainedVersion(game, root);
    if (htmlGameOpen(id) || operations.has(id)) throw new Error('Finish or close this game’s active work first.');
    if (!await exists(targetVersion.root) || !await exists(targetVersion.launch)) throw new Error('This retained version folder or launch target is no longer on disk.');
    const controller = new AbortController();
    operations.set(id, controller);
    try {
      let transferred = { copied: 0 };
      if (game.installation?.root && await exists(game.installation.root)) {
        const plan = await savePlan(game.installation.root, game.engine, game.saveOverrides);
        transferred = await transferSaves(plan, targetVersion.root);
      }
      await store.update(() => {
        const current = game.installation;
        game.previous = [
          ...(current ? [current] : []),
          ...game.previous.filter(item => item.root !== targetVersion.root)
        ];
        game.installation = targetVersion;
        game.installedVersion = targetVersion.version || '';
        game.installedVersionSource = targetVersion.version ? 'rollback' : '';
        game.availability = { status: 'available', reason: '', checkedAt: Date.now() };
      });
      await store.log('Version rolled back', `${targetVersion.version || 'Previous version'} (${transferred.copied} save files transferred)`);
      return { version: targetVersion.version || 'previous version', copiedSaves: transferred.copied };
    } finally {
      operations.delete(id);
      notify();
    }
  },
  'remove-version': async ({ id, root }) => {
    const game = getGame(id), version = retainedVersion(game, root);
    if (operations.has(id)) throw new Error('Wait for this game’s active work to finish.');
    const controller = new AbortController();
    operations.set(id, controller);
    try {
      const answer = await dialog.showMessageBox(window, {
        type: 'warning', message: 'Delete this previous version?',
        detail: 'This permanently deletes this version’s folder, including any saves inside it.',
        buttons: ['Cancel', 'Delete version'], defaultId: 0, cancelId: 0
      });
      if (!answer.response) return false;
      const target = { ...game, installation: version, previous: [] };
      const options = deletionOptions(removalRoots(target), controller.signal);
      options.protectedTrees.push(...removalRoots({ ...game, previous: game.previous.filter(item => item !== version) }));
      const plan = await planGameDeletion(target, store.data.games, options);
      await deleteGameFiles(plan, { signal: controller.signal });
      await store.update(() => { game.previous = game.previous.filter(item => item !== version); });
      return true;
    } finally { operations.delete(id); notify(); }
  },
  'scan-saves': async id => { const game = getGame(id); if (!game.installation) throw new Error('Locate the installed game first.'); const plan = await savePlan(game.installation.root, game.engine, game.saveOverrides); await store.update(state => { const target = state.games.find(item => item.id === id); target.savePlan = plan; }); return plan; },
  'add-save-folder': async id => {
    const game = getGame(id);
    const folder = await chooseFolder('Select this game’s save/preferences folder', game.installation?.root);
    if (!folder || game.saveOverrides.includes(folder)) return;
    if (game.installation && isInside(folder, game.installation.root, true)) throw new Error('Choose a dedicated save folder.');
    await store.update(() => { game.saveOverrides.push(folder); });
  },
  'check-updates': () => checkUpdates(),
  'check-all-updates': () => checkUpdates(true),
  'attach-archive': async id => {
    const game = getGame(id); const root = await requireRoot(gamesFolderFor(store.data.settings, game));
    const result = await dialog.showOpenDialog(window, { title: 'Select the compressed full-release download', defaultPath: root, properties: ['openFile'], filters: [{ name: 'Compressed archives', extensions: ['zip', '7z', 'rar', '001'] }] });
    if (result.canceled) return;
    return attachArchive(id, result.filePaths[0]);
  },
  'attach-dropped-archive': input => attachArchive(input.id, input.file),
  'assign-download': async input => {
    await store.update(state => { assignDownloadGame(state, input); });
  },
  'install-download': input => install(input.id, input.mode),
  'reveal-download': id => { const job = getJob(id); if (job.archiveRemoved) throw new Error('The archive was removed after installation.'); shell.showItemInFolder(job.path); },
  'cleanup-download': async id => cleanupArchive(getJob(id)),
  'cancel-download': id => { const item = activeItems.get(id); if (item) item.cancel(); },
  'retry-download': async id => {
    const job = getJob(id);
    if (!['failed', 'cancelled'].includes(job.status)) throw new Error('Cancel the active transfer before downloading again.');
    await cleanupPartial(id);
    const url = job.thread?.threadUrl || store.data.games.find(game => game.id === job.gameId)?.threadUrl;
    if (!url) throw new Error('No game thread is linked to this download. Browse to its thread and choose a new download link.');
    sourceThreadReference(store.data.settings, url);
    return browser.open(url, job.gameId, true);
  },
  'clear-download': async id => { await cleanupPartial(id); await store.update(state => { dismissDownloads(state, [id]); }); },
  'clear-completed-downloads': async () => {
    const ids = store.data.downloads.filter(job => ['downloaded', 'installed'].includes(job.status)).map(job => job.id);
    await store.update(state => { dismissDownloads(state, ids); });
    return ids.length;
  },
  'remove-game': async id => {
    const game = getGame(id); if (htmlGameOpen(id) || operations.has(id) || [...activeItems.keys()].some(jobId => getJob(jobId).gameId === id)) throw new Error('Finish this game’s active work first.');
    const controller = new AbortController(); operations.set(id, controller);
    try {
      const first = await dialog.showMessageBox(window, { type: 'question', message: `Remove ${game.title} from your library?`, detail: 'Next, choose whether to keep or delete its installed files.', buttons: ['Cancel', 'Remove from Library'], defaultId: 0, cancelId: 0 });
      if (!first.response) return { removed: false };
      const choice = await dialog.showMessageBox(window, { type: 'warning', message: 'Keep or delete the game files?', detail: 'Keep files leaves the current and retained versions on disk. Delete game files permanently removes those installation folders and their contents, including local saves and preferences. Downloads and save data outside those folders are kept.', buttons: ['Cancel', 'Keep files', 'Delete game files'], defaultId: 1, cancelId: 0 });
      if (!choice.response) return { removed: false };
      controller.signal.throwIfAborted();
      const deleting = choice.response === 2, roots = removalRoots(game).filter(root => !gamesFolders(store.data.settings).some(folder => isInside(root, folder, true)));
      if (deleting) {
        const plan = await planGameDeletion(game, store.data.games, deletionOptions(roots, controller.signal));
        await deleteGameFiles(plan, { signal: controller.signal });
      }
      controller.signal.throwIfAborted();
      await store.update(state => forgetGame(state, id, { deleteFiles: deleting, ignoredRoots: roots }));
      await store.log('Game removed', deleting ? 'Registered current/retained installation folders deleted.' : 'Files kept; startup scans will not re-add this game.');
      return { removed: true, message: deleting ? 'Game removed and installed files deleted.' : 'Game removed from library. Files kept.' };
    } finally { operations.delete(id); notify(); }
  },
  'diagnostics-copy': () => clipboard.writeText(store.diagnostic(app.getVersion(), process.platform, process.arch)),
  'diagnostics-save': async () => {
    const result = await dialog.showSaveDialog(window, { title: 'Save diagnostics', defaultPath: 'AfterShelf-diagnostics.txt', filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (!result.canceled) await fs.writeFile(result.filePath, store.diagnostic(app.getVersion(), process.platform, process.arch), 'utf8');
  },
  'copy-password': textValue => {
    const password = text(textValue);
    if (!password) throw new Error('No archive password is available to copy.');
    clipboard.writeText(password);
    return true;
  },
  'export-library': async () => {
    const dateStamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(window, {
      title: 'Export library file',
      defaultPath: path.join(app.getPath('documents'), `AfterShelf-library-${dateStamp}.json`),
      filters: [{ name: 'AfterShelf Library JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { exported: false };
    const payload = exportLibraryPayload(store.snapshot());
    await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    await store.log('Library exported', `${payload.games.length} games`);
    return { exported: true, count: payload.games.length };
  },
  'import-library': async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Import library file',
      defaultPath: app.getPath('documents'),
      properties: ['openFile'],
      filters: [{ name: 'AfterShelf Library JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths.length) return { imported: false };
    const raw = await fs.readFile(result.filePaths[0], 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('The selected file is not valid JSON.'); }
    let summary;
    await store.update(state => { summary = importLibraryPayload(state, parsed); });
    await store.log('Library imported', `${summary.added} added, ${summary.updated} updated`);
    return { imported: true, ...summary };
  }
};
function scheduleChecks() {
  clearInterval(interval);
  interval = setInterval(() => { if (store.data.games.length) void checkUpdates(); }, store.data.settings.intervalMinutes * 60000);
}
async function start() {
  store = new Store(app.getPath('userData'));
  await store.open();
  for (const job of store.data.downloads) if (['failed', 'cancelled'].includes(job.status)) await cleanupPartial(job.id);
  syncDockBadge(app, store.data.games);
  const icon = path.join(directory, 'assets', 'aftershelf-256.png');
  if (process.platform === 'darwin') app.dock.setIcon(nativeImage.createFromPath(icon));
  window = new BrowserWindow({ title: APP_NAME, icon, width: 1360, height: 900, minWidth: 1000, minHeight: 700, backgroundColor: '#171b22', show: false,
    webPreferences: { preload: path.join(directory, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: APP_NAME, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] }
  ]));
  browser = new ForumBrowser(window, store, state => { if (window && !window.isDestroyed()) window.webContents.send('library:browser', state); }, captureDownload, { WebContentsView, session, BrowserWindow });
  store.on('change', notify);
  window.on('focus', () => syncDockBadge(app, store.data.games));
  store.on('write-error', error => { if (window && !window.isDestroyed()) window.webContents.send('library:storage-error', 'Your library could not be saved. Check disk space and permissions.'); console.error('Library write failed:', error.code); });
  ipcMain.handle('library:action', async (event, action, input) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || fileURLToPath(event.senderFrame.url) !== uiFile) throw new Error('This action is only available to the local application interface.');
    if (typeof action !== 'string' || !Object.hasOwn(actions, action)) throw new Error('Unknown application action.');
    try { return { ok: true, value: await actions[action](input) }; }
    catch (error) { await store.log('Action needs attention', `${action}: ${error.message}`); return { ok: false, error: error.message }; }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== new URL(`file://${uiFile}`).href) event.preventDefault(); });
  window.on('close', event => {
    if (!quitConfirmed && activeWork()) {
      event.preventDefault();
      void dialog.showMessageBox(window, { type: 'warning', message: 'Closing will interrupt active downloads, installation or file deletion. Are you sure?', buttons: ['Stay open', 'Close and cancel'], defaultId: 0, cancelId: 0 }).then(async ({ response }) => {
        if (!response) return;
        quitConfirmed = true;
        for (const item of activeItems.values()) item.cancel();
        for (const controller of operations.values()) controller.abort();
        // The old installation is preserved; incomplete destinations are never committed.
        await store.update(state => { for (const job of state.downloads) if (job.status === 'installing') { job.status = 'downloaded'; job.phase = 'Installation not confirmed'; } });
        closeHtmlGames();
        await store.flush();
        window.close();
      });
    } else if (!quitConfirmed) {
      // Flush while a window still keeps Electron's I/O loop alive. Waiting in
      // will-quit can stall on some hosts after the last window is destroyed.
      event.preventDefault();
      if (closingForFlush) return;
      closingForFlush = true;
      closeHtmlGames();
      void store.flush().catch(error => console.error('Library flush failed:', error.code || error.message)).finally(() => { quitConfirmed = true; window?.close(); });
    }
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { clearInterval(interval); libraryScanController?.abort(); window = null; app.quit(); });
  await window.loadFile(uiFile);
  // Refresh local evidence for previously imported games without a network scan.
  void (async () => {
    await scanLibrary({ startup: true });
    for (const game of [...store.data.games]) if (canLaunchGame(game)) { try { await refreshLocalDetails(game.id); } catch (error) { await store.log('Local metadata needs attention', error.message); } }
  })().catch(error => store.log('Startup library scan needs attention', error.message));
  scheduleChecks();
  appUpdater = new AppUpdater({
    currentVersion: app.getVersion(),
    userDataDir: app.getPath('userData'),
    getBlockReason: () => restartBlockReason(store.data, currentRuntime()),
    onChange: notify,
    onLog: (message, details) => store.log(message, details)
  });
  void appUpdater.checkForUpdates();
  await store.log('Application started', `${app.getVersion()} ${process.platform} ${process.arch}`);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(start).catch(error => { dialog.showErrorBox('AfterShelf could not start', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}

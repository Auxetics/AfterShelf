import { app, BrowserWindow, WebContentsView, session, ipcMain, dialog, shell, clipboard, Menu, nativeImage, net } from 'electron';
import fs from 'node:fs/promises';
import { existsSync, accessSync, constants, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Store } from './core/store.mjs';
import { newGame, gameKey, ENGINES, ACTIVE_DOWNLOADS, canInstallArchive, offerInstallation, canLaunchGame, normalizedTitle } from './core/model.mjs';
import { parseThread, siteOrigin, threadReference } from './core/site.mjs';
import { safeName, exists, realDirectory, isInside, walk, assertNoLinks } from './core/files.mjs';
import { savePlan, inspectInstallation, transferSaves } from './core/saves.mjs';
import { extractZip } from './core/archive.mjs';
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
import { sourceById, sourceForUrl, sourceThreadReference, sourceId, updateSourceSettings, checkSourceStatus } from './core/sources.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const uiFile = path.join(directory, 'ui', 'index.html');
const profile = profileDirectory(app.getPath('appData'), existsSync);
mkdirSync(profile, { recursive: true });
app.setName(APP_NAME);
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.enableSandbox();
let window, store, browser, quitConfirmed = false, interval, closingForFlush = false;
let libraryScanController;
const activeItems = new Map(), operations = new Map();
const detailOperations = new Set();
let metadataRequests = Promise.resolve(), nextMetadataRequest = 0;
const notify = () => { syncDockBadge(app, store.data.games); if (window && !window.isDestroyed()) window.webContents.send('library:state', store.snapshot()); };
const getGame = id => { const game = store.data.games.find(game => game.id === id); if (!game) throw new Error('Game no longer exists in the library.'); return game; };
const getJob = id => { const job = store.data.downloads.find(job => job.id === id); if (!job) throw new Error('Download no longer exists.'); return job; };
const updateJob = (id, changes) => store.update(state => { const job = state.downloads.find(item => item.id === id); if (job) Object.assign(job, changes); });
const activeWork = () => activeItems.size > 0 || operations.size > 0;
const text = value => typeof value === 'string' ? value.trim() : '';
async function chooseFolder(title, defaultPath) {
  const result = await dialog.showOpenDialog(window, { title, defaultPath: defaultPath || store.data.settings.gamesRoot || app.getPath('home'), properties: ['openDirectory', 'createDirectory', 'treatPackageAsDirectory'] });
  return result.canceled ? null : realDirectory(result.filePaths[0]);
}
async function requireRoot() {
  const root = store.data.settings.gamesRoot;
  if (!root) throw new Error('Choose your games folder in Settings first.');
  const resolved = await realDirectory(root); await fs.access(resolved, fs.constants.W_OK);
  return resolved;
}
async function addMeta(meta) {
  meta = await metadataClient(meta.origin).withCover(meta);
  const id = store.data.games.find(game => game.origin === meta.origin && game.threadId === meta.threadId)?.id || gameKey(meta.origin, meta.threadId);
  await store.update(state => {
    const existing = state.games.find(game => game.id === id);
    if (existing) Object.assign(existing, { ...meta, engine: meta.engine === 'custom' ? existing.engine : meta.engine });
    else state.games.unshift(newGame(meta));
  });
  return id;
}
function metadataClient(source = store.data.settings.site) {
  const site = typeof source === 'string' ? sourceForUrl(store.data.settings, source) : source;
  return new ForumMetadata(structuredClone(site), (url, options) => {
    const request = metadataRequests.then(async () => {
      const delay = nextMetadataRequest - Date.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      nextMetadataRequest = Date.now() + 1000;
      return sessionResponse(requestOptions => net.request(requestOptions), browser.session, url, options);
    });
    metadataRequests = request.then(() => {}, () => {});
    return request;
  }, data => {
    const image = nativeImage.createFromBuffer(data);
    if (image.isEmpty()) throw new Error('The cover image could not be decoded.');
    const size = image.getSize(), scale = Math.min(1, 640 / size.width, 400 / size.height);
    return image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }).toDataURL();
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
async function refreshDetails(id) {
  if (detailOperations.has(id)) throw new Error('Details are already being scanned for this game.');
  detailOperations.add(id);
  try {
    await refreshLocalDetails(id);
    const game = getGame(id);
    if (game.threadUrl) {
      const metadata = await metadataClient(game.origin).thread(game.threadUrl);
      await store.update(state => { applyForumMetadata(state, id, metadata); });
      if (metadata.coverError) await store.log('Cover needs attention', metadata.coverError);
    }
    return { linked: Boolean(game.threadUrl), version: getGame(id).installedVersion, coverError: getGame(id).coverError || '' };
  } finally { detailOperations.delete(id); }
}
async function scanLibrary({ startup = false } = {}) {
  if (store.data.libraryScan.active) throw new Error('A folder scan is already running.');
  const root = store.data.settings.gamesRoot;
  if (!root) { if (startup) return; throw new Error('Choose your games folder in Settings first.'); }
  libraryScanController = new AbortController();
  await store.update(state => { state.libraryScan = { active: true, message: 'Looking for existing games…', candidates: [], warnings: [] }; });
  try {
    const presence = await inspectLibraryPresence([...store.data.games], root, { signal: libraryScanController.signal });
    await store.update(state => applyLibraryPresence(state, presence));
    if (!presence.rootAvailable) {
      const result = { root, candidates: [], warnings: [`Games folder unavailable (${presence.rootError}). Reconnect it and scan again.`], inspected: 0 };
      await store.update(state => { state.libraryScan = { active: false, message: result.warnings[0], candidates: [], warnings: result.warnings }; });
      return result;
    }
    let last = 0;
    const result = await discoverGames(root, { signal: libraryScanController.signal, installedGames: store.data.games, existing: [...store.data.games.flatMap(game => [game.installation?.root, ...game.previous.map(item => item.root)]).filter(Boolean), ...(startup ? store.data.ignoredGameRoots || [] : [])], downloads: store.data.downloads, progress: ({ count, found }) => {
      if (Date.now() - last > 300) { last = Date.now(); void store.update(state => { state.libraryScan.message = `Checked ${count} folders · ${found} items found`; }); }
    }});
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
  const root = await requireRoot(), imports = [];
  for (const id of new Set(ids)) {
    const candidate = store.data.libraryScan.candidates.find(item => item.id === id);
    if (!candidate) throw new Error('A selected result is no longer available. Scan your games folder again.');
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
    if (await removePartialDownload(job, { gamesRoot: store.data.settings.gamesRoot, games: store.data.games, downloads: store.data.downloads })) await updateJob(id, { partialRemoved: true, partialCleanupError: '', phase: 'Incomplete file removed. Open the game thread to download again.' });
  } catch (error) { await updateJob(id, { partialCleanupError: error.message }); }
}
async function install(id, mode = 'auto') {
  const job = getJob(id), game = getGame(job.gameId);
  if (job.thread?.threadUrl) {
    const ref = sourceThreadReference(store.data.settings, job.thread.threadUrl);
    if (store.data.games.some(other => other.id !== game.id && other.installation && other.origin === ref.origin && other.threadId === ref.threadId)) throw new Error('This source thread already belongs to another installed game. Choose its library entry first.');
  }
  if (!canInstallArchive(job) || !await exists(job.path)) throw new Error('Select a completed archive that is still on disk. Failed or cancelled downloads must be downloaded again.');
  if (operations.has(game.id)) throw new Error('This game already has an active installation.');
  // Normal ZIP installation is managed end to end, even if an external app
  // is configured for other formats or explicit manual extraction.
  if (mode === 'auto') mode = job.status === 'awaiting-folder' || job.extractedPath ? 'resume' : /\.zip$/i.test(job.path) ? 'zip' : 'external';
  const root = await requireRoot(), controller = new AbortController();
  if (operations.has(game.id)) throw new Error('This game already has an active installation.');
  operations.set(game.id, controller);
  let original;
  let forumMetadata, metadataWarning = '';
  let installGame = { ...game, ...job.thread };
  let staging = '', newRoot = '', finalParent = '';
  try {
    original = game.installation && await exists(game.installation.root) ? game.installation : null;
    await updateJob(id, { status: 'installing', error: '', phase: 'Preparing installation' });
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
      await fs.mkdir(path.join(root, '.library', 'staging'), { recursive: true });
      staging = path.join(root, '.library', 'staging', randomUUID());
      let last = 0;
      newRoot = await extractZip(job.path, staging, { signal: controller.signal, progress: (count, total) => {
        if (Date.now() - last > 500) { last = Date.now(); void updateJob(id, { phase: `Extracting ${count} of ${total} files` }); }
      }});
    }
    // Keep extracted output resumable if launch selection is cancelled or the app closes.
    if (!staging && job.stagingPath && isInside(path.join(root, '.library', 'staging'), job.stagingPath) && isInside(job.stagingPath, newRoot, true)) staging = job.stagingPath;
    await updateJob(id, { extractedPath: newRoot, stagingPath: staging, phase: 'Confirming extracted game and launch file' });
    controller.signal.throwIfAborted();
    if (original && (isInside(original.root, newRoot, true) || isInside(newRoot, original.root, true))) throw new Error('The new release must be in a separate folder from the original game.');
    const selected = await chooseLaunch(newRoot, installGame.engine, { automatic: mode !== 'folder', title: installGame.title });
    if (!selected) { await updateJob(id, { status: 'awaiting-folder', extractedPath: newRoot, phase: 'Select the extracted folder and launch file to finish' }); return; }
    newRoot = selected.root;
    let transferred = 0;
    if (original) {
      await updateJob(id, { phase: 'Transferring saves and preferences' });
      const plan = await savePlan(original.root, installGame.engine, game.saveOverrides);
      transferred = await transferSaves(plan, original.root, newRoot, controller.signal);
    }
    controller.signal.throwIfAborted();
    let launch = selected.launch, installedRoot = newRoot, managed = false;
    if (staging) {
      finalParent = path.join(root, 'Games', `${game.threadId || safeName(game.id)}-${safeName(game.title)}`, 'versions', `${Date.now()}-${safeName(job.version || 'release')}`);
      await fs.mkdir(path.dirname(finalParent), { recursive: true });
      const relativeRoot = path.relative(staging, newRoot), relativeLaunch = path.relative(staging, launch);
      await fs.rename(staging, finalParent);
      installedRoot = path.join(finalParent, relativeRoot); launch = path.join(finalParent, relativeLaunch); managed = true;
      await updateJob(id, { extractedPath: installedRoot, stagingPath: '' });
    }
    const manifest = (await walk(managed ? finalParent : installedRoot, { max: 100000, depth: 30 })).filter(item => !item.directory).map(item => item.relative);
    await updateJob(id, { phase: 'Reading installed release and checking forum version' });
    const localMetadata = await readLocalMetadata(installedRoot, installGame.engine === 'custom' ? selected.info.engine : installGame.engine);
    const versionCheck = checkInstalledVersion(localMetadata, forumMetadata?.latestVersion || '');
    const installation = { root: installedRoot, container: managed ? finalParent : installedRoot, launch, managed, manifest, at: Date.now(), version: localMetadata.version || job.version || '' };
    await store.update(state => {
      applyDownloadSource(state, game.id, job);
      if (forumMetadata) applyForumMetadata(state, game.id, forumMetadata);
      const target = state.games.find(item => item.id === game.id);
      if (original) target.previous.push(original);
      target.installation = installation; target.installedVersion = installation.version;
      target.availability = { status: 'available', reason: '', checkedAt: Date.now() };
      target.localMetadata = localMetadata; target.installedVersionSource = localMetadata.versionSource || (job.version ? 'Download label (not verified from local files)' : 'Unknown');
      target.installationCheck = { ...versionCheck, metadataWarning, checkedAt: Date.now() };
      if (target.engine === 'custom') target.engine = selected.info.engine;
      const download = state.downloads.find(item => item.id === id);
      Object.assign(download, { status: 'installed', extractedPath: installedRoot, stagingPath: '', phase: `${versionCheck.message} ${transferred} save/preference files transferred.`, metadataWarning, error: '' });
    });
    await cleanupArchive(getJob(id));
    await store.log('Installation completed', `Thread ${game.threadId}; engine=${game.engine}; transferred=${transferred}`);
    const retention = game.retention === 'default' ? store.data.settings.retention : game.retention;
    const previous = getGame(game.id).previous;
    const remove = retention === 'delete' ? previous : retention === 'previous' ? previous.slice(0, -1) : [];
    for (const old of remove) if (old.managed && isInside(root, old.container) && !isInside(old.container, installedRoot, true)) {
      try {
        await assertNoLinks(root, old.container); await fs.rm(old.container, { recursive: true });
        await store.update(state => { const target = state.games.find(item => item.id === game.id); target.previous = target.previous.filter(item => item.container !== old.container); });
      } catch (error) { await store.log('Old-version cleanup failed', error.message); }
    }
  } catch (error) {
    if (getJob(id).status !== 'installed') await updateJob(id, { status: getJob(id).extractedPath ? 'awaiting-folder' : 'downloaded', error: error.message, phase: 'Installation not completed — archive retained' });
    await store.log('Installation did not complete', `Thread ${game.threadId}: ${error.message}`);
    throw error;
  } finally { operations.delete(game.id); notify(); }
}
async function captureDownload(item, sourceGameId, thread) {
  const id = randomUUID();
  try {
    // Electron must receive the destination during the synchronous will-download event.
    const root = store.data.settings.gamesRoot;
    if (!root) throw new Error('Choose your games folder in Settings before downloading.');
    accessSync(root, constants.W_OK);
    const filename = safeName(item.getFilename());
    let savePath = path.join(root, filename);
    if (existsSync(savePath)) savePath = path.join(root, `${id.slice(0, 6)}-${filename}`);
    item.setSavePath(savePath);
    const job = { id, gameId: null, thread: thread || null, filename: path.basename(savePath), path: savePath, managedDownload: true, status: 'downloading', received: 0, total: item.getTotalBytes(), at: Date.now(), version: '', error: '', archiveRemoved: false };
    void store.update(state => {
      const game = ensureDownloadGame(state, { gameId: sourceGameId, thread });
      job.gameId = game?.id || null; job.version = thread?.latestVersion || game?.latestVersion || '';
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
          const updating = Boolean(getGame(completed.gameId).installation);
          const answer = await dialog.showMessageBox(window, { type: 'question', message: `${completed.filename} is ready. ${updating ? 'Update' : 'Install'} the game?`, detail: 'ZIP releases are extracted and registered automatically, including launcher detection, local version checks and linked forum details. Close the game before updating. Patches and executable installers need manual installation. Only identified saves and preferences transfer.', buttons: ['Keep download only', updating ? 'Update game' : 'Install game'], defaultId: 1, cancelId: 0 });
          if (answer.response) await install(id);
        }
      })().catch(error => { if (window && !window.isDestroyed()) window.webContents.send('library:notice', error.message); void store.log('Download completion needs attention', error.message); });
    });
  } catch (error) { item.cancel(); if (window && !window.isDestroyed()) window.webContents.send('library:notice', error.message); await store.log('Download could not start', error.message); }
}
async function checkUpdates(full = false) { return checkAllSourceUpdates({ store, clientForSource: site => metadataClient(site), full }); }

const actions = {
  snapshot: () => ({ ...store.snapshot(), runtime: { version: app.getVersion(), platform: process.platform, arch: process.arch, activeInstallations: operations.size }, browser: browser.state() }),
  'choose-root': async () => { const root = await chooseFolder('Choose your games and downloads folder'); if (root) await store.update(state => { state.settings.gamesRoot = root; }); return root; },
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
    const minutes = Math.min(120, Math.max(5, Number(input.intervalMinutes) || 15));
    const origin = input.origin ? siteOrigin(input.origin) : null, latestPath = text(input.latestPath);
    if (origin && (!latestPath.startsWith('/') || latestPath.startsWith('//') || latestPath.length > 1500)) throw new Error('Use a site-relative update endpoint.');
    await store.update(state => {
      if (origin) { state.settings.site = { ...state.settings.site, origin, name: origin.includes('f95zone') ? 'F95zone' : new URL(origin).hostname, latestPath }; state.settings.sources[sourceId(state.settings.site)] = { ...state.settings.site }; }
      state.settings.intervalMinutes = minutes;
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
  'browser-layout': input => browser.layout(input),
  'browser-command': input => browser.command(input),
  'browser-tab': input => browser.activate(Number(input)),
  'browser-close-tab': input => browser.close(Number(input)),
  'browser-logout': async id => { await browser.logout(id || sourceId(store.data.settings.site)); await store.log('Forum session cleared', id || sourceId(store.data.settings.site)); },
  'add-current-thread': async () => { const current = await browser.currentThread(); return addMeta(parseThread(current.html, current.url, sourceForUrl(store.data.settings, current.url).origin)); },
  'add-thread': async input => {
    const url = text(input?.url); const ref = sourceThreadReference(store.data.settings, url);
    if (input?.manual) return addMeta({ ...ref, title: text(input.title) || `Thread ${ref.threadId}`, engine: ENGINES.some(([id]) => id === input.engine) ? input.engine : 'custom', latestVersion: text(input.version).slice(0,100) });
    return addMeta(await metadataClient(ref.origin).thread(ref.threadUrl, { cover: false }));
  },
  'refresh-game-details': id => refreshDetails(id),
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
    await refreshLocalDetails(input.id);
    const game = getGame(input.id);
    const source = input.sourceId ? sourceById(store.data.settings, input.sourceId) : game.threadUrl ? sourceForUrl(store.data.settings, game.threadUrl) : store.data.settings.site;
    return metadataClient(source).search(text(input.query) || game.localMetadata?.title || game.title);
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
    });
  },
  'register-game': async input => {
    const game = getGame(input.id), root = await chooseFolder('Select the installed or manually extracted game folder');
    if (!root) return;
    const selected = await chooseLaunch(root, game.engine); if (!selected) return;
    const metadata = await readLocalMetadata(root, game.engine === 'custom' ? selected.info.engine : game.engine);
    await store.update(state => { const target = state.games.find(item => item.id === game.id); target.installation = { root, container: root, launch: selected.launch, managed: false, version: text(input.version) || metadata.version || '', at: Date.now() }; target.availability = { status: 'available', reason: '', checkedAt: Date.now() }; target.installedVersion = target.installation.version; target.installedVersionSource = text(input.version) ? 'manual' : metadata.versionSource; target.localMetadata = metadata; if (target.engine === 'custom') target.engine = selected.info.engine; });
  },
  'launch-game': async id => { const game = getGame(id); if (!canLaunchGame(game)) throw new Error(game.availability?.reason || 'Use Locate installed game to choose this game’s launch file first.'); if (operations.has(id)) throw new Error('Wait for this game’s installation to finish.'); const error = await shell.openPath(game.installation.launch); if (error) throw new Error(error); await store.log('Game launched', game.threadId ? `Thread ${game.threadId}` : 'Local game'); },
  'reveal-game': async id => { const game = getGame(id); if (game.installation) shell.showItemInFolder(game.installation.launch); },
  'scan-saves': async id => { const game = getGame(id); if (!game.installation) throw new Error('Locate the installed game first.'); const plan = await savePlan(game.installation.root, game.engine, game.saveOverrides); await store.update(state => { const target = state.games.find(item => item.id === id); target.savePlan = plan; }); return plan; },
  'add-save-folder': async id => { const game = getGame(id); const folder = await chooseFolder('Select this game’s save/preferences folder', game.installation?.root); if (folder) await store.update(state => { state.games.find(item => item.id === id).saveOverrides.push(folder); }); },
  'check-updates': () => checkUpdates(),
  'check-all-updates': () => checkUpdates(true),
  'attach-archive': async id => {
    const game = getGame(id); await requireRoot();
    const result = await dialog.showOpenDialog(window, { title: 'Select the compressed full-release download', defaultPath: store.data.settings.gamesRoot, properties: ['openFile'], filters: [{ name: 'Compressed archives', extensions: ['zip', '7z', 'rar', '001'] }] });
    if (result.canceled) return;
    const file = result.filePaths[0];
    if (store.data.downloads.some(job => job.path === file && !job.archiveRemoved)) throw new Error('That archive is already in Downloads.');
    await store.update(state => state.downloads.unshift({ id: randomUUID(), gameId: game.id, filename: path.basename(file), path: file, status: 'downloaded', at: Date.now(), version: game.latestVersion, total: 0, received: 0, error: '', archiveRemoved: false }));
  },
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
    const game = getGame(id); if (operations.has(id) || [...activeItems.keys()].some(jobId => getJob(jobId).gameId === id)) throw new Error('Finish this game’s active work first.');
    const controller = new AbortController(); operations.set(id, controller);
    try {
      const first = await dialog.showMessageBox(window, { type: 'question', message: `Remove ${game.title} from your library?`, detail: 'Next, choose whether to keep or delete its installed files.', buttons: ['Cancel', 'Remove from Library'], defaultId: 0, cancelId: 0 });
      if (!first.response) return { removed: false };
      const choice = await dialog.showMessageBox(window, { type: 'warning', message: 'Keep or delete the game files?', detail: 'Keep files leaves the current and retained versions on disk. Delete game files permanently removes those installation folders and their contents, including local saves and preferences. Downloads and save data outside those folders are kept.', buttons: ['Cancel', 'Keep files', 'Delete game files'], defaultId: 1, cancelId: 0 });
      if (!choice.response) return { removed: false };
      controller.signal.throwIfAborted();
      const deleting = choice.response === 2, roots = removalRoots(game).filter(root => !store.data.settings.gamesRoot || !isInside(root, store.data.settings.gamesRoot, true));
      if (deleting) {
        const plan = await planGameDeletion(game, store.data.games, {
          collectionRoot: store.data.settings.gamesRoot,
          protectedRoots: [store.data.settings.gamesRoot, ...(store.data.ignoredGameRoots || []).filter(root => !roots.includes(root)), ...['home', 'desktop', 'documents', 'downloads', 'appData'].map(name => app.getPath(name))],
          protectedTrees: [app.getPath('userData'), app.getAppPath(), app.getPath('exe')], signal: controller.signal
        });
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
  const icon = path.join(directory, 'assets', 'aftershelf-1024.png');
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
        await store.flush();
        window.close();
      });
    } else if (!quitConfirmed) {
      // Flush while a window still keeps Electron's I/O loop alive. Waiting in
      // will-quit can stall on some hosts after the last window is destroyed.
      event.preventDefault();
      if (closingForFlush) return;
      closingForFlush = true;
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
  await store.log('Application started', `${app.getVersion()} ${process.platform} ${process.arch}`);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(start).catch(error => { dialog.showErrorBox('AfterShelf could not start', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}

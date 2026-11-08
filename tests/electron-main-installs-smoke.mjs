import './fixtures/require-isolated-profile.mjs';
import '../app/main.mjs';
import { app, BrowserWindow, dialog, shell, webContents } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';

const root = realpathSync.native(path.join(process.env.AFTERSHELF_DATA, 'games'));
let opens = 0, cancelLaunch = true, folders = 0, launchPickers = 0, installPrompts = 0;
shell.openPath = async file => { assert.equal(file, path.join(root, 'external.rar')); opens++; return ''; };
dialog.showMessageBox = async (_window, options) => {
  if (options.message.includes('is ready. Install the game?')) installPrompts++;
  else assert.equal(options.message, 'Finish installation after extraction');
  return { response: 1 };
};
dialog.showOpenDialog = async (_window, options) => {
  if (options.title === 'Select your extraction application') return { canceled: false, filePaths: [path.join(root, 'Must not launch.app')] };
  if (options.title.startsWith('Select the extracted')) {
    if (options.defaultPath.startsWith(path.join(root, '.library', 'staging'))) return { canceled: false, filePaths: [options.defaultPath] };
    assert.equal(options.defaultPath, root); folders++;
    return { canceled: false, filePaths: [path.join(root, folders === 1 ? 'external' : 'resume')] };
  }
  assert.ok(options.title.includes('executable'));
  launchPickers++;
  if (cancelLaunch) { cancelLaunch = false; return { canceled: true, filePaths: [] }; }
  return { canceled: false, filePaths: [path.join(options.defaultPath, 'a.html')] };
};
app.on('browser-window-created', (_event, window) => window.on('show', () => window.hide()));
const watchdog = setTimeout(() => { console.error('Main installation fixture timed out.'); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  try {
    let window;
    for (let n = 0; n < 200; n++) {
      window = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/app/ui/index.html'));
      if (window && await window.webContents.executeJavaScript('Boolean(window.library)')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const evaluate = script => window.webContents.executeJavaScript(script, true);
    const call = async (action, input) => evaluate(`window.library.call(${JSON.stringify(action)}, ${JSON.stringify(input)})`);
    async function install(id) { const result = await call('install-download', { id, mode: 'auto' }); assert.equal(result.ok, true, result.error); }
    for (let n = 0; n < 200 && (await call('snapshot')).value.libraryScan.active; n++) await new Promise(resolve => setTimeout(resolve, 25));
    let snapshot = (await call('snapshot')).value;
    assert.equal(snapshot.games.find(game => game.id === 'missing').availability.status, 'missing');
    assert.ok(snapshot.games.some(game => game.title === 'Detected fixture' && game.discoveredLocally));
    assert.equal(snapshot.downloads.find(job => job.id === 'partial').partialRemoved, true);
    assert.equal((await call('retry-download', 'partial')).ok, true); assert.equal(installPrompts, 0);
    await install('external'); assert.equal(opens, 1);
    await evaluate("document.querySelector('[data-nav=downloads]').click()");
    for (let n = 0; n < 100 && !await evaluate("document.querySelector('#content').textContent.includes('Finish update')"); n++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(await evaluate("document.querySelector('#content').textContent.includes('Finish update')"));
    await install('resume'); assert.equal(opens, 1, 'finishing a pending extraction must not reopen the extractor');
    const ambiguous = await call('install-download', { id: 'zip', mode: 'auto' });
    assert.equal(ambiguous.ok, false); assert.match(ambiguous.error, /More than one equally likely/);
    assert.equal(launchPickers, 0, 'automatic installs must report a real detection failure instead of opening a routine confirmation picker');
    // The explicit recovery path can still select a launcher for an ambiguous release.
    assert.equal((await call('install-download', { id: 'zip', mode: 'folder' })).ok, true);
    const pending = (await call('snapshot')).value.downloads.find(job => job.id === 'zip');
    assert.equal(pending.status, 'awaiting-folder'); assert.ok(pending.extractedPath);
    await evaluate("document.querySelector('[data-nav=library]').click()");
    for (let n = 0; n < 100 && !await evaluate("document.querySelector('[data-action=install-zip][data-id=zip]')?.textContent.includes('Finish installation')"); n++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(await evaluate("document.querySelector('[data-action=install-zip][data-id=zip]')?.textContent.includes('Finish installation')"));
    // If retry wrongly extracts again, this missing archive will cause it to fail.
    // Retain a placeholder so the completed-download eligibility guard still passes.
    await fs.writeFile(path.join(root, 'zip.zip'), 'must reuse the existing extraction');
    await evaluate("document.querySelector('[data-nav=downloads]').click()");
    await evaluate("document.querySelector('[data-action=select-extracted][data-id=zip]').click()");
    for (let n = 0; n < 200 && !(await call('snapshot')).value.downloads.find(job => job.id === 'zip').archiveRemoved; n++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await call('snapshot')).value.downloads.find(job => job.id === 'zip').status, 'installed');
    const again = await call('install-download', { id: 'external', mode: 'auto' });
    assert.equal(again.ok, false); assert.equal(opens, 1);
    const pickersBefore = launchPickers, foldersBefore = folders;
    assert.equal((await call('choose-extractor')).ok, true);
    assert.equal((await call('snapshot')).value.settings.extractor, path.join(root, 'Must not launch.app'));
    await evaluate("document.querySelector('[data-nav=library]').click()");
    await evaluate("document.querySelector('[data-action=install-zip][data-id=button]').click()");
    for (let n = 0; n < 400 && !(await call('snapshot')).value.downloads.find(job => job.id === 'button').archiveRemoved; n++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await call('snapshot')).value.downloads.find(job => job.id === 'button').status, 'installed');
    await install('mismatch'); await install('offline');
    // Download a synthetic ZIP through the actual embedded browser and accept
    // its completion prompt. No further install/folder/launcher input is allowed.
    const promptGame = (await call('snapshot')).value.games.find(game => game.id === 'prompt');
    const opened = await call('browser-open', { url: promptGame.threadUrl, gameId: 'prompt', newTab: true });
    assert.equal(opened.ok, true);
    const guest = webContents.fromId(opened.value.activeId);
    assert.ok(guest.getURL().startsWith(promptGame.origin));
    await guest.executeJavaScript("document.querySelector('#download').click()", true);
    for (let n = 0; n < 600 && !(await call('snapshot')).value.downloads.some(job => job.gameId === 'prompt' && job.archiveRemoved); n++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(installPrompts, 1);
    for (let n = 0; n < 200 && (await call('snapshot')).value.runtime.activeInstallations; n++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await call('snapshot')).value.runtime.activeInstallations, 0);
    assert.equal((await call('snapshot')).value.games.find(game => game.id === 'prompt').installationCheck?.status, 'matched');
    assert.equal(launchPickers, pickersBefore); assert.equal(folders, foldersBefore); assert.equal(opens, 1);
    await evaluate("document.querySelector('[data-nav=library]').click()");
    for (let n = 0; n < 100 && !await evaluate("document.querySelectorAll('.game-card [data-action=play]').length===8"); n++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(await evaluate("document.querySelectorAll('.game-card [data-action=play]').length"), 8);
    assert.equal(await evaluate("document.querySelectorAll('.game-card [data-action=install-zip]').length"), 0);
    clearTimeout(watchdog); app.quit();
  } catch (error) { console.error(error); clearTimeout(watchdog); app.exit(1); }
});

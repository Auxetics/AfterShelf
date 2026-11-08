// Exercise the real local renderer/preload with synthetic IPC and disposable
// archive files. No live site, account, game, or user profile is accessed.
import { ipcMain, nativeImage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { initialState, newGame } from '../../app/core/model.mjs';
import { assignDownloadGame, importArchive, dismissDownloads } from '../../app/core/downloads.mjs';
import { discoverGames } from '../../app/core/discovery.mjs';
import { applyForumMetadata } from '../../app/core/metadata.mjs';
import { ForumMetadata } from '../../app/core/forum-metadata.mjs';
import { checkLibraryUpdates, checkAllSourceUpdates } from '../../app/core/update-checker.mjs';
import { sourceById, updateSourceSettings, checkSourceStatus } from '../../app/core/sources.mjs';

export async function checkRenderer(BrowserWindow) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lc-renderer-test-')));
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const state = initialState(); state.settings.setupCompleted = true; state.settings.gamesRoot = root;
  for (const [index, filename] of ['First_Game.zip', 'Second_Game.zip'].entries()) {
    const file = path.join(root, filename); await fs.writeFile(file, 'compressed fixture');
    state.downloads.push({ id: `fixture-${index}`, filename, path: file, status: 'downloaded', gameId: null, received: 18, total: 18, version: '' });
  }
  const window = new BrowserWindow({ show: false, width: 1360, height: 900, webPreferences: { preload: path.resolve(directory, '../../app/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const browser = { activeId: null, tabs: [] };
  const changed = () => window.webContents.send('library:state', structuredClone(state));
  let releaseFirstSearch, searchCount=0;
  let mixedSources = false;
  const sourceClient = site => new ForumMetadata(site, async url => {
    const parsed = new URL(url);
    if (parsed.pathname === '/') return new Response('<title>Fixture forum</title>');
    const version = site.id === 'f95' ? '4.0' : '7.0';
    if (parsed.pathname.startsWith('/threads/')) return new Response(`<h1 class="p-title-value">${site.shortName} Fixture [v${version}]</h1><article class="message-threadStarterPost"><div class="message-body">Engine: Ren'Py</div></article>`);
    return site.feedFormat === 'json' ? Response.json({ data: [{ thread_id: 12345, title: 'F95 Fixture', version }] }) : new Response(`<main><div class="structItem"><div class="structItem-title"><a href="/threads/example.12345/">LC Fixture [v${version}]</a></div></div></main>`);
  });
  ipcMain.handle('library:action', async (_event, action, input) => {
    try {
      let value;
      if (action === 'snapshot') value = { ...state, browser, runtime: { version: 'fixture', platform: process.platform, arch: process.arch } };
      else if (action === 'browser-layout') value = undefined;
      else if (action === 'browser-open-source') {
        const site = sourceById(state.settings, input); state.settings.site = { ...site };
        browser.activeId = browser.tabs.length + 1; browser.tabs.push({ id: browser.activeId, title: site.name, sourceId: site.id, gameId: null });
        changed(); window.webContents.send('library:browser', structuredClone(browser));
      } else if (action === 'save-source') { updateSourceSettings(state, input); changed(); }
      else if (action === 'check-source-status') {
        value = await checkSourceStatus({ store: { data: state, async update(fn) { fn(state); changed(); } }, id: input, client: sourceClient(sourceById(state.settings, input)) });
      }
      else if (action === 'assign-download') {
        assignDownloadGame(state, input); changed();
      } else if (action === 'scan-library') {
        value = await discoverGames(root, { downloads: state.downloads }); state.libraryScan.candidates = value.candidates;
      } else if (action === 'import-discovered') {
        value = 0;
        for (const id of input.ids) if (importArchive(state, state.libraryScan.candidates.find(item => item.id === id)).added) value++;
        changed();
      } else if (action === 'find-forum-game') {
        if(searchCount++===0)await new Promise(resolve=>{releaseFirstSearch=resolve;});
        const client=new ForumMetadata(state.settings.site,async url=>{
          const params=new URL(url).searchParams;
          assert.equal(params.has('search'),true,'the endpoint accepts search=, not title=');assert.equal(params.has('title'),false);
          return Response.json({data:[{thread_id:12345,title:input.query,version:'2.0',creator:'Fixture Creator'},{thread_id:99,title:'Unrelated popular game'},{thread_id:100,title:'Summer Crush'}]});
        });
        value=await client.search(input.query);
      }
      else if (action === 'link-forum-game') {
        const png=nativeImage.createFromBitmap(Buffer.from([0,255,0,255]),{width:1,height:1}).toPNG();
        const client=new ForumMetadata(state.settings.site,async(url,options)=>{
          if(url===input.threadUrl)return new Response('<h1 class="p-title-value"><span class="label">Ren’Py</span> Forum Example [v2.0] [Fixture Creator]</h1><div class="bbWrapper"><script>{"lightbox_close":"Close"}</script></div><article class="message-threadStarterPost"><div class="message-body"><div class="bbWrapper"><script>{"lightbox_next":"Next"}</script><b>Overview:</b><br>Fixture description<br><b>Developer:</b>Fixture Creator<br><span class="bbImageWrapper" data-src="https://images.example.test/denied.png"></span><span class="bbImageWrapper" data-src="https://images.example.test/cover.png"></span></div></div></article>');
          assert.equal(options.headers.Referer,state.settings.site.origin+'/');
          return url.includes('denied')?new Response('denied',{status:403}):new Response(png,{headers:{'content-type':'image/png'}});
        },buffer=>{const image=nativeImage.createFromBuffer(buffer);assert.equal(image.isEmpty(),false);return image.resize({width:1,height:1}).toDataURL();});
        const metadata=await client.thread(input.threadUrl);applyForumMetadata(state,input.id,metadata);changed();value={coverError:metadata.coverError||''};
      } else if (action === 'clear-download') { dismissDownloads(state,[input]);changed(); }
      else if (action === 'clear-completed-downloads') {
        value=dismissDownloads(state,state.downloads.filter(job=>['downloaded','installed'].includes(job.status)).map(job=>job.id));changed();
      } else if(action==='check-updates'||action==='check-all-updates') {
        if (mixedSources) {
          value = await checkAllSourceUpdates({ store: { data: state, async update(fn) { fn(state); changed(); }, async log() {} }, clientForSource: sourceClient, full: action === 'check-all-updates' });
          return { ok: true, value };
        }
        const client={async latestPage(page){return page===1?[{threadId:'12345',title:'Forum Example',version:'3.0',timestamp:0}]:[];},async thread(url,options){assert.equal(options.cover,false);return{origin:state.settings.site.origin,threadId:'12345',threadUrl:url,title:'Forum Example',latestVersion:'3.0',engine:'renpy',checkedAt:Date.now()};}};
        value=await checkLibraryUpdates({store:{data:state,async update(fn){fn(state);changed();},async log(){}},client,full:action==='check-all-updates'});
      } else throw new Error(`Unexpected fixture action: ${action}`);
      return { ok: true, value };
    } catch (error) { console.error(`Fixture action failed (${action}): ${error.message}`);return { ok: false, error: error.message }; }
  });
  const evaluate = async script => {
    try { return await window.webContents.executeJavaScript(script, true); }
    catch (error) { throw new Error(`Renderer fixture script failed: ${script}; ${error.message}`); }
  };
  async function until(script) {
    for (let i = 0; i < 200; i++) { if (await evaluate(script)) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error(`Renderer fixture timed out: ${script}; toast=${await evaluate("document.querySelector('#toast').textContent")}; scan=${JSON.stringify(state.scan)}`);
  }
  try {
    await window.loadFile(path.resolve(directory, '../../app/ui/index.html'));
    await until("Boolean(document.querySelector('[data-nav=downloads]')) && document.querySelector('#content').textContent.includes('YOUR COLLECTION')");
    await until("document.querySelector('.brand-logo').complete && document.querySelector('.brand-logo').naturalWidth === 64");
    assert.equal(await evaluate('document.title'), 'AfterShelf');
    assert.match(await evaluate("document.querySelector('.brand').textContent"), /AfterShelf/);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const output = path.resolve(directory, '../../.test-output'); await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'aftershelf-library.png'), (await window.webContents.capturePage()).toPNG());
    console.log('PASS renderer displays the AfterShelf identity and decodes its generated icon');
    assert.equal(await evaluate("document.querySelectorAll('[data-source-indicator]').length"),2);
    state.sourceStatus.f95={status:'reachable',feedStatus:'ok',message:'F95 source ready'};
    state.sourceStatus.lc={status:'error',feedStatus:'error',message:'LC source needs attention'};changed();
    await until("document.querySelector('[data-source-indicator=lc]').dataset.status==='error'");
    assert.equal(await evaluate("document.querySelector('[data-source-indicator=f95]').dataset.status"),'reachable');
    assert.equal(await evaluate("document.querySelector('[data-source-indicator=lc]').title.includes('LC source needs attention')"),true);
    assert.equal(await evaluate("[...document.querySelectorAll('.source-indicators .site-label')].map(node=>node.textContent).join(',')"),'F95,LC');
    console.log('PASS renderer shows both header sources with independent health states');
    await evaluate("document.querySelector('[data-nav=downloads]').click()");
    await until("Boolean(document.querySelector('[data-action=assign-download]'))");
    await evaluate("document.querySelector('[data-action=assign-download]').click()");
    await until("Boolean(document.querySelector('#download-game-choice'))");
    assert.equal(await evaluate("document.querySelector('#download-game-choice').value"), '__new__');
    await evaluate("document.querySelector('#modal-form button[type=submit]').click()");
    await until("!document.querySelector('#modal').open && document.querySelector('#content').textContent.includes('Install game')");
    assert.equal(state.games.length, 1); assert.equal(state.games[0].title, 'First Game'); assert.equal(state.games[0].installation, null);
    console.log('PASS renderer adds a fresh download to an empty library and offers first installation');

    await evaluate("document.querySelector('[data-nav=library]').click()");
    await until("Boolean(document.querySelector('[data-action=scan-folder]'))");
    await evaluate("document.querySelector('[data-action=scan-folder]').click()");
    await until("Boolean(document.querySelector('[data-action=setup-scan]'))");
    await evaluate("document.querySelector('[data-action=setup-scan]').click()");
    await until("Boolean(document.querySelector('.setup-result'))");
    assert.match(await evaluate("document.querySelector('.setup-result').textContent"), /Second Game.*Compressed download/s);
    assert.equal(await evaluate("document.querySelector('.setup-result input').checked"), false, 'archive import is opt-in to avoid duplicating manually extracted games');
    await evaluate("document.querySelector('.setup-result input').click()");
    assert.equal(await evaluate("document.querySelector('#modal-form button[type=submit]').textContent"), 'Add selected games');
    await evaluate("document.querySelector('#modal-form button[type=submit]').click()");
    await until("!document.querySelector('#modal').open && document.querySelector('#content').textContent.includes('Second Game')");
    assert.equal(state.games.length, 2); assert.equal(state.downloads.length, 2); assert.ok(state.games.every(game => !game.installation && !game.installedVersion));
    assert.equal(await fs.readFile(path.join(root, 'Second_Game.zip'), 'utf8'), 'compressed fixture');
    console.log('PASS renderer scan imports the second archive without duplicate downloads or claiming it is installed');

    // Switching to an existing game must hide new-game fields and preserve the
    // old installation instead of creating another library entry.
    state.games[0].installation = { root: '/fixture/old', launch: '/fixture/old/run' }; state.games[0].installedVersion = '1.0';
    state.downloads[1].gameId = null; changed();
    await evaluate("document.querySelector('[data-nav=downloads]').click()");
    await until("Boolean(document.querySelector('[data-action=assign-download]'))");
    await evaluate("document.querySelector('[data-action=assign-download]').click()");
    await until("Boolean(document.querySelector('#download-game-choice'))");
    await evaluate(`document.querySelector('#download-game-choice').value = ${JSON.stringify(state.games[0].id)}; document.querySelector('#download-game-choice').dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#download-new-title').value = '';`);
    assert.equal(await evaluate("document.querySelector('#download-new-game').hidden && !document.querySelector('#download-new-title').required"), true);
    await evaluate("document.querySelector('#modal-form button[type=submit]').click()");
    await until("!document.querySelector('#modal').open && document.querySelector('#content').textContent.includes('Update game')");
    assert.equal(state.games.length, 2); assert.equal(state.downloads[1].gameId, state.games[0].id); assert.equal(state.games[0].installation.root, '/fixture/old');
    console.log('PASS renderer associates an update with an existing installation');
    state.downloads[1].thread = { origin: state.settings.site.origin, threadId: '12345', threadUrl: state.settings.site.origin + '/threads/example.12345/' }; changed();
    await until("Boolean(document.querySelector('[data-action=assign-download][data-id=fixture-1]'))");
    await evaluate("document.querySelector('[data-action=assign-download][data-id=fixture-1]').click()");
    await until("Boolean(document.querySelector('#download-game-choice'))");
    assert.equal(await evaluate("document.querySelector('#download-game-choice').value"), state.games[0].id);
    assert.equal(await evaluate("document.querySelector('#download-new-game').hidden && !document.querySelector('#download-new-title').required"), true);
    await evaluate("document.querySelector('#modal [data-action=close-modal]').click()");

    await evaluate("document.querySelector('[data-nav=library]').click()");
    await until("Boolean(document.querySelector('[data-action=game-details]'))");
    const installedId=state.games[0].id;
    await evaluate(`Array.from(document.querySelectorAll('[data-action="game-details"]')).find(item=>item.dataset.id===${JSON.stringify(installedId)}).click()`);
    await until("Boolean(document.querySelector('[data-action=find-forum-game]'))");
    await evaluate("document.querySelector('#modal [data-action=find-forum-game]').click()");
    await until("Boolean(document.querySelector('#modal input[name=query]'))");
    await evaluate("document.querySelector('#modal input[name=query]').value='Guitar Crush'; document.querySelector('#modal button[type=submit]').click()");
    await until("Boolean(document.querySelector('[data-action=link-forum-game]'))");
    assert.equal(await evaluate("document.querySelectorAll('.forum-match').length"),1);
    assert.equal(await evaluate("document.querySelector('.forum-match strong').textContent"),'Guitar Crush');
    assert.equal(typeof releaseFirstSearch,'function');releaseFirstSearch();
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(await evaluate("document.querySelector('.forum-match strong').textContent"),'Guitar Crush','the earlier slow query cannot replace the current results');
    await evaluate("document.querySelector('[data-action=link-forum-game]').click()");
    await until("Boolean(document.querySelector('#modal input[name=installedVersion]')) && document.querySelector('#modal').textContent.includes('Thread 12345')");
    assert.equal(state.games.find(item=>item.id===installedId).installedVersion,'1.0');
    assert.equal(await evaluate("document.querySelector('#modal input[name=installedVersion]').value"),'1.0');
    assert.equal(await evaluate("document.querySelector('#modal input[name=latestVersion]').value"),'2.0');
    assert.equal(await evaluate("document.querySelector('#modal .game-description').textContent"),'Fixture description');
    assert.equal(await evaluate("document.querySelector('#modal').textContent.includes('lightbox_')"),false);
    await evaluate("document.querySelector('#modal [data-action=close-modal]').click()");
    await until("Boolean(document.querySelector('img.cover-image')) && document.querySelector('img.cover-image').complete");
    assert.equal(await evaluate("document.querySelector('img.cover-image').naturalWidth"),1);
    assert.ok(await evaluate("document.querySelector('#content').textContent.includes('Installed 1.0 · Forum 2.0')"));
    console.log('PASS renderer confirms a forum match, displays a cached cover and keeps installed/forum versions separate');

    await evaluate("document.querySelector('#content [data-action=check-updates]').click()");
    await until("document.querySelector('#content').textContent.includes('Installed 1.0 · Forum 3.0') && !document.querySelector('#content [data-action=check-updates]').disabled");
    assert.equal(state.scan.summary.verified,1);assert.equal(state.scan.summary.updates,1);assert.equal(state.scan.error,'');
    await evaluate("document.querySelector('#content [data-action=check-updates]').click()");
    await until("!document.querySelector('#content [data-action=check-updates]').disabled && document.querySelector('#toast').textContent.includes('Checked latest feed')");
    assert.equal(state.scan.summary.mode,'feed');assert.equal(state.scan.summary.verified,0);assert.equal(state.games.find(item=>item.id===installedId).installedVersion,'1.0');
    console.log('PASS renderer checks the feed repeatedly through the real update checker and preserves the installed version');

    await evaluate("document.querySelector('[data-nav=downloads]').click()");
    await until("Boolean(document.querySelector('[data-action=clear-completed-downloads]'))");
    await evaluate("document.querySelector('[data-action=clear-download]').click()");
    await until("document.querySelectorAll('.download-card').length === 1");
    await evaluate("document.querySelector('[data-action=clear-completed-downloads]').click()");
    await until("document.querySelectorAll('.download-card').length === 0");
    assert.equal(state.games.length,2);assert.equal(state.downloads.length,0);
    for(const filename of ['First_Game.zip','Second_Game.zip'])assert.equal(await fs.readFile(path.join(root,filename),'utf8'),'compressed fixture');
    console.log('PASS renderer removes individual and completed records while keeping archives and games');

    await evaluate("document.querySelector('[data-nav=settings]').click()");
    await until("document.querySelectorAll('[data-source-form]').length === 2");
    await evaluate("document.querySelector('[data-source-form=lc] input[name=latestPath]').value='https://lewdcorner.com/latest-updates?page=1&per_page=60&cat=Games&search_scope=title&ignored_mode=hide&only_new_days=7'; document.querySelector('[data-source-form=lc] button[type=submit]').click()");
    await until("document.querySelector('#toast').textContent.includes('Source settings saved')");
    assert.match(state.settings.sources.lc.latestPath, /https:\/\/lewdcorner.com\/latest-updates/);
    state.sourceStatus.lc = { active: true, status: 'checking', message: 'Checking website…', startedAt: Date.now() - 3000, checkedAt: 1, feedStatus: 'checking' }; changed();
    await until("document.querySelector('[data-source-health=lc]').textContent.includes('s elapsed')");
    assert.equal(await evaluate("document.querySelector('[data-source-health=lc]').textContent.includes('Checked')"), false);
    state.sourceStatus.lc.active = false; changed();
    await evaluate("document.querySelector('[data-source-form=lc] [data-action=check-source]').click()");
    await until("document.querySelector('[data-source-health=lc]').textContent.includes('listing parsed')");
    assert.equal(state.sourceStatus.lc.feedStatus, 'ok');
    await evaluate("document.querySelector('[data-source-form=lc] [data-action=open-source]').click()");
    await until("Boolean(document.querySelector('.browser-tab.active')) && document.querySelector('.browser-tab.active').textContent.includes('LewdCorner')");
    assert.equal(browser.tabs.at(-1).sourceId, 'lc');
    await evaluate("document.querySelector('.browser-toolbar [data-action=open-source][data-source=f95]').click()");
    await until("Boolean(document.querySelector('.browser-tab.active')) && document.querySelector('.browser-tab.active').textContent.includes('F95zone')");
    assert.equal(browser.tabs.length, 2); assert.equal(browser.tabs.at(-1).sourceId, 'f95');
    assert.equal(await evaluate("document.querySelector('[data-source-indicator=lc]').dataset.status"),'reachable');
    assert.equal(await evaluate("document.querySelector('[data-source-indicator=f95]').dataset.status"),'reachable');
    assert.equal(await evaluate("document.querySelectorAll('[data-source-indicator]').length"),2);
    console.log('PASS renderer maps the LC endpoint, checks source health and opens separate F95/LC tabs');

    const lc = sourceById(state.settings, 'lc');
    state.games.push(newGame({ origin: lc.origin, threadId: '12345', threadUrl: lc.origin + '/threads/example.12345/', title: 'LC Fixture', engine: 'renpy', installedVersion: '5.0', latestVersion: '5.0', installation: { root: '/fixture/lc', launch: '/fixture/lc/run' } }));
    mixedSources = true; changed();
    await evaluate("document.querySelector('[data-nav=library]').click()");
    await until("[...document.querySelectorAll('.game-card .source-badge')].some(node=>node.textContent==='LC')");
    assert.equal(await evaluate("[...document.querySelectorAll('.game-card .source-badge')].some(node=>node.textContent==='F95')"), true);
    await evaluate("document.querySelector('#content [data-action=check-updates]').click()");
    await until("!document.querySelector('#content [data-action=check-updates]').disabled && document.querySelector('#toast').textContent.includes('Checked game sources')");
    assert.equal(state.scan.summary.verified, 2); assert.equal(state.scan.summary.updates, 2);
    assert.equal(state.games.find(game=>game.origin===lc.origin).latestVersion, '7.0');
    assert.equal(state.games.find(game=>game.id===installedId).latestVersion, '4.0');
    assert.equal(Object.keys(state.checkpoints).length, 2);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await fs.writeFile(path.resolve(directory, '../../.test-output/aftershelf-sources.png'), (await window.webContents.capturePage()).toPNG());
    console.log('PASS renderer labels F95/LC games and checks each same-number thread through its own source');
  } finally { ipcMain.removeHandler('library:action'); window.destroy(); await fs.rm(root, { recursive: true, force: true }); }
}

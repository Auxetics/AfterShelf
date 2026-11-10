import { ENGINES, ENGINE_NAMES, hasUpdate, canInstallArchive, versionKnown, versionRelation, isInstalled, canLaunchGame } from '../core/model.mjs';
import { archiveTitle } from '../core/archive-names.mjs';
import { configuredSources, sourceLabel, sourceId, sourceById } from '../core/sources.mjs';
import { displayAppVersion as displayVersion, restartBlockReason } from '../core/app-update-state.mjs';

const icons = {
  library: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 010 18 17 17 0 010-18z"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4a1 1 0 001 1h14a1 1 0 001-1v-4"/>',
  activity: '<path d="M2 12h4l3-8 6 16 3-8h4"/>',
  settings: '<path d="m9 3-1 3-3 1-2 4 2 2 1 4 4 2 2-1 4-1 2-4-1-3-1-4-4-2z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0113-2l2 3M4 16l2 3a8 8 0 0013-2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7V5h6l2 2h10v13H3z"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',
  check: '<path d="m5 12 4 4L20 5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  list: '<path d="M8 5h13M8 12h13M8 19h13M3 5h1M3 12h1M3 19h1"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  forward: '<path d="m9 5 7 7-7 7"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/>',
  file: '<path d="M14 2H5v20h14V7zM14 2v6h5M8 13h8M8 17h6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.info}</svg>`;
const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const $ = selector => document.querySelector(selector);
const libraryStatuses = [['all', 'All games'], ['updates', 'Pending updates'], ['installed', 'Installed'], ['uninstalled', 'Not installed']];
const librarySources = [['all', 'All sources'], ['LC', 'LC only'], ['F95', 'F95 only'], ['Local', 'Local only']];
const librarySorts = [
  ['added-desc', 'Newest added'], ['added-asc', 'Oldest added'],
  ['title-asc', 'Title A–Z'], ['title-desc', 'Title Z–A'], ['installed-desc', 'Recently installed']
];
const titleOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
let sourceFilter = 'all', librarySort = localStorage.getItem('library-sort');
if (!librarySorts.some(([id]) => id === librarySort)) librarySort = 'added-desc';
let state, runtime, browserState = { activeId: null, tabs: [] }, page = 'library', filter = 'all', search = '', view = localStorage.getItem('view') || 'grid', modalSubmit, toastTimer;
let setup;
const content = $('#content');
const engineOptions = selected => ENGINES.map(([id, name]) => `<option value="${id}" ${id === selected ? 'selected' : ''}>${e(name)}</option>`).join('');
const button = (action, label, name, extra = '', primary = false) => `<button type="button" class="button ${primary ? 'primary' : ''}" data-action="${action}" ${extra}>${name ? icon(name) : ''}${label}</button>`;
const formData = () => Object.fromEntries(new FormData($('#modal-form')));
async function api(action, input) {
  const result = await window.library.call(action, input);
  if (!result.ok) throw new Error(result.error || 'The action could not be completed.');
  return result.value;
}
function toast(message, error = false) { const item = $('#toast'); item.textContent = message; item.className = `visible${error ? ' error' : ''}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => item.className = '', error ? 10000 : 5000); }
function busy(element, fn) { element.disabled = true; return fn().catch(error => toast(error.message, true)).finally(() => { element.disabled = false; }); }
function time(value) { return value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not yet'; }
function bytes(value) { if (!value) return '0 B'; const units = ['B','KB','MB','GB']; const n = Math.min(3, Math.floor(Math.log(value) / Math.log(1024))); return `${(value / 1024 ** n).toFixed(n > 1 ? 1 : 0)} ${units[n]}`; }
function currentGame(id) { return state.games.find(game => game.id === id); }
function pageActions(actions) { return actions ? `<div class="page-actions">${actions}</div>` : ''; }
function empty(title, description, name, actions = '') { return `<div class="empty-state"><div class="empty-icon">${icon(name)}</div><h2>${title}</h2><p>${description}</p><div class="empty-actions">${actions}</div></div>`; }
function status(game) { if(game.availability?.status==='missing')return '<span class="badge">Not installed</span>';if(['offline','unreadable'].includes(game.availability?.status))return '<span class="badge">Files unavailable</span>';const relation=versionRelation(game.installedVersion,game.latestVersion);return relation==='newer'?'<span class="badge update">Update available</span>':relation==='different'?'<span class="badge update">Version differs</span>':game.installation?`<span class="badge installed">${relation==='older'?'Installed version ahead':'Installed'}</span>`:'<span class="badge">Not installed</span>'; }
function gameImage(game) { const value=game.cover||'';return /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value)?value:''; }
function versionLabel(game) { return `${game.installation?(game.availability?.status==='missing'?'Last installed ':'Installed ')+(versionKnown(game.installedVersion)?game.installedVersion:'unknown')+(game.installationCheck?.status==='unverified'?' (unverified)':'')+' · ':''}Forum ${versionKnown(game.latestVersion)?game.latestVersion:game.threadId?'unknown':'not linked'}`; }
function gameCard(game) {
  const id = e(game.id), title = e(game.title), initial = e(game.title.replace(/[^\p{L}\p{N}\s]/gu,'').split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase());
  const playable = canLaunchGame(game);
  const download = state.downloads.find(job => job.gameId === game.id && canInstallArchive(job));
  const finish = download?.status === 'awaiting-folder' || Boolean(download?.extractedPath);
  const action = playable ? 'play' : download && !isInstalled(game) ? 'install-zip' : game.installation ? 'register-game' : download ? 'install-zip' : game.threadUrl ? 'open-game' : 'game-details';
  const actions = button(action, playable ? 'Play' : action==='install-zip' ? finish ? 'Finish installation' : 'Install game' : game.installation ? game.availability?.status==='missing'?'Locate game':'Locate launch file' : download ? finish ? 'Finish installation' : 'Install game' : game.threadUrl ? 'Open thread' : 'Game details', playable ? 'play' : 'arrow', `data-id="${action==='install-zip'?e(download.id):id}"`, playable||Boolean(download)) + (!game.threadId?`<button class="icon-button" data-action="find-forum-game" data-id="${id}" aria-label="Find forum match for ${title}" title="Find forum details">${icon('search')}</button>`:'') + `<button class="icon-button" data-action="game-details" data-id="${id}" aria-label="Manage ${title}">${icon('more')}</button>`;
  const image=gameImage(game), art=image?`<img class="cover-image" src="${e(image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`:'';
  if (view === 'list') return `<article class="game-row"><div class="mini-art">${initial}${art}</div><div class="game-row-info"><h3 data-action="open-game" data-id="${id}">${title}</h3><p>${sourceBadge(game)} ${e(ENGINE_NAMES[game.engine] || 'Other')} · ${e(versionLabel(game))}</p></div>${status(game)}${actions}</article>`;
  return `<article class="game-card"><div class="game-art" data-action="open-game" data-id="${id}">${status(game)}<span class="monogram">${initial}</span>${art}</div><div class="game-info"><h3 data-action="open-game" data-id="${id}">${title}</h3><div class="game-meta"><span>${e(ENGINE_NAMES[game.engine])}</span>${sourceBadge(game)}${game.creator?`<span>${e(game.creator)}</span>`:''}</div><p class="version-details">${e(versionLabel(game))}</p><div class="game-actions">${actions}</div></div></article>`;
}
function compareLibraryGames(a, b) {
  const title = titleOrder.compare(a.title, b.title);
  if (librarySort === 'title-asc') return title;
  if (librarySort === 'title-desc') return -title;
  const date = game => librarySort === 'installed-desc' ? (isInstalled(game) ? game.installation.at : 0) : game.addedAt;
  const first = date(a), second = date(b);
  if (!first || !second) return Number(Boolean(second)) - Number(Boolean(first)) || title;
  return (librarySort === 'added-asc' ? first - second : second - first) || title;
}
function renderLibraryResults() {
  const query = search.trim().toLowerCase();
  const visible = state.games.filter(game => {
    const installed = isInstalled(game);
    if (filter === 'updates' && !(installed && hasUpdate(game))) return false;
    if ((filter === 'installed' && !installed) || (filter === 'uninstalled' && installed)) return false;
    if (sourceFilter !== 'all' && sourceLabel(state.settings, game) !== sourceFilter) return false;
    return !query || `${game.title} ${ENGINE_NAMES[game.engine]}`.toLowerCase().includes(query);
  }).sort(compareLibraryGames);
  for (const control of content.querySelectorAll('[data-filter], [data-view]')) {
    control.setAttribute('aria-pressed', control.dataset.filter === filter || control.dataset.view === view);
  }
  const count = $('#library-result-count');
  const label = `${visible.length} ${visible.length === 1 ? 'game' : 'games'}`;
  if (count.textContent !== label) count.textContent = label;
  $('#library-results').innerHTML = visible.length ? `<div class="game-${view}">${visible.map(gameCard).join('')}</div>`
    : state.games.length ? empty('No matching games', 'Try a different search or filter.', 'search', button('reset-filter', 'Clear filters', null))
    : empty('Your next favourite is out there.', 'Sign in to F95 or LewdCorner, browse a game thread, and add it to your library. Your collection stays on this device.', 'library', button('browse', 'Browse games', 'globe', '', true) + button('add-thread', 'Add a thread URL', 'plus'));
}
function renderLibrary() {
  if (!$('#library-results')) {
    const options = (choices, current) => choices.map(([id, label]) => `<option value="${id}" ${id === current ? "selected" : ""}>${label}</option>`).join('');
    content.innerHTML = `<div id="library-actions"></div>
      <div class="toolbar">
        <div class="filters" role="group" aria-label="Game status">
          ${libraryStatuses.map(([id, label]) => `<button type="button" class="filter" data-filter="${id}">${label}</button>`).join("")}
        </div>
        <div class="search-tools">
          <select id="library-source" aria-label="Filter by source">${options(librarySources, sourceFilter)}</select>
          <select id="library-sort" aria-label="Sort games">${options(librarySorts, librarySort)}</select>
          <label class="search">${icon("search")}<input type="search" id="game-search" placeholder="Search library…" value="${e(search)}" aria-label="Search library"></label>
          <div class="view-toggle" role="group" aria-label="Library view">
            <button type="button" class="icon-button" data-view="grid" aria-label="Grid view">${icon("library")}</button>
            <button type="button" class="icon-button" data-view="list" aria-label="List view">${icon("list")}</button>
          </div>
        </div>
      </div>
      <div class="section-label"><span>YOUR COLLECTION</span><span id="library-result-count" role="status"></span></div>
      <div id="library-results"></div><div id="library-onboarding"></div>`;
  }
  $('#library-actions').innerHTML = pageActions(sourceShortcuts() +
    button('scan-folder', 'Scan games folder', 'folder') +
    button('refresh-library-details', state.detailScan?.active ? state.detailScan.message : 'Refresh library details', 'refresh', state.detailScan?.active ? 'disabled' : '') +
    button('check-updates', 'Check for updates', 'refresh', state.scan.active ? 'disabled' : '') +
    button('check-all-updates', 'Check all linked threads', 'search', state.scan.active ? 'disabled' : 'title="Optional full verification of every linked game"') +
    button('add-thread', 'Add game', 'plus', '', true));
  $('#library-onboarding').innerHTML = state.settings.setupCompleted ? '' : `<div class="onboarding">${icon('folder')}<div><strong>Finish setting up your library.</strong><p>Choose a games folder, download behaviour, and optionally find your existing games.</p></div>${button('setup', 'Set up library', 'arrow')}</div>`;
  renderLibraryResults();
}
function renderBrowse() {
  content.innerHTML = `<div class="browser-shell"><div class="browser-tabbar"><div id="browser-tabs" class="browser-tabs" role="tablist" aria-label="Browser tabs"></div><button type="button" class="icon-button new-tab" data-action="browser-new-tab" aria-label="New tab" title="New tab">${icon('plus')}</button></div><div class="browser-toolbar"><button type="button" class="icon-button" data-action="browser-back" aria-label="Back" title="Back">${icon('back')}</button><button type="button" class="icon-button" data-action="browser-forward" aria-label="Forward" title="Forward">${icon('forward')}</button><button type="button" class="icon-button" data-action="browser-reload" aria-label="Reload" title="Reload">${icon('refresh')}</button><button type="button" class="icon-button" data-action="browser-home" aria-label="Forum home" title="Forum home">${icon('globe')}</button><span class="browser-toolbar-spacer"></span><button type="button" class="app-update-chip" data-app-update-chip data-action="apply-app-update" hidden></button>${sourceShortcuts()}${button('add-current','Add this thread','plus','',true)}</div><div id="browser-error" class="browser-error" role="status" hidden></div><div id="browser-slot" class="browser-slot"></div></div>`;
  renderBrowserState();
}
function renderBrowserState() {
  if (page !== 'browse') return;
  const tab = browserState.tabs.find(tab => tab.id === browserState.activeId);
  $('#browser-tabs').innerHTML = browserState.tabs.map(item=>{
    const title = /^https?:\/\//i.test(item.title) ? 'Web page' : item.title;
    return `<div class="browser-tab ${item.id===browserState.activeId?'active':''}"><button type="button" class="tab-select" role="tab" aria-selected="${item.id===browserState.activeId}" aria-controls="browser-slot" data-tab="${item.id}" title="${e(title)}"><span>${item.loading?'Loading…':e(title)}</span></button><button type="button" class="tab-close" data-close-tab="${item.id}" aria-label="Close ${e(title)}" title="Close tab">${icon('close')}</button></div>`;
  }).join('');
  $('#browser-slot').innerHTML = tab ? '' : `<div class="browser-placeholder"><div class="download-actions">${sourceShortcuts()}</div></div>`;
  const error = $('#browser-error'); error.hidden = !tab?.error;
  error.textContent = tab?.error ? 'This page could not load. Try Reload or return to the forum home.' : '';
  const back = content.querySelector('[data-action="browser-back"]'), forward = content.querySelector('[data-action="browser-forward"]');
  back.disabled = !tab?.canGoBack; forward.disabled = !tab?.canGoForward;
  content.querySelector('[data-action="browser-reload"]').disabled = !tab;
  content.querySelector('[data-action="add-current"]').disabled = !tab || !tab.gameId;
  requestAnimationFrame(layoutBrowser);
}
function renderDownloads() {
  const ready = state.downloads.filter(job=>['downloaded','awaiting-folder'].includes(job.status)).length;
  const completed=state.downloads.filter(job=>['downloaded','installed'].includes(job.status)).length;
  content.innerHTML = pageActions((completed?button('clear-completed-downloads','Clear completed','close','title="Remove completed records from this list; keep downloaded files and installed games"'):'')+button('browse','Find a game','globe')) +
    (completed?'<p class="helper download-removal-note">Remove from list clears the record only. Downloaded files, games, and saves stay on disk.</p>':'')+
    `<div class="section-label"><span>${state.downloads.length} DOWNLOADS</span><span>${ready} ready to install</span></div>`+
    (state.downloads.length ? `<div class="download-list">${state.downloads.map(job=>{
      const game = currentGame(job.gameId), active = ['downloading','queued','retrying'].includes(job.status), id = `data-id="${e(job.id)}"`, installed = job.status === 'installed';
      const labels = { downloading:'Downloading', downloaded:'Ready to install', 'awaiting-folder':'Waiting for extracted folder', failed:'Download failed', cancelled:'Cancelled', installing:'Installing', installed:'Installed', removed:'Game removed', queued:'Queued' };
      let actions = '';
      if (active) actions += button('cancel-download','Cancel',null,id);
      if (['failed','cancelled'].includes(job.status)) actions += button('retry-download','Return to thread','globe',id);
      if (canInstallArchive(job) && game) {
        const finish = job.status === 'awaiting-folder' || Boolean(job.extractedPath);
        actions += button('install-zip',finish ? game.installation?'Finish update':'Finish installation' : game.installation?'Update game':'Install game','download',id,true)+button('extract-external','Open extraction app','arrow',id+' title="Open the archive again in your extraction app"')+button('select-extracted','Select extracted folder','folder',id);
      }
      if (!job.archiveRemoved && !job.partialRemoved) actions += button('reveal-download',runtime.platform==='darwin'?'Show in Finder':'Show in Explorer','folder',id);
      if (!game && canInstallArchive(job)) actions = button('assign-download','Add to library','plus',id,true)+actions;
      if (game && job.thread?.threadUrl && canInstallArchive(job)) actions += button('assign-download','Change game','library',id+' title="Use this download to update a different existing library game"');
      if (game?.threadUrl) actions += button('download-thread','Open thread','globe',id);
      if (installed && !job.archiveRemoved) actions += button('cleanup-download','Retry archive cleanup','refresh',id);
      if (!active && job.status!=='installing') actions += button('clear-download','Remove from list','close',id+' title="Keep files on disk; remove this download record"');
      return `<article class="download-card"><div class="download-top"><div class="download-icon">${icon(installed?'check':'file')}</div><div class="download-info"><strong>${e(job.filename)}</strong><p>${e(game?.title || 'Add as a new game or choose an existing library game')} ${job.version ? ' · '+e(job.version):''} · ${bytes(job.received)}${job.total?' / '+bytes(job.total):''}</p></div><span class="badge ${installed?'installed':''}">${e(labels[job.status]||job.status)}</span></div>${active?`<progress class="progress" max="${job.total||1}" ${job.total?`value="${job.received}"`:''}></progress>`:''}${job.phase?`<p class="helper">${e(job.phase)}</p>`:''}${job.partialRemoved?'<p class="helper">Incomplete file removed. Choose a new download from the game thread.</p>':''}${job.partialCleanupError?`<p class="download-error">${e(job.partialCleanupError)}</p>`:''}${job.archiveRemoved?'<p class="helper">Compressed archive removed after confirmed installation.</p>':''}${job.metadataWarning?`<p class="helper">${e(job.metadataWarning)}</p>`:''}${job.error?`<p class="download-error">${e(job.error)}</p>`:''}<div class="download-actions">${actions}</div></article>`;
    }).join('')}</div>` : empty('Nothing in the queue.', 'Choose a download provider from a game thread. Completed archives stay here until installation is confirmed.', 'download', button('browse','Browse games','globe','',true))) +
    `<div class="onboarding">${icon('info')}<div><strong>Your old installation stays put.</strong><p>Updates transfer identified saves and preferences into the new release. Patches and executable installers need manual installation.</p></div></div>`;
}
function sourceShortcuts() {
  return configuredSources(state.settings).map(site=>button('open-source',`Open ${site.shortName}`,'globe',`data-source="${e(site.id)}"`)).join('');
}
function sourceBadge(game) {
  const label=sourceLabel(state.settings,game);
  return `<span class="badge source-badge" title="${label==='Local'?'No linked website':`Updates from ${e(label)}`}">${e(label)}</span>`;
}
function browserSource() {
  const tab=browserState.tabs.find(tab=>tab.id===browserState.activeId);
  return sourceById(state.settings,tab?.sourceId||sourceId(state.settings.site));
}
function renderSourceStatus() {
  for(const node of document.querySelectorAll('[data-source-health]')){
    const status=state.sourceStatus?.[node.dataset.sourceHealth];
    node.dataset.status=status?.status||'unchecked';node.dataset.feedStatus=status?.feedStatus||'unchecked';
    const timing=status?.active?(status.startedAt?' · '+Math.max(0,Math.floor((Date.now()-status.startedAt)/1000))+'s elapsed':''):status?.checkedAt?' · Checked '+time(status.checkedAt):'';
    node.textContent=status?.message?status.message+timing:'Not checked yet';
  }
  for(const site of configuredSources(state.settings)){
    const chip=document.querySelector(`[data-source-indicator="${site.id}"]`),status=state.sourceStatus?.[site.id];
    if(!chip)continue;
    chip.querySelector('.site-label').textContent=site.shortName;
    chip.dataset.status=status?.active?'checking':status?.feedStatus==='error'?'error':status?.status||'unchecked';
    const message=status?.message||'Not checked yet. Use Check site in Settings.';
    chip.title=`${site.name}: ${message}${!status?.active&&status?.checkedAt?' · Checked '+time(status.checkedAt):''}`;
    chip.setAttribute('aria-label',`${site.name}: ${message} Open ${site.name}.`);
  }
  const appUpdate=runtime?.appUpdate;
  for(const updateBtn of document.querySelectorAll('[data-app-update-chip]')){
    if(appUpdate?.status==='downloading'){
      const pct=appUpdate.percent>0?` ${appUpdate.percent}%`:'…';
      updateBtn.hidden=false;
      updateBtn.disabled=true;
      updateBtn.dataset.status='downloading';
      updateBtn.innerHTML=`<span class="spinning">${icon('refresh')}</span><span>Downloading ${e(appUpdate.version)}${pct}</span>`;
      updateBtn.title=`Downloading AfterShelf ${appUpdate.version} in the background…`;
    }else if(appUpdate?.status==='ready'){
      const blocked=restartBlockReason(state,runtime);
      updateBtn.hidden=false;
      updateBtn.disabled=Boolean(blocked);
      updateBtn.dataset.status=blocked?'blocked':'ready';
      updateBtn.innerHTML=`${icon('download')}<span>Restart to update (${e(appUpdate.version)})</span>`;
      updateBtn.title=blocked||`Restart AfterShelf to apply update ${appUpdate.version}`;
    }else if(appUpdate?.status==='restarting'){
      updateBtn.hidden=false;
      updateBtn.disabled=true;
      updateBtn.dataset.status='restarting';
      updateBtn.innerHTML=`<span class="spinning">${icon('refresh')}</span><span>Restarting…</span>`;
      updateBtn.title='Restarting AfterShelf to apply update…';
    }else{
      updateBtn.hidden=true;
      updateBtn.innerHTML='';
    }
  }
}
function sourceSettings() {
  return configuredSources(state.settings).map(site=>{
    const status=state.sourceStatus?.[site.id], scan=state.sourceScans?.[site.id];
    return `<form class="panel source-panel" data-source-form="${e(site.id)}"><div class="subheading"><h2>${e(site.name)}</h2><span class="badge source-badge">${e(site.shortName)}</span></div><p>${e(site.origin)}</p><p class="source-health" role="status" data-source-health="${e(site.id)}" data-status="${e(status?.status||'unchecked')}">${e(status?.message||'Not checked yet')}</p><label class="field"><span>Latest-updates endpoint</span><input name="latestPath" value="${e(site.latestPath||'')}" placeholder="/latest-updates?page={page}"><small>Paste a full URL or a site-relative path. {page} is filled in for each page.</small></label><label class="field"><span>Endpoint format</span><select name="feedFormat"><option value="json" ${site.feedFormat==='json'?'selected':''}>JSON game data</option><option value="html" ${site.feedFormat==='html'?'selected':''}>HTML game/thread listing</option></select></label>${site.id==='lc'?'<p class="helper source-window-note">Update checks use the latest listing and a saved checkpoint. A first check establishes that checkpoint from page 1; filters are preserved without assuming the site honours its date window.</p>':''}<div class="download-actions">${button('open-source',`Open ${e(site.shortName)}`,'globe',`data-source="${e(site.id)}"`)}${button('check-source','Check site','refresh',`data-source="${e(site.id)}" ${status?.active?'disabled':''}`)}${button('logout-source','Clear this login',null,`data-source="${e(site.id)}"`)}</div>${scan?.message?`<p class="helper">Last game check: ${e(scan.message)}</p>`:''}<div class="form-actions"><button type="submit" class="button primary" ${state.scan.active?'disabled':''}>Save source settings</button></div></form>`;
  }).join('');
}
function renderSettings() {
  content.innerHTML = `<div class="settings-grid"><section class="panel"><h2>Games & downloads</h2><p>Downloads, extraction, and folder selection start in your chosen games directory.</p><div class="path-picker">${icon('folder')}<span class="path-value">${e(state.settings.gamesRoot||'No games folder selected')}</span>${button('choose-root','Choose folder',null)}</div><label class="field"><span>External extraction application</span></label><div class="path-picker">${icon('file')}<span class="path-value">${e(state.settings.extractor||'Use the system’s default app for external extraction')}</span>${state.settings.extractor?button('reset-extractor','Use default',null):''}${button('choose-extractor','Choose app',null)}</div><p class="helper">Install handles ordinary ZIP releases automatically. Use this app for other formats, passwords or multipart archives; select its output if it cannot report completion.</p><div class="download-actions">${button('setup','Run setup again','settings')}${button('scan-folder','Find existing games','search')}</div></section>
    <form id="settings-form" class="panel"><h2>Forum & preferences</h2><p>Games check their own F95 or LewdCorner source. Browsing another source does not reassign your library.</p><label class="field"><span>Completed downloads</span><select name="downloadMode"><option value="download-only" ${state.settings.downloadMode==='download-only'?'selected':''}>Download only — install manually</option><option value="assisted" ${state.settings.downloadMode==='assisted'?'selected':''}>Offer to install/update after downloading</option></select><small>You choose the provider and start each download. Installation transfers identified saves and preferences.</small></label><div class="field-row"><label class="field"><span>Check while the app is open</span><select name="intervalMinutes">${[5,15,30,60,120].map(n=>`<option value="${n}" ${state.settings.intervalMinutes===n?'selected':''}>Every ${n} minutes</option>`).join('')}</select></label><label class="field"><span>Old versions after an update</span><select name="retention">${[['keep','Keep all old versions'],['previous','Keep the previous version'],['delete','Permanently delete old versions']].map(([id,label])=>`<option value="${id}" ${state.settings.retention===id?'selected':''}>${label}</option>`).join('')}</select></label></div><label class="field"><span>Appearance</span><select name="theme"><option value="dark" ${state.settings.theme==='dark'?'selected':''}>Dark forum style</option><option value="light" ${state.settings.theme==='light'?'selected':''}>Light forum style</option></select></label><p class="helper">Archives are automatically deleted after confirmed installation. Download-only and unconfirmed archives remain available.</p><div class="form-actions"><button class="button primary" type="submit">Save preferences</button></div></form>
    ${sourceSettings()}<section class="panel"><h2>Account & support</h2><p>Sign in on the actual website in Browse. The app keeps your forum session separate from game save data.</p><div class="download-actions">${button('browser-home','Open forum login','globe')}${button('logout','Clear current login',null)}${button('diagnostics-copy','Copy diagnostics','file')}${button('diagnostics-save','Save diagnostics.txt','download')}</div><table class="support-table"><tr><td>Application</td><td>AfterShelf ${e(displayVersion(runtime.version))}</td></tr><tr><td>This device</td><td>${e(runtime.platform)} · ${e(runtime.arch)}</td></tr><tr><td>Engine rules</td><td>Alpha · game validation in progress</td></tr></table></section></div>`;
}
function renderActivity() {
  content.innerHTML = pageActions(button('diagnostics-copy','Copy diagnostics','file')+button('diagnostics-save','Save .txt','download'))+
    `<section class="panel"><div class="subheading"><h2>Recent events</h2><span class="helper">Stored on this device</span></div><div class="history">${state.history.map(item=>`<div class="history-item"><span class="status-dot"></span><time>${time(item.at)}</time><div><strong>${e(item.message)}</strong>${item.details?`<p>${e(item.details)}</p>`:''}</div></div>`).join('')||'<p class="helper">Your recent activity will appear here.</p>'}</div></section>`;
}
function render() {
  if (!state) return;
  document.documentElement.dataset.theme = state.settings.theme;
  document.body.dataset.page = page;
  document.querySelectorAll('[data-nav]').forEach(el=>el.classList.toggle('active',el.dataset.nav===page));
  $('#breadcrumb-current').textContent = page[0].toUpperCase()+page.slice(1);
  renderSourceStatus();
  $('#library-count').textContent = state.games.length;
  $('#downloads-count').textContent = state.downloads.filter(job=>job.status!=='installed').length;
  $('#app-version').textContent = displayVersion(runtime.version);
  $('#platform-status').textContent = `${runtime.platform==='darwin'?'macOS':'Windows'} · ${runtime.arch}`;
  $('#folder-status').textContent = state.settings.gamesRoot || 'Choose a games folder to get started';
  $('#scan-status').innerHTML = `<span class="${state.scan.active?'spinning':''}">${icon('refresh')}</span><span>${e(state.scan.active?state.scan.message:state.scan.error?'Update check needs attention':state.scan.lastChecked?'Last checked '+time(state.scan.lastChecked):'Not checked yet')}</span>`;
  $('#scan-status').title = [state.scan.message,state.scan.error,state.scan.lastChecked?'Last completed: '+time(state.scan.lastChecked):''].filter(Boolean).join('\n');
  content.className = page==='browse'?'browse-page':'';
  if (page==='library') renderLibrary();
  if (page==='browse') renderBrowse();
  if (page==='downloads') renderDownloads();
  if (page==='settings') renderSettings();
  if (page==='activity') renderActivity();
  renderSourceStatus();
  requestAnimationFrame(layoutBrowser);
}
async function navigate(next) { page = next; await api('browser-layout', null); render(); }
function layoutBrowser() {
  const slot = $('#browser-slot');
  const rect = page==='browse' && !$('#modal').open && slot ? slot.getBoundingClientRect() : null;
  void api('browser-layout',rect ? { x:rect.x,y:rect.y,width:rect.width,height:rect.height } : null).catch(()=>{});
}
async function modal(html, submit) {
  await api('browser-layout', null);
  $('#modal-content').innerHTML = `<button type="button" class="icon-button modal-close" data-action="close-modal" aria-label="Close">${icon('close')}</button>${html}`;
  modalSubmit = submit; $('#modal').showModal();
}
function closeModal() { if(setup?.running){toast('Wait for the folder scan to finish or cancel it first.');return;} setup=null; $('#modal').classList.remove('setup-dialog'); $('#modal').close(); modalSubmit = null; requestAnimationFrame(layoutBrowser); }
function readSetupChoices() {
  if(!setup)return;
  const data=formData();
  if(data.downloadMode)setup.downloadMode=data.downloadMode;
  if(data.retention)setup.retention=data.retention;
}
async function startSetup(importOnly=false) {
  setup={ step:importOnly&&state.settings.gamesRoot?2:0, importOnly, root:state.settings.gamesRoot, downloadMode:state.settings.downloadMode||'download-only', retention:state.settings.retention||'keep', candidates:[], selected:new Set(), warnings:[], scanned:false, running:false };
  await modal('',null);
  $('#modal').classList.add('setup-dialog');
  renderSetup();
}
function renderSetup() {
  if(!setup)return;
  let body='', action='Continue';
  const step=setup.step;
  if(step===0){
    body=`<h2>Give your games a home</h2><p>Choose where game archives and new installations should go. You can find and add existing games without moving them.</p><div class="path-picker setup-folder">${icon('folder')}<span class="path-value">${e(setup.root||'No folder selected')}</span>${button('setup-folder','Choose folder',null)}</div><p class="helper">This folder will also be the starting point for extraction and folder selection. External saves stay where the game expects them.</p>`;
  }else if(step===1){
    body=`<h2>How should downloads work?</h2><p>You always choose the hosting provider and start the download yourself.</p><div class="setup-choices"><label class="setup-choice"><input type="radio" name="downloadMode" value="download-only" ${setup.downloadMode==='download-only'?'checked':''}><span><strong>Download only</strong><small>Keep the archive. Open it in Finder/Explorer and install or update the game yourself.</small></span></label><label class="setup-choice"><input type="radio" name="downloadMode" value="assisted" ${setup.downloadMode==='assisted'?'checked':''}><span><strong>Assist with installs & updates</strong><small>Offer installation when a download finishes. Transfer identified saves/preferences into the new release, then remove the archive after installation succeeds.</small></span></label></div><label class="field"><span>Old versions after a successful update</span><select name="retention">${[['keep','Keep all old versions'],['previous','Keep the previous version'],['delete','Permanently delete old versions']].map(([id,label])=>`<option value="${id}" ${setup.retention===id?'selected':''}>${label}</option>`).join('')}</select><small>Old files stay in place until extraction and save transfer finish. Save compatibility depends on the game release.</small></label><div class="path-picker">${icon('file')}<span class="path-value">${e(state.settings.extractor||'Use the system’s default app for external extraction')}</span>${button('setup-extractor','Choose app',null)}</div>`;
  }else{
    action=setup.importOnly?(setup.selected.size?'Add selected games':'Done'):'Finish setup';
    body=`<h2>Find games you already have</h2><p>Find extracted games and compressed downloads, then choose what to add. This will not move, extract, or delete any files. Archives are added as not installed, ready to install from Library or Downloads.</p><div class="path-picker">${icon('folder')}<span class="path-value">${e(setup.root)}</span>${setup.running?button('setup-cancel-scan','Cancel scan',null):button('setup-scan',setup.scanned?'Scan again':'Scan folder','search')}</div><p class="helper" id="setup-scan-status">${e(setup.running?(state.libraryScan?.message||'Looking for games…'):setup.scanned?`${setup.candidates.length} items found · ${setup.selected.size} selected`:'Scanning is optional. You can also do this later from Library or Settings.')}</p>`;
    if(setup.candidates.length)body+=`<div class="setup-results-actions">${button('setup-select-all','Select all',null)}${button('setup-select-none','Clear selection',null)}</div><div class="setup-results">${setup.candidates.map(candidate=>`<label class="setup-result"><input type="checkbox" data-candidate="${e(candidate.id)}" ${setup.selected.has(candidate.id)?'checked':''}><span><strong>${e(candidate.title)}</strong><small>${candidate.kind==='archive'?'Compressed download · Not installed · '+bytes(candidate.size):e(ENGINE_NAMES[candidate.engine])+(candidate.launch?'':' · Choose a launch file after adding')}<br>${e(candidate.kind==='archive'?candidate.path:candidate.root)}</small></span></label>`).join('')}</div><p class="helper">Archive titles start from their filenames; adjust them in game details. Link a forum thread there to enable update tracking. To use an archive for an existing game, choose that game from Downloads instead of importing it as new.</p>`;
    else if(setup.scanned)body+='<div class="setup-no-results">No new game folders or archives found. Registered installations and archives already linked to library games are skipped. Linked archives remain in Downloads.</div>';
    if(setup.warnings.length)body+=`<div class="setup-warnings">${setup.warnings.map(e).join('<br>')}</div>`;
  }
  $('#modal-content').innerHTML=`<div class="setup-progress">${setup.importOnly?'FIND EXISTING GAMES':`SET UP YOUR LIBRARY · ${step+1} OF 3`}</div>${body}<div class="form-actions setup-actions">${button('close-modal',setup.importOnly?'Cancel':'Set up later',null,setup.running?'disabled':'')}${step>0&&!setup.running?button('setup-back','Back',null):''}<button type="submit" class="button primary" ${setup.running||step===0&&!setup.root?'disabled':''}>${action}</button></div>`;
  modalSubmit=async()=>{
    readSetupChoices();
    if(setup.step===0){if(!setup.root)throw new Error('Choose your games folder first.');setup.step=setup.importOnly?2:1;renderSetup();return;}
    if(setup.step===1){setup.step=2;renderSetup();return;}
    const result=setup.importOnly?{imported:await api('import-discovered',{ids:[...setup.selected]})}:await api('finish-setup',{downloadMode:setup.downloadMode,retention:setup.retention,ids:[...setup.selected]});
    closeModal();await navigate('library');toast(result.imported?`${result.imported} games added. Archives are ready to install; existing files stayed in place.`:'Your library is ready.');
  };
}
async function scanSetupFolder() {
  setup.running=true;renderSetup();
  try{
    const result=await api('scan-library');
    if(result.cancelled){setup.warnings=['Scan cancelled. Scan again or finish without importing.'];return;}
    setup.candidates=result.candidates;setup.selected=new Set(result.candidates.filter(item=>item.kind!=='archive'&&item.launch).map(item=>item.id));setup.warnings=result.warnings;setup.scanned=true;
  }finally{if(setup){setup.running=false;renderSetup();}}
}
function addThread() {
  return modal(`<h2>Add a game</h2><p>Paste a thread URL. Sign in through Browse first to fetch its title and engine tags.</p><label class="field"><span>Thread URL</span><input name="url" type="url" required placeholder="https://f95zone.to/threads/game-name.12345/"></label><details class="field"><summary class="helper">Add manually if the thread cannot be fetched</summary><label class="field"><span>Game title</span><input name="title" placeholder="Game title"></label><label class="field"><span>Engine</span><select name="engine">${engineOptions('custom')}</select></label><label class="field"><span>Version</span><input name="version" placeholder="e.g. 1.0"></label><label class="field helper"><input name="manual" type="checkbox" value="yes"> Use these details instead of fetching the thread</label></details><div class="form-actions"><button class="button primary" type="submit">Add to library</button></div>`,async data=>{await api('add-thread',{...data,manual:data.manual==='yes'});closeModal();await navigate('library');toast('Game added to your library.');});
}
function gameDetails(id) {
  const game = currentGame(id);
  const installNote=game.installationCheck?`<p class="helper">Install check: ${e(game.installationCheck.message)}${game.installationCheck.metadataWarning?' '+e(game.installationCheck.metadataWarning):''}</p>`:'';
  const coverNote=game.metadataNeedsRefresh?'Refresh details to reload this game’s overview and cover.':game.coverError||'';
  return modal(`<h2>${e(game.title)}</h2><p>${sourceBadge(game)} ${e(ENGINE_NAMES[game.engine])} · ${game.threadId?'Thread '+e(game.threadId):'Local game'}${game.creator?' · '+e(game.creator):''}</p>${game.description?`<p class="game-description">${e(game.description)}</p>`:''}${coverNote?`<p class="cover-warning">${e(coverNote)}</p>`:''}${installNote}<div class="download-actions">${button('find-forum-game',game.threadId?'Change forum match':'Find forum match','search',`data-id="${e(id)}"`)}${button('refresh-game-details','Refresh details','refresh',`data-id="${e(id)}"`)}</div><label class="field"><span>Forum thread (optional)</span><input name="threadUrl" type="url" value="${e(game.threadUrl||'')}" placeholder="https://f95zone.to/threads/game.12345/"><small>Search for a match above, or paste a thread URL. Linking fetches forum details and its cover image.</small></label><label class="field"><span>Title</span><input name="title" value="${e(game.title)}" required></label><div class="field-row"><label class="field"><span>Engine</span><select name="engine">${engineOptions(game.engine)}</select></label><label class="field"><span>Current forum version</span><input name="latestVersion" value="${e(game.latestVersion)}" placeholder="Link a forum thread"></label></div><label class="field"><span>Installed version</span><input name="installedVersion" value="${e(versionKnown(game.installedVersion)?game.installedVersion:'')}" placeholder="Unknown — enter the game release if needed"><small>${game.installedVersionSource?'Source: '+e(game.installedVersionSource):'Read from local release metadata when available. The forum version never fills this field.'}</small></label><div class="download-actions">${button('register-game','Locate installed game','folder',`data-id="${e(id)}"`)}${button('attach-archive','Use downloaded archive','file',`data-id="${e(id)}"`)}${game.installation?button('scan-saves','Inspect save locations','search',`data-id="${e(id)}"`)+button('reveal-game','Show installed game','folder',`data-id="${e(id)}"`):''}</div>${game.installation?`<p class="helper">${e(game.installation.launch)}</p>`:''}<div class="form-actions">${button('remove-game','Remove from library','trash',`data-id="${e(id)}"`)}<button class="button primary" type="submit">Save details</button></div>`,async data=>{await api('edit-game',{id,...data});closeModal();toast('Game details saved.');});
}
async function findForumMatch(id) {
  const game=currentGame(id);
  let searchNumber=0;
  async function searchMatches() {
    const results=$('#forum-match-results');if(!results)return;
    const requestNumber=++searchNumber;
    results.textContent='Searching forum titles…';
    try {
      const rows=await api('find-forum-game',{id,query:formData().query,sourceId:formData().sourceId});
      if(requestNumber!==searchNumber||!$('#modal').open||$('#forum-match-results')!==results)return;
      results.innerHTML=rows.length?rows.map(row=>`<article class="forum-match"><div><strong>${e(row.title)}</strong><p>${e(row.creator||'Creator unknown')} · ${e(row.latestVersion||'Version unknown')} · Thread ${e(row.threadId)}${row.exact?' · Matching title':''}</p></div><div class="download-actions">${button('link-forum-game','Link this thread','check',`data-id="${e(id)}" data-url="${e(row.threadUrl)}"`,true)}${button('preview-forum-game','View thread','globe',`data-url="${e(row.threadUrl)}"`)}</div></article>`).join(''):'No matching threads found. Try fewer words, or paste the thread URL in game details.';
    } catch(error) {if(requestNumber===searchNumber&&$('#forum-match-results')===results)results.textContent=error.message;}
  }
  await modal(`<h2>Find a forum match</h2><p>Confirm which thread belongs to ${e(game.title)}. Linking fills its title, creator, current release, description, and available cover while keeping the local installation and version.</p><label class="field"><span>Website source</span><select name="sourceId">${configuredSources(state.settings).map(site=>`<option value="${e(site.id)}" ${site.origin===game.origin?'selected':''}>${e(site.name)}</option>`).join('')}</select></label><label class="field"><span>Game title</span><input name="query" required value="${e(game.localMetadata?.title||game.title)}"></label><div class="form-actions"><button type="submit" class="button primary">Search forum</button></div><div id="forum-match-results" class="forum-match-results"></div><div class="form-actions">${button('game-details','Back to game details',null,`data-id="${e(id)}"`)}</div>`,searchMatches);
  await searchMatches();
}
document.addEventListener('click',event=>{
  const nav = event.target.closest('[data-nav]'); if(nav){void navigate(nav.dataset.nav);return;}
  const f = event.target.closest('[data-filter]');if(f){filter=f.dataset.filter;renderLibraryResults();return;}
  const v=event.target.closest('[data-view]');if(v){view=v.dataset.view;localStorage.setItem('view',view);renderLibraryResults();return;}
  const tabClose=event.target.closest('[data-close-tab]');if(tabClose){void api('browser-close-tab',Number(tabClose.dataset.closeTab));return;}
  const tab=event.target.closest('[data-tab]');if(tab){void api('browser-tab',Number(tab.dataset.tab));return;}
  const target=event.target.closest('[data-action]');if(!target)return;
  const {action,id}=target.dataset;
  void busy(target,async()=>{
    if(action==='setup'){await startSetup();return;}
    if(action==='scan-folder'){await startSetup(true);return;}
    if(action==='setup-folder'){const root=await api('choose-root');if(root){setup.root=root;setup.scanned=false;setup.candidates=[];setup.selected.clear();}renderSetup();return;}
    if(action==='setup-extractor'){readSetupChoices();await api('choose-extractor');renderSetup();return;}
    if(action==='setup-back'){readSetupChoices();setup.step=setup.importOnly?0:setup.step-1;renderSetup();return;}
    if(action==='setup-scan'){await scanSetupFolder();return;}
    if(action==='setup-cancel-scan'){await api('cancel-library-scan');return;}
    if(action==='setup-select-all'){setup.selected=new Set(setup.candidates.map(item=>item.id));renderSetup();return;}
    if(action==='setup-select-none'){setup.selected.clear();renderSetup();return;}
    if(['library','browse','downloads','activity','settings'].includes(action)){await navigate(action);return;}
    if(action==='close-modal'){closeModal();return;}
    if(action==='add-thread'){await addThread();return;}
    if(action==='game-details'){await gameDetails(id);return;}
    if(action==='find-forum-game'){await findForumMatch(id);return;}
    if(action==='link-forum-game'){const result=await api(action,{id,threadUrl:target.dataset.url});await gameDetails(id);toast(result.coverError||'Forum thread linked. Local files and installed version preserved.',Boolean(result.coverError));return;}
    if(action==='preview-forum-game'){const url=target.dataset.url;closeModal();await navigate('browse');await api('browser-open',{url,newTab:true});return;}
    if(action==='refresh-game-details'){const result=await api(action,id);await gameDetails(id);toast(result.coverError||(result.linked?'Local and forum details refreshed.':'Local details refreshed. Use Find forum match to link the website thread.'),Boolean(result.coverError));return;}
    if(action==='refresh-library-details'){const result=await api(action);toast(result.errors.length?`${result.refreshed} games refreshed. ${result.errors[0]}`:`${result.refreshed} games refreshed${result.unmatched?`; ${result.unmatched} need a forum match`:''}${result.coverWarnings?`; ${result.coverWarnings} covers need attention in game details`:''}.`,Boolean(result.errors.length||result.coverWarnings));return;}
    if(action==='clear-completed-downloads'){const count=await api(action);toast(`${count} completed records removed. Files stay on disk.`);return;}
    if(action==='clear-download'){await api(action,id);toast('Removed from list. Files stay on disk.');return;}
    if(action==='reset-filter'){
      filter='all';sourceFilter='all';search='';
      $('#library-source').value=sourceFilter;$('#game-search').value=search;
      renderLibraryResults();$('[data-filter="all"]').focus();return;
    }
    if(action==='open-source'){await navigate('browse');await api('browser-open-source',target.dataset.source);return;}
    if(action==='check-source'){const result=await api('check-source-status',target.dataset.source);toast(result.message,result.status==='error'||result.feedStatus==='error');return;}
    if(action==='logout-source'){await api('browser-logout',target.dataset.source);toast('This source’s login cleared.');return;}
    if(action==='browser-home'){const site=browserSource();await navigate('browse');await api('browser-open',{url:site.origin});return;}
    if(action==='browser-new-tab'){await api('browser-open',{url:browserSource().origin,newTab:true});return;}
    if(action==='open-game'){const game=currentGame(id);if(!game.threadUrl){await gameDetails(id);return;}await navigate('browse');await api('browser-open',{url:game.threadUrl,gameId:id});return;}
    if(action==='add-current'){await api('add-current-thread');toast('Thread added to your library.');return;}
    if(action.startsWith('browser-')){await api('browser-command',action.replace('browser-',''));return;}
    if(action==='check-updates'||action==='check-all-updates'){const result=await api(action);if(result?.error)toast(result.error,true);else if(!result?.busy)toast(result.message);return;}
    if(action==='logout'){await api('browser-logout',browserSource().id);toast('This source’s login cleared.');return;}
    if(action==='play'){await api('launch-game',id);return;}
    if(action==='register-game'){await api('register-game',{id});toast('Installation registered if a launch target was selected.');return;}
    if(action==='scan-saves'){
      const plan=await api('scan-saves',id);
      await modal(`<h2>Save locations</h2><p>${e(ENGINE_NAMES[plan.engine])} · ${e(plan.status)} · Experimental rule set</p><div class="rule-summary"><div><strong>${plan.local.length}</strong><small>Local save/preference files</small></div><div><strong>${plan.external.length}</strong><small>External locations left in place</small></div></div><div class="save-file-list">${plan.local.map(file=>e(file.relative)).join('<br>')||'No local save files found.'}${plan.external.length?'<br><br>External:<br>'+plan.external.map(e).join('<br>'):''}</div><p class="helper">Only identified saves and preferences transfer during an update. Other game files stay in the new release.</p><div class="form-actions">${button('add-save-folder','Add a save/preferences folder','folder',`data-id="${e(id)}"`)}</div>`,null);return;
    }
    if(action==='assign-download'){
      const job=state.downloads.find(item=>item.id===id), linked=state.games.some(game=>game.id===job.gameId);
      await modal(`<h2>${linked?'Choose library game':'Add this download'}</h2><p>Add a fresh game to your library, or associate this download with a game you already track. Updating only applies when that game has an installation.</p><label class="field"><span>Use this download for</span><select name="gameId" id="download-game-choice"><option value="__new__" ${linked?'':'selected'}>Add as new game</option>${state.games.length?`<optgroup label="Existing library games">${state.games.map(game=>`<option value="${e(game.id)}" ${game.id===job.gameId?'selected':''}>${e(game.title)} · ${e(sourceLabel(state.settings,game))}${game.installation?' — update':' — first install'}</option>`).join('')}</optgroup>`:''}</select></label><div id="download-new-game" ${linked?'hidden':''}><label class="field"><span>Game title</span><input name="title" id="download-new-title" ${linked?'':'required'} value="${e(archiveTitle(job.filename))}"></label><label class="field"><span>Engine</span><select name="engine">${engineOptions('custom')}</select><small>If unknown, leave Other / custom; extraction can identify supported layouts.</small></label><label class="field"><span>Forum thread (optional)</span><input name="threadUrl" type="url" placeholder="https://f95zone.to/threads/game.12345/"><small>A matching thread reuses its existing library entry.</small></label></div><label class="field"><span>Archive version (optional)</span><input name="version" value="${e(job.version||'')}"></label><div class="form-actions"><button type="submit" class="button primary">Continue</button></div>`,async data=>{const create=data.gameId==='__new__'?{title:data.title,engine:data.engine,threadUrl:data.threadUrl}:undefined;await api('assign-download',{id,gameId:create?undefined:data.gameId,version:data.version,create});closeModal();toast('Download linked. It is ready to install from Downloads.');});return;
    }
    if(action==='remove-game'){const result=await api(action,id);if(result?.removed){closeModal();toast(result.message);}return;}
    if(action==='retry-download'){closeModal();await api(action,id);await navigate('browse');return;}
    if(['install-zip','extract-external','select-extracted'].includes(action)){closeModal();await api('install-download',{id,mode:action==='install-zip'?'auto':action==='extract-external'?'external':'folder'});return;}
    if(action==='download-thread'){const job=state.downloads.find(job=>job.id===id),game=currentGame(job?.gameId),url=job?.thread?.threadUrl||game?.threadUrl;if(!url)throw new Error('No game thread is linked to this download.');await navigate('browse');await api('browser-open',{url,gameId:game?.id||null});return;}
    if(action==='diagnostics-copy'){await api(action);toast('Diagnostics copied as plain text.');return;}
    if(action==='apply-app-update'){const blocked=restartBlockReason(state,runtime);if(blocked)throw new Error(blocked);await api('apply-app-update');return;}
    if(action==='reset-extractor'){await api('save-settings',{resetExtractor:true});renderSettings();toast('External extractor reset to system default.');return;}
    await api(action,id); if(['choose-root','choose-extractor'].includes(action)&&page==='settings')renderSettings();
  });
});
document.addEventListener('input',event=>{
  if(event.target.id==='download-game-choice') { const creating=event.target.value==='__new__';$('#download-new-game').hidden=!creating;$('#download-new-title').required=creating;return; }
  if(event.target.dataset.candidate&&setup){if(event.target.checked)setup.selected.add(event.target.dataset.candidate);else setup.selected.delete(event.target.dataset.candidate);const status=$('#setup-scan-status');if(status)status.textContent=`${setup.candidates.length} items found · ${setup.selected.size} selected`;if(setup.importOnly)$('#modal-form [type=submit]').textContent=setup.selected.size?'Add selected games':'Done';return;}
  if(event.target.id==='game-search'){search=event.target.value;renderLibraryResults();}
});
document.addEventListener('change',event=>{
  if(event.target.id==='library-source'){sourceFilter=event.target.value;renderLibraryResults();}
  if(event.target.id==='library-sort'){librarySort=event.target.value;localStorage.setItem('library-sort',librarySort);renderLibraryResults();}
});
document.addEventListener('submit',event=>{
  event.preventDefault();
  if(event.target.dataset.sourceForm){void busy(event.target.querySelector('[type=submit]'),async()=>{await api('save-source',{...Object.fromEntries(new FormData(event.target)),id:event.target.dataset.sourceForm});toast('Source settings saved. Check site to verify the endpoint.');});}
  if(event.target.id==='settings-form'){void busy(event.target.querySelector('[type=submit]'),async()=>{await api('save-settings',Object.fromEntries(new FormData(event.target)));toast('Preferences saved.');});}
  if(event.target.id==='modal-form'&&modalSubmit){void busy(event.target.querySelector('[type=submit]'),async()=>modalSubmit(formData()));}
});
$('#modal').addEventListener('cancel',event=>{if(setup?.running){event.preventDefault();return;}setup=null;$('#modal').classList.remove('setup-dialog');});
$('#modal').addEventListener('close',()=>requestAnimationFrame(layoutBrowser));
document.addEventListener('error',event=>{if(event.target instanceof HTMLImageElement&&event.target.matches('.cover-image'))event.target.remove();},true);
window.addEventListener('resize',layoutBrowser);
document.addEventListener('keydown',event=>{
  if(page!=='browse'||$('#modal').open||!(event.metaKey||event.ctrlKey)||event.altKey)return;
  if(event.key.toLowerCase()==='t'){event.preventDefault();void api('browser-open',{url:browserSource().origin,newTab:true}).catch(error=>toast(error.message,true));}
  if(event.key.toLowerCase()==='w'&&browserState.activeId){event.preventDefault();void api('browser-close-tab',browserState.activeId).catch(error=>toast(error.message,true));}
});
window.library.onState(next=>{
  state=next;
  if(next.runtime)runtime=next.runtime;
  if(!runtime)return;
  if(setup?.running&&$('#setup-scan-status'))$('#setup-scan-status').textContent=state.libraryScan?.message||'Looking for games…';
  renderSourceStatus();
  // Keep source endpoint fields and preference edits in place during progress events.
  if(page==='settings'&&document.activeElement?.closest('form'))return;
  if(page==='browse'){const scan=$('#scan-status');scan.innerHTML=`<span class="${state.scan.active?'spinning':''}">${icon('refresh')}</span><span>${e(state.scan.message)}</span>`;return;}
  render();
});
window.library.onBrowser(next=>{browserState=next;renderBrowserState();renderSourceStatus();});
window.library.onNotice(message=>toast(message,true));
setInterval(()=>{if(state&&runtime&&page==='settings'&&Object.values(state.sourceStatus||{}).some(status=>status.active))renderSourceStatus();},1000);
try{
  const initial=await api('snapshot');runtime=initial.runtime;browserState=initial.browser;state=initial;
  document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));render();
  if(!state.settings.setupCompleted)await startSetup();
}catch(error){content.innerHTML=`<div class="boot-error"><h1>The library couldn’t open.</h1><p>${e(error.message)}</p></div>`;}

import { ENGINES, ENGINE_NAMES, hasUpdate, updateSkipped, canInstallArchive, versionKnown, versionRelation, isInstalled, canLaunchGame, PLAY_STATUSES, LAUNCH_LOCALES } from '../core/model.mjs';
import { downloadGroup, downloadProgress, downloadLabel, currentGameDownload } from '../core/download-view.mjs';
import { archiveTitle } from '../core/archive-names.mjs';
import { configuredSources, sourceLabel, sourceId, sourceById, gameSearchSource } from '../core/sources.mjs';
import { displayAppVersion as displayVersion, restartBlockReason } from '../core/app-update-state.mjs';
import { openGalleryViewer } from './gallery-viewer.mjs';

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
  edit: '<path d="m15 5 4 4M4 20l4-.8L20 7a2.8 2.8 0 0 0-4-4L4 15z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  file: '<path d="M14 2H5v20h14V7zM14 2v6h5M8 13h8M8 17h6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.info}</svg>`;
const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const $ = selector => document.querySelector(selector);
const gameTags = game => [...new Set([game.tags, game.personalTags].filter(Array.isArray).flat())];
const libraryStatuses = [['all', 'All games'], ['updates', 'Updates'], ['active', 'In progress'], ['installed', 'Installed'], ['uninstalled', 'Not installed'], ['broken', 'Needs attention']];
function gameNeedsAttention(game, jobs = []) {
  if (game.availability?.status && game.availability.status !== 'available') return true;
  if (game.installation && !canLaunchGame(game)) return true;
  if (jobs.some(job => downloadGroup(job) === 'attention')) return true;
  return false;
}
const librarySources = [['all', 'All sources'], ['LC', 'LC only'], ['F95', 'F95 only'], ['Local', 'Local only']];
const librarySorts = [
  ['added-desc', 'Newest added'], ['added-asc', 'Oldest added'],
  ['title-asc', 'Title A–Z'], ['title-desc', 'Title Z–A'], ['installed-desc', 'Recently installed'], ['played-desc', 'Last played or launched']
];
const titleOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const privacyModes = ['off', 'covers', 'titles'];
let libraryPrivacy = localStorage.getItem('library-privacy') || 'off';
if (!privacyModes.includes(libraryPrivacy)) libraryPrivacy = 'off';
const displayGameTitle = game => libraryPrivacy === 'titles' ? 'Hidden title' : game.title;
let sourceFilter = 'all', librarySort = localStorage.getItem('library-sort');
if (!librarySorts.some(([id]) => id === librarySort)) librarySort = 'added-desc';
const emptyExtraFilters = { engine: '', tag: '', playStatus: '', favorites: false, watching: false };
let extraFilters = { ...emptyExtraFilters };
let selectedGames = null;
let visibleGameIds = [];
let libraryPresets;
try { libraryPresets = JSON.parse(localStorage.getItem('library-presets')); } catch {}
if (!Array.isArray(libraryPresets)) libraryPresets = [];
let state, runtime, browserState = { activeId: null, tabs: [] }, page = 'library', filter = 'all', search = '', view = localStorage.getItem('view') || 'grid', modalSubmit, toastTimer;
let setup, driveStorage, storageError, storageLoading = false;
const content = $('#content');
const listingMarkup = new WeakMap();
const engineOptions = selected => ENGINES.map(([id, name]) => `<option value="${id}" ${id === selected ? 'selected' : ''}>${e(name)}</option>`).join('');
const button = (action, label, name, extra = '', primary = false) => `<button type="button" class="button ${primary ? 'primary' : ''}" data-action="${action}" ${extra}>${name ? icon(name) : ''}${label}</button>`;
const actionMenu = (label, actions) => actions ? `<details class="action-menu"><summary aria-label="${e(label)}" title="${e(label)}">${icon('more')}</summary><div class="action-menu-panel">${actions}</div></details>` : '';
const spinner = '<span class="loading-spinner" aria-hidden="true"></span>';
const loadingStatus = (label, id = '') => `<p class="loading-status" role="status">${spinner}<span${id ? ` id="${e(id)}"` : ''}>${e(label)}</span></p>`;
const formData = () => Object.fromEntries(new FormData($('#modal-form')));
async function api(action, input) {
  const result = await window.library.call(action, input);
  if (!result.ok) throw new Error(result.error || 'The action could not be completed.');
  return result.value;
}
function toast(message, error = false) { const item = $('#toast'); item.textContent = message; item.className = `visible${error ? ' error' : ''}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => item.className = '', error ? 10000 : 5000); }
async function busy(element, fn) {
  element.disabled = true;
  element.classList.add('is-pending');
  element.setAttribute('aria-busy', 'true');
  try { await fn(); }
  catch (error) { toast(error.message, true); }
  finally {
    element.disabled = false;
    element.classList.remove('is-pending');
    element.removeAttribute('aria-busy');
  }
}
function time(value) { return value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not yet'; }
function bytes(value) { if (!value) return '0 B'; const units = ['B','KB','MB','GB']; const n = Math.min(3, Math.floor(Math.log(value) / Math.log(1024))); return `${(value / 1024 ** n).toFixed(n > 1 ? 1 : 0)} ${units[n]}`; }
function currentGame(id) { return state.games.find(game => game.id === id); }
function pageActions(actions) { return actions ? `<div class="page-actions">${actions}</div>` : ''; }
function renderListing(container, markup) {
  if (listingMarkup.get(container) === markup) return;
  const rowSelector = '[data-library-game], [data-download-row]';
  const rowKey = row => row.dataset.libraryGame || row.dataset.downloadRow;
  const focus = container.contains(document.activeElement) ? document.activeElement : null;
  const focusedRow = focus?.closest(rowSelector);
  const openRows = new Set([...container.querySelectorAll('.action-menu[open]')]
    .map(menu => menu.closest(rowSelector)).filter(Boolean).map(rowKey));
  container.innerHTML = markup;
  listingMarkup.set(container, markup);
  const rows = [...container.querySelectorAll(rowSelector)];
  for (const row of rows) {
    const menu = row.querySelector('.action-menu');
    if (menu && openRows.has(rowKey(row))) menu.open = true;
  }
  if (!focus) return;
  const scope = focusedRow ? rows.find(row => rowKey(row) === rowKey(focusedRow)) : container;
  if (!scope) return;
  const match = focus === focusedRow ? scope : [...scope.querySelectorAll('button, summary, input[data-select-game]')].find(control =>
    control.tagName === focus.tagName && control.dataset.action === focus.dataset.action &&
    (!['game-details', 'toggle-game-selection'].includes(focus.dataset.action) || control.className === focus.className));
  match?.focus({ preventScroll: true });
}
function empty(title, description, name, actions = '') { return `<div class="empty-state"><div class="empty-icon">${icon(name)}</div><h2>${title}</h2><p>${description}</p><div class="empty-actions">${actions}</div></div>`; }
function status(game) { if(game.availability?.status==='missing')return '<span class="badge">Not installed</span>';if(['offline','unreadable'].includes(game.availability?.status))return '<span class="badge">Files unavailable</span>';const relation=updateSkipped(game)?'skipped':versionRelation(game.installedVersion,game.latestVersion);return relation==='newer'?'<span class="badge update">Update available</span>':relation==='different'?'<span class="badge update">Version differs</span>':game.installation?`<span class="badge installed">${relation==='older'?'Installed version ahead':'Installed'}</span>`:'<span class="badge">Not installed</span>'; }
function gameImage(game) { const value=game.cover||'';return /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/.test(value)?value:''; }
function versionLabel(game) { return `${game.installation?(game.availability?.status==='missing'?'Last installed ':'Installed ')+(versionKnown(game.installedVersion)?game.installedVersion:'unknown')+(game.installationCheck?.status==='unverified'?' (unverified)':'')+' · ':''}Forum ${versionKnown(game.latestVersion)?game.latestVersion:game.threadId?'unknown':'not linked'}`; }
function playDuration(milliseconds) {
  const minutes = Math.floor(milliseconds / 60000);
  if (minutes < 1) return 'Under a minute';
  const hours = Math.floor(minutes / 60);
  return hours ? hours + ' h ' + minutes % 60 + ' min' : minutes + ' min';
}
function transferStatus(job, showBar = false, updating = false) {
  const percent = job.status === 'downloading' ? downloadProgress(job) : null;
  const baseLabel = updating && job.status === 'downloading' && !job.error ? 'Downloading update' : downloadLabel(job);
  const label = baseLabel + (percent == null ? '' : ' · ' + percent + '%');
  const group = downloadGroup(job);
  const badgeClass = group === 'attention' ? 'update' : group === 'active' ? 'active' : '';
  const progress = showBar && job.status === 'downloading'
    ? `<progress class="progress" aria-label="Download progress" max="100" ${percent == null ? '' : 'value="' + percent + '"'}></progress>` : '';
  return `<div class="transfer-status"><span class="badge ${badgeClass}">${e(label)}</span>${job.status === 'downloading' && job.speed > 0 ? `<small>${bytes(job.speed)}/s</small>` : ''}${progress}</div>`;
}
function gameCard(game, jobs = []) {
  const id = e(game.id), title = e(displayGameTitle(game)), initial = e(displayGameTitle(game).replace(/[^\p{L}\p{N}\s]/gu,'').split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase());
  const playable = canLaunchGame(game);
  const download = jobs.find(canInstallArchive);
  const transfer = currentGameDownload(jobs);
  const indicator = transfer ? transferStatus(transfer, true, isInstalled(game)) : status(game);
  const finish = download?.status === 'awaiting-folder' || Boolean(download?.extractedPath);
  const action = playable ? 'play' : download && !isInstalled(game) ? 'install-zip' : game.installation ? 'register-game' : download ? 'install-zip' : game.threadUrl ? 'open-game' : 'game-details';
  const quickUpdate = playable && download ? button('install-zip', finish ? 'Resume' : 'Update', 'download', `data-id="${e(download.id)}"`)
    : playable && game.threadUrl && hasUpdate(game) ? button('get-game-update', 'Get update', 'refresh', `data-id="${id}"`) : '';
  const actions = button(action, playable ? 'Play' : action==='install-zip' ? finish ? 'Finish installation' : 'Install game' : game.installation ? game.availability?.status==='missing'?'Locate game':'Locate launch file' : download ? finish ? 'Finish installation' : 'Install game' : game.threadUrl ? 'Open thread' : 'Game details', playable ? 'play' : 'arrow', `data-id="${action==='install-zip'?e(download.id):id}"`, playable||Boolean(download)) + quickUpdate + (!game.threadId?`<button class="icon-button" data-action="find-forum-game" data-id="${id}" aria-label="Find forum match for ${title}" title="Find forum details">${icon('search')}</button>`:'');
  const selecting = selectedGames !== null;
  const selected = Boolean(selectedGames?.has(game.id));
  const cardAttrs = `data-library-game="${id}"${selected ? ' data-selected="true"' : ''}`;
  const detailsAction = selecting ? 'toggle-game-selection' : 'game-details';
  const artLabel = selecting ? `Toggle selection for ${title}` : `Open details for ${title}`;
  const checkbox = selecting ? `<input type="checkbox" class="library-select-game" data-select-game="${id}" aria-label="Select ${title}" ${selected ? 'checked' : ''}>` : '';
  const image=gameImage(game), art=image?`<img class="cover-image" src="${e(image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`:'';
  if (view === 'list') return `<article class="game-row" ${cardAttrs}>${checkbox}<button type="button" class="mini-art" data-action="${detailsAction}" data-id="${id}" aria-label="${artLabel}">${initial}${art}</button><div class="game-row-info"><h3><button type="button" class="game-title" data-action="${detailsAction}" data-id="${id}">${title}</button></h3><p>${sourceBadge(game)} ${e(ENGINE_NAMES[game.engine] || 'Other')} · ${e(versionLabel(game))}</p></div>${indicator}${selecting ? '' : actions}</article>`;
  return `<article class="game-card" ${cardAttrs}>
    <div class="game-cover">
      <button type="button" class="game-art" aria-label="${artLabel}" aria-describedby="card-status-${id}" data-action="${detailsAction}" data-id="${id}">
        <span class="monogram">${initial}</span>${art}
      </button>
      <div class="cover-status" id="card-status-${id}">${indicator}</div>
      ${checkbox}
    </div>
    <div class="game-info">
      <div><h3><button type="button" class="game-title" data-action="${detailsAction}" data-id="${id}" title="${title}">${title}</button></h3>
      <div class="game-meta" title="${e(versionLabel(game))}">${sourceBadge(game)} <span>${e(ENGINE_NAMES[game.engine] || 'Other')}</span></div></div>
      ${selecting ? '' : actionMenu('Actions for ' + displayGameTitle(game), actions)}
    </div>
  </article>`;
}
function compareLibraryGames(a, b) {
  const title = titleOrder.compare(a.title, b.title);
  if (librarySort === 'title-asc') return title;
  if (librarySort === 'title-desc') return -title;
  const date = game => librarySort === 'played-desc' ? (game.lastPlayedAt || game.lastLaunchedAt) : librarySort === 'installed-desc' ? (isInstalled(game) ? game.installation.at : 0) : game.addedAt;
  const first = date(a), second = date(b);
  if (!first || !second) return Number(Boolean(second)) - Number(Boolean(first)) || title;
  return (librarySort === 'added-asc' ? first - second : second - first) || title;
}
function renderLibraryResults() {
  syncExtraFilters();
  const query = search.trim().toLowerCase();
  const jobs = new Map();
  for (const job of state.downloads) {
    if (!jobs.has(job.gameId)) jobs.set(job.gameId, []);
    jobs.get(job.gameId).push(job);
  }
  const visible = state.games.filter(game => {
    const installed = isInstalled(game);
    if (filter === 'updates' && !(installed && hasUpdate(game))) return false;
    if (filter === 'active' && !jobs.get(game.id)?.some(job => downloadGroup(job) === 'active')) return false;
    if (filter === 'broken' && !gameNeedsAttention(game, jobs.get(game.id))) return false;
    if ((filter === 'installed' && !installed) || (filter === 'uninstalled' && installed)) return false;
    if (sourceFilter !== 'all' && sourceLabel(state.settings, game) !== sourceFilter) return false;
    if (extraFilters.engine && game.engine !== extraFilters.engine) return false;
    if (extraFilters.tag && !gameTags(game).includes(extraFilters.tag)) return false;
    if (extraFilters.playStatus && (game.playStatus || 'backlog') !== extraFilters.playStatus) return false;
    if (extraFilters.favorites && !game.favorite) return false;
    if (extraFilters.watching && !game.watching) return false;
    return !query || `${game.title} ${ENGINE_NAMES[game.engine]}`.toLowerCase().includes(query);
  }).sort(compareLibraryGames);
  visibleGameIds = visible.map(game => game.id);
  if (selectedGames) {
    const gameIds = new Set(state.games.map(game => game.id));
    for (const id of selectedGames) if (!gameIds.has(id)) selectedGames.delete(id);
  }
  const selectionBar = $('#library-selection');
  selectionBar.hidden = !selectedGames;
  $('.library-filter-strip').hidden = Boolean(selectedGames);
  $('#library-selection-count').textContent = selectedGames ? `${selectedGames.size} selected` : '';
  for (const control of selectionBar.querySelectorAll('[data-requires-selection]')) control.disabled = !selectedGames?.size;
  $('[data-action="select-visible-games"]').disabled = !visibleGameIds.some(id => !selectedGames?.has(id));
  for (const control of content.querySelectorAll('[data-filter], [data-view], [data-source-filter]')) {
    control.setAttribute('aria-pressed', control.dataset.filter === filter || control.dataset.view === view || control.dataset.sourceFilter === sourceFilter);
  }
  const count = $('#library-result-count');
  const label = `${visible.length} ${visible.length === 1 ? 'game' : 'games'}`;
  if (count.textContent !== label) count.textContent = label;
  renderListing($('#library-results'), visible.length ? `<div class="game-${view}">${visible.map(game => gameCard(game, jobs.get(game.id))).join('')}</div>`
    : state.games.length ? empty('No matching games', 'Try a different search or filter.', 'search', button('reset-filter', 'Clear filters', null))
    : empty('Your next favourite is out there.', 'Sign in to F95 or LewdCorner, browse a game thread, and add it to your library. Your collection stays on this device.', 'library', button('browse', 'Browse games', 'globe', '', true) + button('add-thread', 'Add a thread URL', 'plus')));
}
function renderLibrary() {
  if (!$('#library-results')) {
    $('#library-primary').innerHTML = `
        <label class="search">${icon('search')}<input type="search" id="game-search" placeholder="Search library…" value="${e(search)}" aria-label="Search library"></label>
        <select id="library-sort" aria-label="Sort games">${selectOptions(librarySorts, librarySort)}</select>
        ${button('add-thread', 'Add game', 'plus', '', true)}
        <details class="action-menu library-menu"><summary aria-label="Library actions" title="Library actions">${icon('more')}</summary><div class="action-menu-panel" id="library-actions"></div></details>`;
    const statusButton = ([id, label]) => `<button type="button" class="filter" data-filter="${id}">${label}${id === 'updates' ? '<span id="library-update-count" hidden></span>' : ''}</button>`;
    content.innerHTML = `<div class="library-controls">
        <div class="library-filter-strip">
          <div class="filters" role="group" aria-label="Game status">${libraryStatuses.filter(([id]) => ['all', 'updates', 'installed'].includes(id)).map(statusButton).join('')}</div>
          <div class="filters" role="group" aria-label="Source filters">${['F95', 'LC'].map(id => `<button type="button" class="filter" data-source-filter="${id}" aria-label="Filter to ${id} games">${id}</button>`).join('')}</div>
          <details id="library-extra-filters" class="library-extra-filters">
            <summary>More filters <span id="library-extra-count"></span></summary>
            <div class="library-filter-panel">
              <div class="filters" role="group" aria-label="More game statuses">${libraryStatuses.filter(([id]) => !['all', 'updates', 'installed'].includes(id)).map(statusButton).join('')}</div>
              <div class="library-filter-fields">
                <label>Source<select id="library-source" aria-label="Filter by source">${selectOptions(librarySources, sourceFilter)}</select></label>
                <label>Engine<select data-extra-filter="engine">${selectOptions([['', 'Any engine'], ...ENGINES], extraFilters.engine)}</select></label>
                <label>Tag<select data-extra-filter="tag"></select></label>
                <label>Play status<select data-extra-filter="playStatus">${selectOptions([['', 'Any play status'], ...PLAY_STATUSES], extraFilters.playStatus)}</select></label>
                <label class="favorite-filter"><input type="checkbox" data-extra-filter="favorites"> Favorites only</label>
                <label class="favorite-filter"><input type="checkbox" data-extra-filter="watching"> Watched only</label>
              </div>
              <div class="download-actions">
                ${button('save-library-preset', 'Save current view', 'plus')}
                ${button('remove-library-preset', 'Remove saved view', 'trash', 'disabled')}
              </div>
            </div>
          </details>
        </div>
        <div id="library-selection" class="library-selection" hidden>
          <strong id="library-selection-count" role="status"></strong>
          ${button('select-visible-games', 'Select shown', null)}
          ${button('clear-game-selection', 'Clear', null, 'data-requires-selection')}
          ${button('bulk-play-status', 'Play status', null, 'data-requires-selection')}
          ${button('bulk-edit-tags', 'Edit tags', null, 'data-requires-selection')}
          ${button('bulk-watch', 'Watch updates', null, 'data-requires-selection')}
          ${button('finish-game-selection', 'Done', 'check')}
        </div>
        <div class="search-tools">
          <select id="library-preset" aria-label="Saved library view"></select>
          <div class="view-toggle" role="group" aria-label="Library view">
            <button type="button" class="icon-button" data-view="grid" aria-label="Grid view">${icon('library')}</button>
            <button type="button" class="icon-button" data-view="list" aria-label="List view">${icon('list')}</button>
          </div>
        </div>
      </div>
      <span class="sr-only" id="library-result-count" role="status"></span>
      <div id="library-results"></div><div id="library-onboarding"></div>`;
    renderLibraryPresets();
  }
  document.body.dataset.libraryPrivacy = libraryPrivacy;
  const privacy = libraryPrivacy === 'off' ? 'Privacy off' : libraryPrivacy === 'covers' ? 'Covers blurred' : 'Titles hidden';
  const updates = state.games.filter(game => isInstalled(game) && hasUpdate(game)).length;
  $('#library-update-count').hidden = !updates;
  $('#library-update-count').textContent = updates;
  renderListing($('#library-actions'),
    button('select-library-games', 'Select games', 'check', !state.games.length || selectedGames ? 'disabled' : '') +
    button('cycle-library-privacy', privacy, null, 'title="Cycle Library privacy (Ctrl or ⌘ + Shift + P)"') +
    button('scan-folder', 'Scan games folder', 'folder') +
    button('refresh-library-details', state.detailScan?.active ? state.detailScan.message : 'Refresh library details', 'refresh', state.detailScan?.active ? 'disabled' : '') +
    button('check-updates', 'Check for updates', 'refresh', state.scan.active ? 'disabled' : '') +
    button('check-all-updates', 'Check all linked threads', 'search', state.scan.active ? 'disabled' : 'title="Optional full verification of every linked game"') +
    button('export-library', 'Export library (.json)', 'download') +
    button('import-library', 'Import library (.json)', 'plus'));
  $('#library-onboarding').innerHTML = state.settings.setupCompleted ? '' : `<div class="onboarding">${icon('folder')}<div><strong>Finish setting up your library.</strong><p>Choose a games folder, download behaviour, and optionally find your existing games.</p></div>${button('setup', 'Set up library', 'arrow')}</div>`;
  renderLibraryResults();
}
function syncExtraFilters() {
  const tagSelect = $('[data-extra-filter="tag"]');
  const tags = new Set(state.games.flatMap(gameTags));
  if (extraFilters.tag) tags.add(extraFilters.tag);
  const tagList = [...tags].sort(titleOrder.compare);
  const signature = JSON.stringify(tagList);
  if (tagSelect.dataset.tags !== signature) {
    tagSelect.innerHTML = selectOptions([['', 'Any tag'], ...tagList.map(tag => [tag, tag])], '');
    tagSelect.dataset.tags = signature;
  }
  for (const control of content.querySelectorAll('[data-extra-filter]')) {
    const value = extraFilters[control.dataset.extraFilter];
    if (control.type === 'checkbox') control.checked = value;
    else if (control.value !== value) control.value = value;
  }
  $('#library-source').value = sourceFilter;
  const count = Object.values(extraFilters).filter(Boolean).length
    + Number(sourceFilter === 'Local') + Number(['active', 'uninstalled', 'broken'].includes(filter));
  $('#library-extra-count').textContent = count ? `(${count})` : '';
}
function renderLibraryPresets() {
  $('#library-preset').innerHTML = selectOptions([['', 'Saved views'], ...libraryPresets.map(view => [view.id, view.name])], '');
  $('[data-action="remove-library-preset"]').disabled = true;
}
function applyLibraryPreset(preset) {
  ({ filter, sourceFilter, librarySort, search, extraFilters } = structuredClone(preset.filters));
  extraFilters = { ...emptyExtraFilters, ...extraFilters };
  $('#library-source').value = sourceFilter;
  $('#library-sort').value = librarySort;
  $('#game-search').value = search;
  $('#library-extra-filters').open = Object.values(extraFilters).some(Boolean) || sourceFilter === 'Local';
  localStorage.setItem('library-sort', librarySort);
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
function downloadCard(job) {
  const game = currentGame(job.gameId);
  const active = ['downloading', 'queued', 'retrying'].includes(job.status);
  const installed = job.status === 'installed';
  const id = `data-id="${e(job.id)}"`;
  const gameId = `data-id="${e(game?.id)}"`;
  const password = job.thread?.archivePassword || game?.archivePassword || '';
  const installable = canInstallArchive(job);
  let primary = '', secondary = '';
  if (active) primary = button('cancel-download', 'Cancel', null, id);
  if (['failed', 'cancelled'].includes(job.status)) primary = button('retry-download', 'Return to thread', 'globe', id, true);
  if (installable && game) {
    const finish = job.status === 'awaiting-folder' || Boolean(job.extractedPath);
    const label = finish ? (job.extractedPath ? 'Resume install' : isInstalled(game) ? 'Finish update' : 'Finish installation') : isInstalled(game) ? 'Install update' : 'Install game';
    primary = button('install-zip', label, 'download', id, true);
    secondary += button('extract-external', 'Open extraction app', 'arrow', id + ' title="Open the archive again in your extraction app"');
    secondary += button('select-extracted', 'Select extracted folder', 'folder', id);
    if (job.thread?.threadUrl) secondary += button('assign-download', 'Change game', 'library', id);
  }
  if (!game && installable) primary = button('assign-download', 'Add to library', 'plus', id, true);
  if (installed && !job.archiveRemoved) primary = button('cleanup-download', 'Retry archive cleanup', 'refresh', id, true);
  if (installed && job.archiveRemoved && game && canLaunchGame(game)) primary = button('play', 'Play', 'play', gameId, true);
  if (game?.threadUrl) secondary += button('download-thread', 'Open thread', 'globe', id);
  const reveal = !job.archiveRemoved && !job.partialRemoved
    ? button('reveal-download', 'Show file', null, id + ` title="Show in ${runtime.platform === 'darwin' ? 'Finder' : 'Explorer'}"`)
    : installed && game?.installation ? button('reveal-game', 'Show folder', null, gameId) : '';
  const remove = !active && job.status !== 'installing' ? button('clear-download', 'Remove from list', null, id + ' title="Keep files on disk; remove this download record"') : '';
  const title = game ? displayGameTitle(game) : job.filename;
  const art = game && gameImage(game);
  return `<article class="download-card" data-download-row="${e(job.id)}" tabindex="-1">
    <div class="download-art">${art ? `<img class="cover-image" src="${e(art)}" alt="" loading="lazy" decoding="async">` : icon(installed ? 'check' : 'file')}</div>
    <div class="download-info">
      <strong>${e(title)}</strong>
      <p>${game && libraryPrivacy !== 'titles' ? e(job.filename) + ' · ' : ''}${job.version ? e(job.version) + ' · ' : ''}${bytes(job.received)}${job.total ? ' / ' + bytes(job.total) : ''}</p>
      ${transferStatus(job, true)}
      ${password ? `<div class="download-password"><span>Archive password</span> <code>${e(password)}</code>
        ${button('copy-password', 'Copy password', 'copy', `data-password="${e(password)}"`)}</div>` : ''}
      ${job.phase && job.status !== 'installing' ? `<p class="helper">${e(job.phase)}</p>` : ''}
      ${job.partialRemoved ? '<p class="helper">Incomplete file removed. Choose a new download from the game thread.</p>' : ''}
      ${job.partialCleanupError ? `<p class="download-error">${e(job.partialCleanupError)}</p>` : ''}
      ${job.archiveRemoved ? '<p class="helper">Compressed archive removed after confirmed installation.</p>' : ''}
      ${job.metadataWarning ? `<p class="helper">${e(job.metadataWarning)}</p>` : ''}
      ${job.error ? `<p class="download-error">${e(job.error)}</p>` : ''}
    </div>
    <div class="download-row-actions">${primary}<div class="download-row-links">${reveal}${remove}</div>${actionMenu('Download actions for ' + title, secondary)}</div>
  </article>`;
}
function renderDownloads() {
  const clearable = state.downloads.some(job => ['downloaded', 'installed'].includes(job.status));
  const groups = [['attention', 'Needs attention'], ['active', 'In progress'], ['completed', 'Completed']];
  const sections = groups.map(([id, label]) => {
    const jobs = state.downloads.filter(job => downloadGroup(job) === id);
    if (!jobs.length) return '';
    return `<section class="download-section" aria-label="${label}"><h2>${label} <small>${jobs.length}</small></h2><div class="download-list">${jobs.map(downloadCard).join('')}</div></section>`;
  }).join('');
  renderListing(content, pageActions((clearable ? button('clear-completed-downloads', 'Clear completed transfers', 'close',
    'title="Remove completed transfer records and keep their files on disk"') : '') + button('browse', 'Find a game', 'globe')) +
    (sections || empty('Nothing in Downloads', 'Start a download from a game thread or drop an archive onto its Library card.', 'download', button('browse', 'Browse games', 'globe', '', true))));
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
  content.innerHTML = `<div class="settings-grid"><section class="panel"><h2>Games & downloads</h2><p>Downloads, extraction, and folder selection start in your chosen games directory.</p><div class="path-picker">${icon('folder')}<span class="path-value">${e(state.settings.gamesRoot||'No games folder selected')}</span>${button('choose-root','Choose default',null)}</div>
    ${(state.settings.extraGamesRoots || []).map(root => `<div class="path-picker">${icon('folder')}<span class="path-value">${e(root)}</span>${button('remove-games-root','Remove',null,`data-root="${e(root)}"`)}</div>`).join('')}
    <div class="download-actions">${button('add-games-root','Add games folder','plus')}</div><label class="field"><span>External extraction application</span></label><div class="path-picker">${icon('file')}<span class="path-value">${e(state.settings.extractor||'Use the system’s default app for external extraction')}</span>${state.settings.extractor?button('reset-extractor','Use default',null):''}${button('choose-extractor','Choose app',null)}</div><p class="helper">Install handles ordinary ZIP releases automatically. Use this app for other formats, passwords or multipart archives; select its output if it cannot report completion.</p><div class="download-actions">${button('setup','Run setup again','settings')}${button('scan-folder','Find existing games','search')}${button('open-drive-storage','Storage by drive','folder')}</div></section>
    <form id="settings-form" class="panel"><h2>Forum & preferences</h2><p>Games check their own F95 or LewdCorner source. Browsing another source does not reassign your library.</p><label class="field"><span>Completed downloads</span><select name="downloadMode"><option value="download-only" ${state.settings.downloadMode==='download-only'?'selected':''}>Download only — install manually</option><option value="assisted" ${state.settings.downloadMode==='assisted'?'selected':''}>Offer to install/update after downloading</option></select><small>You choose the provider and start each download. Installation transfers identified saves and preferences.</small></label><div class="field-row"><label class="field"><span>Check while the app is open</span><select name="intervalMinutes">${[5,15,30,60,120].map(n=>`<option value="${n}" ${state.settings.intervalMinutes===n?'selected':''}>Every ${n} minutes</option>`).join('')}</select></label><label class="field"><span>Old versions after an update</span><select name="retention">${[['keep','Keep all old versions'],['previous','Keep the previous version'],['delete','Permanently delete old versions']].map(([id,label])=>`<option value="${id}" ${state.settings.retention===id?'selected':''}>${label}</option>`).join('')}</select></label></div><label class="field"><span>Appearance</span><select name="theme"><option value="dark" ${state.settings.theme==='dark'?'selected':''}>Dark forum style</option><option value="light" ${state.settings.theme==='light'?'selected':''}>Light forum style</option></select></label><p class="helper">Archives are automatically deleted after confirmed installation. Download-only and unconfirmed archives remain available.</p><div class="form-actions"><button class="button primary" type="submit">Save preferences</button></div></form>
    ${sourceSettings()}<section class="panel"><h2>Account & support</h2><p>Sign in on the actual website in Browse. The app keeps your forum session separate from game save data.</p><div class="download-actions">${button('browser-home','Open forum login','globe')}${button('logout','Clear current login',null)}${button('export-library','Export library (.json)','download')}${button('import-library','Import library (.json)','plus')}${button('diagnostics-copy','Copy diagnostics','file')}${button('diagnostics-save','Save diagnostics.txt','download')}</div><table class="support-table"><tr><td>Application</td><td>AfterShelf ${e(displayVersion(runtime.version))}</td></tr><tr><td>This device</td><td>${e(runtime.platform)} · ${e(runtime.arch)}</td></tr><tr><td>Engine rules</td><td>Game validation in progress</td></tr></table></section></div>`;
}
function renderActivity() {
  content.innerHTML = pageActions(button('diagnostics-copy','Copy diagnostics','file')+button('diagnostics-save','Save .txt','download'))+
    `<section class="panel"><div class="subheading"><h2>Recent events</h2><span class="helper">Stored on this device</span></div><div class="history">${state.history.map(item=>`<div class="history-item"><span class="status-dot"></span><time>${time(item.at)}</time><div><strong>${e(item.message)}</strong>${item.details?`<p>${e(item.details)}</p>`:''}${currentGame(item.gameId)?button('show-watched-game','View game',null,`data-id="${e(item.gameId)}"`):''}</div></div>`).join('')||'<p class="helper">Your recent activity will appear here.</p>'}</div></section>`;
}
function renderScanStatus() {
  const scan = state.scan;
  const refresh = state.detailScan;
  const status = $('#scan-status');
  const progress = scan.active ? scan : refresh?.active ? refresh : null;
  const label = progress ? progress.message
    : scan.error ? scan.summary?.statusText || 'Update check incomplete'
    : scan.summary?.statusText || (scan.lastChecked ? 'Last checked ' + time(scan.lastChecked) : 'Not checked yet');
  status.firstElementChild.classList.toggle('spinning', Boolean(progress));
  if (status.lastElementChild.textContent !== label) status.lastElementChild.textContent = label;
  status.title = progress ? label : [scan.message, scan.error, scan.lastChecked ? 'Last completed: ' + time(scan.lastChecked) : ''].filter(Boolean).join('\n');
}
function render() {
  if (!state) return;
  document.documentElement.dataset.theme = state.settings.theme;
  document.body.dataset.page = page;
  document.querySelectorAll('[data-nav]').forEach(el=>el.classList.toggle('active',el.dataset.nav===(page==='storage'?'settings':page)));
  const library = page === 'library';
  $('#breadcrumb-current').hidden = library;
  $('#breadcrumb-current').textContent = page[0].toUpperCase()+page.slice(1);
  $('#library-primary').hidden = !library;
  $('#library-count').textContent = state.games.length;
  $('#downloads-count').textContent = state.downloads.filter(job=>job.status!=='installed').length;
  $('#app-version').textContent = displayVersion(runtime.version);
  $('#platform-status').textContent = `${runtime.platform==='darwin'?'macOS':'Windows'} · ${runtime.arch}`;
  $('#folder-status').textContent = state.settings.gamesRoot || 'Choose a games folder to get started';
  renderScanStatus();
  content.className = page==='browse'?'browse-page':'';
  if (page==='library') renderLibrary();
  if (page==='browse') renderBrowse();
  if (page==='downloads') renderDownloads();
  if (page==='settings') renderSettings();
  if (page==='storage') renderDriveStorage();
  if (page==='activity') renderActivity();
  renderSourceStatus();
  requestAnimationFrame(layoutBrowser);
}
async function navigate(next) {
  if (next !== 'library') selectedGames = null;
  if (page !== next) listingMarkup.delete(content);
  page = next;
  await api('browser-layout', null);
  render();
}
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
async function showDownloadOptions(id, detailTab) {
  const game = currentGame(id);
  if (!game?.threadUrl) throw new Error('Link a forum thread first.');
  const attrs = `data-id="${e(id)}"`;
  const back = detailTab ? button('detail-tab', 'Back to game', null, attrs + ` data-tab-name="${e(detailTab)}"`) : '';
  await modal(`<h2>Get update</h2><p>${e(displayGameTitle(game))}${game.latestVersion ? ' · ' + e(game.latestVersion) : ''}</p>
    <div id="download-picker-options">${loadingStatus('Reading download links from the thread…')}</div>
    <div class="form-actions">${back}${button('open-game', 'Open full thread', 'globe', attrs)}</div>`, null);
  const panel = $('#download-picker-options');
  try {
    const { token, options } = await api('game-download-options', id);
    if (!$('#modal').open || !panel.isConnected) return;
    if (!options.length) {
      panel.innerHTML = '<p>No download links were recognized. Open the full thread to choose a host.</p>';
      return;
    }
    const groups = new Map();
    for (const option of options) {
      if (!groups.has(option.platform)) groups.set(option.platform, []);
      groups.get(option.platform).push(option);
    }
    panel.innerHTML = '<p>Choose the build and host you want to open in Browse.</p>' +
      [...groups].map(([platform, mirrors]) => `<section class="download-picker-group">
        <h3>${e(platform)}</h3>
        <div class="download-actions">${mirrors.map(({ label, index }) => button('open-download-option', e(label), 'globe',
          `data-token="${e(token)}" data-index="${index}"`)).join('')}</div>
      </section>`).join('');
  } catch (error) {
    if ($('#modal').open && panel.isConnected) panel.innerHTML = `<p role="alert">${e(error.message)}</p>`;
  }
}
function finishGameSelection() {
  selectedGames = null;
  renderLibrary();
  $('.library-menu summary').focus();
}
function bulkEditGames(action) {
  const ids = [...selectedGames];
  const fields = {
    'bulk-play-status': ['Change play status', `<label class="field"><span>Play status</span><select name="playStatus">${selectOptions(PLAY_STATUSES, '')}</select></label>`],
    'bulk-edit-tags': ['Edit personal tags', `<label class="field"><span>Action</span><select name="tagMode"><option value="add">Add tags</option><option value="remove">Remove tags</option></select></label>
      <label class="field"><span>Tags</span><input name="tags" maxlength="3000" required placeholder="Favorites, weekend"><small>Separate tags with commas. Forum tags come from the source thread.</small></label>`],
    'bulk-watch': ['Watch updates', '<label class="field"><span>Updates</span><select name="watch"><option value="on">Watch releases</option><option value="off">Stop watching</option></select><small>Watching is available for games linked to a forum thread.</small></label>']
  };
  const [title, inputs] = fields[action];
  return modal(`<h2>${title}</h2><p>Apply to ${ids.length} selected ${ids.length === 1 ? 'game' : 'games'}.</p>${inputs}
    <div class="form-actions">${button('close-modal', 'Cancel')}<button class="button primary" type="submit">Apply</button></div>`, async data => {
    if (data.watch) data.watch = data.watch === 'on';
    const { changed, skipped } = await api('bulk-edit-games', { ids, ...data });
    closeModal();
    toast(`Updated ${changed} ${changed === 1 ? 'game' : 'games'}.${skipped ? ` ${skipped} skipped.` : ''}`);
  });
}
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
    const scanStatus = setup.running
      ? loadingStatus(state.libraryScan?.message || 'Looking for games…', 'setup-scan-status')
      : `<p class="helper" id="setup-scan-status">${setup.scanned ? `${setup.candidates.length} items found · ${setup.selected.size} selected` : 'Scanning is optional. You can also do this later from Library or Settings.'}</p>`;
    body=`<h2>Find games you already have</h2><p>Find extracted games and compressed downloads, then choose what to add. This will not move, extract, or delete any files. Archives are added as not installed, ready to install from Library or Downloads.</p><div class="path-picker">${icon('folder')}<span class="path-value">${e(setup.root)}</span>${setup.running?button('setup-cancel-scan','Cancel scan',null):button('setup-scan',setup.scanned?'Scan again':'Scan folder','search')}</div>${scanStatus}`;
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
function selectOptions(choices, selected) {
  return choices.map(([value, label]) => `<option value="${e(value)}" ${value === selected ? 'selected' : ''}>${e(label)}</option>`).join('');
}
const playStatusLabel = game => PLAY_STATUSES.find(([id]) => id === game.playStatus)?.[1] || 'Backlog';

function releaseTimeline(game, attrs) {
  const rows = game.releases || [];
  const sources = new Map(configuredSources(state.settings).map(source => [source.origin, source.shortName]));
  const watch = game.threadUrl ? button('toggle-watch', game.watching ? 'Watching releases' : 'Watch releases', null,
    attrs + ` aria-pressed="${Boolean(game.watching)}" data-detail-tab="releases"`) : '';
  const releases = rows.map(row => {
    const play = game.versionPlaytime?.find(item => versionRelation(item.version, row.version) === 'same');
    return `<article class="release-entry"><h3>${e(row.version)}</h3><small>${e(sources.get(row.origin) || 'Unmapped source')} · First seen ${time(row.firstSeen)}${play ? ' · Played ' + playDuration(play.duration) : ''}</small>
      ${row.notes && libraryPrivacy !== 'titles' ? `<p>${e(row.notes)}</p>` : ''}</article>`;
  }).join('');
  const sessions = (game.playSessions || []).slice(0, 8).map(session =>
    `<li>${time(session.at)} · ${e(session.version || 'Unknown version')} · ${playDuration(session.duration)}</li>`).join('');
  return `<div class="download-actions">${watch}</div>
    ${releases || '<p>Newly checked releases will appear here.</p>'}
    ${sessions ? `<h3>Recent play sessions</h3><ul class="save-locations">${sessions}</ul>` : ''}`;
}
function renderDriveStorage() {
  const usage = (driveStorage || []).map(drive => {
    const rows = drive.items.map(item => {
      const game = currentGame(item.gameId);
      const attrs = `data-id="${e(item.gameId)}" data-tab-name="storage"`;
      const action = item.jobId ? button('show-game-download', 'Review download', 'download', `data-id="${e(item.jobId)}"`)
        : game ? button('detail-tab', 'Review game', 'folder', attrs) : '';
      const name = game ? displayGameTitle(game) : 'Unassigned download';
      const size = item.size == null ? 'Unavailable' : (item.partial ? 'At least ' : '') + bytes(item.size);
      return `<div class="detail-row"><div><strong>${e(name)}</strong><small>${e(item.kind)}${item.version ? ' · ' + e(item.version) : ''} · ${size}</small></div>${action}</div>`;
    }).join('');
    return `<section class="panel drive-card"><div class="subheading"><h2>${drive.online ? 'Games drive' : 'Drive offline'}</h2>
      <span>${drive.free == null ? 'Free space unavailable' : bytes(drive.free) + ' free'}</span></div>
      <ul class="save-locations">${drive.folders.map(folder => `<li>${e(folder)}</li>`).join('')}</ul>
      ${drive.online ? `<p>${drive.incomplete ? 'At least ' : ''}${bytes(drive.measured)} in registered files · ${drive.itemCount} items</p>
        ${drive.incomplete ? `<p class="helper">${drive.incomplete} items could not be measured completely.</p>` : ''}
        ${rows ? `<h3>Largest items</h3>${rows}` : '<p>No registered files found on this drive.</p>'}` : ''}</section>`;
  }).join('');
  content.innerHTML = pageActions(button('settings', 'Back to Settings', 'back') + button('measure-drive-storage', 'Refresh sizes', 'refresh', storageLoading ? 'disabled' : '', true)) +
    '<p class="helper">Sizes cover registered installations and archives in your configured games folders.</p>' +
    (storageLoading ? loadingStatus('Measuring storage…') : storageError ? `<p role="alert">${e(storageError)}</p>` : usage || '<p>Choose a games folder in Settings first.</p>');
}
async function refreshDriveStorage() {
  if (storageLoading) return;
  storageLoading = true; storageError = '';
  renderDriveStorage();
  try { driveStorage = await api('storage-by-drive'); }
  catch (error) { storageError = error.message; }
  finally { storageLoading = false; if (page === 'storage') renderDriveStorage(); }
}

function detailDownloads(game) {
  const jobs = state.downloads.filter(job => job.gameId === game.id);
  const rows = jobs.map(job => {
    const attrs = `data-id="${e(job.id)}"`;
    const password = job.thread?.archivePassword || game.archivePassword || '';
    const label = job.status === 'awaiting-folder' ? 'Finish installation' : isInstalled(game) ? 'Update game' : 'Install game';
    const install = canInstallArchive(job) ? button('install-zip', label, 'download', attrs, true) : '';
    const copyPass = password ? button('copy-password', 'Copy password', 'lock', `data-password="${e(password)}" title="Copy archive password (${e(password)})"`) : '';
    const reveal = !job.archiveRemoved && !job.partialRemoved ? button('reveal-download', 'Show file', 'folder', attrs) : '';
    const viewJob = downloadGroup(job) === 'active' ? button('show-game-download', 'View download', 'download', attrs) : '';
    return `<div class="detail-row"><div><strong>${e(job.filename)}</strong><small>${e(job.version || '')}${password ? ' · Password: ' + e(password) : ''}</small>${transferStatus(job,true)}</div><div class="download-actions">${install}${copyPass}${viewJob}${reveal}</div></div>`;
  }).join('');
  return (rows || '<p>No downloads linked to this game.</p>') + button('attach-archive', 'Use downloaded archive', 'file', `data-id="${e(game.id)}"`);
}
function detailOverview(game, attrs) {
  const skipped = updateSkipped(game);
  const updateAction = skipped ? button('restore-game-update', 'Show this update again', 'refresh', attrs)
    : isInstalled(game) && hasUpdate(game) ? button('skip-game-update', 'Skip this version', null, attrs + ` data-version="${e(game.latestVersion)}"`) : '';
  const alternate = game.alternateThread;
  const sourceActions = game.threadUrl ? `<div class="detail-source">${sourceBadge(game)} <span>Primary source${alternate ? ' · ' + e(sourceLabel(state.settings,alternate)) + ' alternate' : ''}</span></div>` : '';
  const passwordRow = game.archivePassword ? `<div class="detail-row"><div><strong>Archive password</strong><small><code>${e(game.archivePassword)}</code></small></div>
    <div class="download-actions">${button('copy-password', 'Copy password', 'lock', `data-password="${e(game.archivePassword)}"`)}</div></div>` : '';
  const tags = [...new Set(gameTags(game))].map(tag => `<button type="button" class="badge detail-tag" data-action="filter-game-tag" data-tag="${e(tag)}">${e(tag)}</button>`).join('');
  const secondary = updateAction +
    (game.threadUrl ? button('toggle-watch', game.watching ? 'Watching releases' : 'Watch releases', null, attrs + ` aria-pressed="${Boolean(game.watching)}" data-detail-tab="overview"`) : '') +
    button('find-forum-game', game.threadId ? 'Change forum match' : 'Find forum match', 'search', attrs) +
    (alternate ? button('open-alternate-thread', 'Open alternate', 'globe', attrs) : '') +
    button('remove-game', 'Remove from library', 'trash', attrs);
  return `<div class="detail-overview">
    <section class="overview-story">
      <h3>About the game</h3>
      <p class="game-description">${libraryPrivacy !== 'titles' && game.description ? e(game.description) : libraryPrivacy === 'titles' ? 'Description hidden by privacy mode.' : 'No description available.'}</p>
      ${game.threadUrl ? `<div class="overview-photos" id="overview-photos" hidden></div>
        <div class="download-actions">${button('detail-tab', 'Open gallery', 'library', attrs + ' data-tab-name="gallery"')}</div>` : ''}
      ${tags ? `<div class="detail-tags">${tags}</div>` : ''}
      ${libraryPrivacy !== 'titles' && game.notes ? `<h3>Personal notes</h3><p class="detail-notes">${e(game.notes)}</p>` : ''}
      ${passwordRow}
      ${game.installationCheck?.message ? `<p class="helper">${e(game.installationCheck.message)} ${e(game.installationCheck.metadataWarning || '')}</p>` : ''}
    </section>
    <aside class="overview-summary" aria-label="Game status and actions">
      <dl class="overview-versions">
        <div><dt>Installed version</dt><dd>${isInstalled(game) ? e(game.installedVersion || 'Unknown') : 'Not installed'}</dd></div>
        <div><dt>Forum version</dt><dd>${e(game.latestVersion || (game.threadId ? 'Unknown' : 'No linked thread'))}</dd></div>
        <div><dt>${game.lastPlayedAt ? 'Last played' : 'Last launched'}</dt><dd>${time(game.lastPlayedAt || game.lastLaunchedAt)}</dd></div>
        ${game.playtimeMs ? `<div><dt>Tracked playtime</dt><dd>${playDuration(game.playtimeMs)}</dd></div>` : ''}
      </dl>
      <div class="overview-status">${status(game)}</div>
      ${sourceActions}
      <div class="overview-actions">
        ${button('edit-game-details', 'Edit details & notes', 'edit', attrs)}
        <div>${game.threadUrl ? button('edit-alternate-thread', 'Manage forum links', 'globe', attrs) : ''}${actionMenu('More game actions', secondary)}</div>
      </div>
    </aside>
  </div>`;
}
async function showOverviewPhotos(preview, id, attrs) {
  try {
    const photos = await api('game-gallery-preview', id);
    if (!preview.isConnected) return;
    const valid = photos.filter(photo => gameImage({ cover: photo.src }));
    if (!valid.length) return;
    preview.innerHTML = valid.map((photo, index) =>
      `<button type="button" class="gallery-preview" data-action="preview-game-photo" ${attrs} data-photo="${e(photo.id)}" aria-label="View screenshot ${index + 1}" aria-haspopup="dialog">
        <img class="gallery-image" src="${e(photo.src)}" alt="" loading="lazy" decoding="async"></button>`).join('');
    preview.hidden = false;
  } catch {
    // Cached thumbnails are optional. Gallery handles any loading errors.
  }
}
function detailSaves(inventory, attrs) {
  const locations = inventory.locations.map(({ directory, scope }) => `<li><strong>${e(scope)}</strong> · ${e(directory)}</li>`).join('');
  const files = inventory.files.map(save => {
    const file = attrs + ` data-file="${e(save.file)}"`;
    const inspect = save.editor ? button('inspect-save', 'Edit a copy', null, file) : '';
    return `<div class="detail-row"><div><strong>${e(save.name)}</strong><small>${e(save.scope)} · ${time(save.modified)} · ${bytes(save.size)}</small></div>
      <div class="download-actions">${inspect}${button('reveal-save', 'Show file', 'folder', file)}${button('export-save-copy', 'Export copy', 'download', file)}</div></div>`;
  }).join('');
  return `${locations ? `<ul class="save-locations">${locations}</ul>` : ''}${files || '<p>No save files detected for this installation.</p>'}
    ${button('add-save-folder', 'Add a save folder', 'folder', attrs)}`;
}
function detailStorage(game, sizes, attrs) {
  const sizeLabel = item => item?.size == null ? 'Unavailable' : `${item.partial ? 'At least ' : ''}${bytes(item.size)}`;
  const installRow = (install, current) => {
    const version = attrs + ` data-root="${e(install.root)}"`;
    const show = current ? button('reveal-game', 'Show installation', 'folder', attrs) : button('reveal-version', 'Show folder', 'folder', version);
    const rollback = current ? '' : button('rollback-version', 'Roll back', 'refresh', version + ' title="Make this version active and transfer saves"');
    const remove = current ? '' : button('remove-version', 'Delete version', 'trash', version);
    return `<div class="detail-row"><div><strong>${current ? 'Current installation' : 'Previous version'}${install.version ? ' · ' + e(install.version) : ''}</strong>
      <small>${sizeLabel(sizes.versions.find(item => item.root === install.root))} · ${e(install.container || install.root)}</small></div><div class="download-actions">${rollback}${show}${remove}</div></div>`;
  };
  const archives = sizes.archives.map(item => {
    const job = state.downloads.find(job => job.id === item.id);
    return job ? `<div class="detail-row"><div><strong>${e(job.filename)}</strong><small>Download · ${sizeLabel(item)}</small></div></div>` : '';
  }).join('');
  return `<div class="detail-row"><div><strong>Games folder for future installs</strong><small>${e(sizes.gamesRoot || 'Choose a games folder in Settings')}</small></div>
    <div class="download-actions">${button('edit-game-folder','Choose games folder','folder',attrs)}</div></div>` +
    (game.installation ? installRow(game.installation, true) : '<p>No registered installation.</p>') +
    [...game.previous].reverse().map(install => installRow(install, false)).join('') + archives;
}
async function showGallery(panel, id, attrs, mode) {
  const game = currentGame(id);
  if (!game.threadUrl) {
    panel.innerHTML = `<p>Link a forum thread to load its photos.</p>${button('find-forum-game', 'Find forum match', 'search', attrs)}`;
    return;
  }
  const refresh = button('refresh-gallery', 'Refresh photos', 'refresh', attrs);
  panel.querySelector('.gallery-load-error')?.remove();
  if (mode !== 'cached' || !panel.querySelector('.loading-status')) {
    const label = mode === 'more' ? 'Loading more photos…' : mode === 'refresh' ? 'Refreshing thread photos…' : 'Loading thread photos…';
    const controls = panel.querySelector(':scope > .download-actions');
    if (controls) controls.insertAdjacentHTML('beforebegin', loadingStatus(label));
    else panel.insertAdjacentHTML('afterbegin', loadingStatus(label));
  }
  const indicator = panel.querySelector('.loading-status');
  const buttons = panel.querySelectorAll('button:not(:disabled)');
  for (const control of buttons) control.disabled = true;
  try {
    const result = await api('game-gallery', { id, mode });
    if (!panel.isConnected) return;
    const current = currentGame(id);
    if (!current) return;
    const art = gameImage(current);
    const heading = panel.closest('.game-detail').querySelector('.detail-heading');
    const cover = heading.querySelector('img');
    if (art && cover) cover.src = art;
    else if (art) heading.insertAdjacentHTML('afterbegin', `<img src="${e(art)}" alt="">`);
    const photos = result.photos.filter(photo => gameImage({ cover: photo.src }));
    const grid = photos.map((photo, index) => {
      const selected = photo.id === current.coverImageId;
      return `<figure class="gallery-photo"><button type="button" class="gallery-preview" data-gallery-preview="${index}" data-gallery-photo="${e(photo.id)}" aria-label="View photo ${index + 1}" aria-haspopup="dialog">
        <img class="gallery-image" src="${e(photo.src)}" alt="" loading="lazy" decoding="async"></button>
        <figcaption>${selected ? '<span class="badge installed">Current cover</span>' : '<span>Photo ' + (index + 1) + '</span>'}
        ${button('choose-game-cover', selected && current.coverPinned ? 'Selected cover' : 'Use as cover', null,
          attrs + ` data-photo="${e(photo.id)}"` + (selected && current.coverPinned ? ' disabled' : ''))}</figcaption></figure>`;
    }).join('');
    const automatic = current.coverPinned && photos.length ? button('choose-game-cover', 'Use automatic cover', null, attrs) : '';
    const more = result.hasMore ? button('more-gallery', 'Load more photos', 'download', attrs) : '';
    panel.innerHTML = `<p>Photos from the thread’s opening post.</p>
      ${result.failed ? `<p class="helper">${result.failed} photo${result.failed === 1 ? '' : 's'} could not be downloaded.</p>` : ''}
      ${grid ? `<div class="thread-gallery">${grid}</div>` : '<p>No photos loaded yet.</p>'}
      <div class="download-actions">${more}${refresh}${automatic}</div>`;
    const gallery = { photos, hasMore: result.hasMore };
    panel.onclick = event => {
      const preview = event.target.closest('[data-gallery-preview]');
      if (!preview) return;
      const index = Number(preview.dataset.galleryPreview);
      openGalleryViewer($('#gallery-viewer'), gallery, index, {
        loadMore: async () => {
          const next = await showGallery(panel, id, attrs, 'more');
          if (!next) throw new Error('Could not load more photos. Try again.');
          return next;
        },
        restoreFocus: () => panel.querySelector(`[data-gallery-preview="${index}"]`)?.focus()
      });
    };
    return gallery;
  } catch (error) {
    if (!panel.isConnected) return;
    indicator.insertAdjacentHTML('beforebegin', `<p class="gallery-load-error" role="alert">${e(error.message)}</p>`);
    if (!panel.querySelector('[data-action="refresh-gallery"]')) panel.insertAdjacentHTML('beforeend', refresh);
  } finally {
    indicator.remove();
    for (const control of buttons) control.disabled = false;
  }
}

async function gameDetails(id, tab = 'overview') {
  const game = currentGame(id);
  if (!game) throw new Error('This game is no longer in the library.');
  const attrs = `data-id="${e(id)}"`;
  const tabs = [['overview', 'Overview'], ['releases', 'What’s new'], ['gallery', 'Gallery'], ['downloads', 'Downloads'], ['saves', 'Saves'], ['storage', 'Versions & storage']];
  const art = gameImage(game);
  const playable = canLaunchGame(game);
  const ready = state.downloads.find(job => job.gameId === id && canInstallArchive(job));
  const launch = playable ? button('play', 'Play', 'play', attrs, true)
    : ready ? '' : button('register-game', 'Locate installed game', 'folder', attrs);
  const install = ready ? button('install-zip', ready.status === 'awaiting-folder' ? 'Finish installation' : isInstalled(game) ? 'Update game' : 'Install game',
    'download', `data-id="${e(ready.id)}"`, !playable) : '';
  const browserLaunch = playable && /\.html?$/i.test(game.installation.launch)
    ? button('launch-html-browser', 'Play in browser', 'globe', attrs + ' title="Use the browser where older saves may still be stored"') : '';
  const thread = !game.threadUrl ? '' : !ready && isInstalled(game) && hasUpdate(game)
    ? button('get-game-update', 'Get update', 'globe', attrs + ` data-detail-tab="${tab}"`)
    : button('open-game', 'Open thread', 'globe', attrs);
  const refresh = button('refresh-game-details', game.threadUrl ? 'Refresh thread' : 'Refresh details', 'refresh', attrs + ` data-detail-tab="${tab}"`);
  await modal(`<section class="game-detail">
    <div class="detail-heading">${art ? `<img src="${art}" alt="">` : ''}<div class="detail-heading-content"><h2>${e(displayGameTitle(game))}</h2>
    <p>${sourceBadge(game)} ${e(ENGINE_NAMES[game.engine])} · ${e(playStatusLabel(game))}${game.creator ? ' · ' + e(game.creator) : ''}</p>
    <div class="download-actions">${launch}${install}${thread}${refresh}${browserLaunch}${button('toggle-favorite', game.favorite ? '★ Favorited' : '☆ Favorite', null, attrs + ` aria-pressed="${Boolean(game.favorite)}" data-detail-tab="${tab}"`)}</div></div></div>
    <div class="filters detail-tabs" role="group" aria-label="Game details">${tabs.map(([value, label]) => `<button type="button" class="filter" data-action="detail-tab" ${attrs} data-tab-name="${value}" aria-pressed="${tab === value}">${label}</button>`).join('')}</div>
    <div id="game-detail-panel">${tab === 'overview' ? detailOverview(game, attrs) : tab === 'releases' ? releaseTimeline(game, attrs) : tab === 'downloads' ? detailDownloads(game) : loadingStatus(tab === 'gallery' ? 'Loading thread photos…' : tab === 'saves' ? 'Finding save files…' : 'Measuring game storage…')}</div>
    </section>`, null);
  const panel = $('#game-detail-panel');
  if (tab === 'overview' && game.threadUrl) void showOverviewPhotos($('#overview-photos'), id, attrs);
  if (tab === 'gallery') {
    await showGallery(panel, id, attrs, 'cached');
    return;
  }
  if (tab === 'saves' || tab === 'storage') {
    try {
      if (tab === 'saves' && !game.installation) panel.innerHTML = '<p>Locate the installed game to see its saves.</p>';
      else if (tab === 'saves') panel.innerHTML = detailSaves(await api('game-saves', id), attrs);
      else panel.innerHTML = detailStorage(game, await api('game-storage', id), attrs);
    } catch (error) { panel.innerHTML = `<p role="alert">${e(error.message)}</p>`; }
  }
}
function cycleLibraryPrivacy() {
  libraryPrivacy = privacyModes[(privacyModes.indexOf(libraryPrivacy) + 1) % privacyModes.length];
  localStorage.setItem('library-privacy', libraryPrivacy);
  document.body.dataset.libraryPrivacy = libraryPrivacy;
  if (page === 'library') renderLibrary();
}
function editGameFolder(id) {
  const game = currentGame(id);
  const roots = [state.settings.gamesRoot, ...(state.settings.extraGamesRoots || [])].filter(Boolean);
  return modal(`<h2>Games folder</h2><p>This affects future downloads and installs for this game. Existing files stay where they are.</p>
    <label class="field"><span>Install location</span><select name="root">${selectOptions([['', 'Automatic · current installation or default'], ...roots.map(root => [root, root])], game.preferredGamesRoot || '')}</select></label>
    <div class="form-actions"><button class="button primary" type="submit">Save location</button></div>`, async ({ root }) => {
    await api('set-game-folder', { id, root }); await gameDetails(id, 'storage');
  });
}
function editAlternateThread(id) {
  const game = currentGame(id);
  const attrs = `data-id="${e(id)}"`;
  return modal(`<h2>Manage forum links</h2><p>${e(sourceLabel(state.settings,game))} is the primary update source. Enter a thread on the other site. Clear the field to remove the alternate link.</p>
    <label class="field"><span>Alternate thread URL</span><input type="url" name="url" value="${e(game.alternateThread?.threadUrl || '')}"></label>
    <div class="form-actions">${game.alternateThread ? button('promote-alternate-thread','Use alternate for updates',null,attrs) : ''}<button class="button primary" type="submit">Save link</button></div>`, async ({ url }) => {
    await api('set-alternate-thread', { id, url }); await gameDetails(id);
  });
}
async function saveEditor(id, file, details, draft = {}) {
  const back = button('detail-tab', 'Back to saves', null, `data-id="${e(id)}" data-tab-name="saves"`);
  const fields = details.fields || [];
  const slotInfo = details.slot
    ? `<p class="helper">${e(details.slot.label || 'Unnamed save')}${details.slot.version ? ' · Game ' + e(details.slot.version) : ''}${details.slot.engineVersion ? ' · Ren’Py ' + e(details.slot.engineVersion) : ''}</p>`
    : '';
  if (details.slot && !fields.length) {
    return modal(`<h2>Ren’Py save slot</h2>${slotInfo}
      <p class="helper">No editable primitive store variables were found in this save.</p><div class="form-actions">${back}</div>`, null);
  }
  const rows = fields.map(field => {
    const value = draft[field.id] ?? field.value;
    const control = typeof value === 'boolean' ? `<select name="${e(field.id)}">${selectOptions([['true', 'True'], ['false', 'False']], String(value))}</select>`
      : `<input name="${e(field.id)}" type="${typeof value === 'number' ? 'number' : 'text'}" value="${e(value)}" ${field.id === 'gold' ? 'required min="0" max="99999999"' : typeof value === 'number' ? 'required step="any"' : 'maxlength="500"'}>`;
    return `<label class="field" data-save-field="${e(field.label.toLowerCase())}"><span>${e(field.label)}</span>${control}</label>`;
  }).join('');
  return modal(`<h2>Edit a save copy</h2>${slotInfo}<p>Changes are exported as a separate file. The game may need an existing slot to load it.</p>
    <label class="field"><span>Find a field</span><input type="search" id="save-field-search"></label>
    <div class="save-editor-fields">${rows}</div><div class="form-actions">${back}<button class="button primary" type="submit">Review changes</button></div>`, async form => {
    const changes = fields.flatMap(field => {
      const raw = form[field.id];
      const value = typeof field.value === 'boolean' ? raw === 'true' : typeof field.value === 'number' ? Number(raw) : raw;
      return value === field.value ? [] : [{ id: field.id, value, old: field.value, label: field.label }];
    });
    if (!changes.length) { toast('Change at least one value before exporting.', true); return; }
    await modal(`<h2>Review save changes</h2><ul class="save-locations">${changes.map(change => `<li>${e(change.label)} · ${e(change.old)} → ${e(change.value)}</li>`).join('')}</ul>
      <div class="form-actions"><button type="button" id="edit-save-again" class="button">Back to editor</button><button class="button primary" type="submit">Export edited copy</button></div>`, async () => {
      if (await api('export-save', { id, file, revision: details.revision, changes })) { await gameDetails(id, 'saves'); toast('Edited save copy exported.'); }
    });
    $('#edit-save-again').onclick = () => { void saveEditor(id, file, details, Object.fromEntries(changes.map(change => [change.id, change.value]))).catch(error => toast(error.message, true)); };
  });
}

function editGameDetails(id) {
  const game = currentGame(id);
  const installNote=game.installationCheck?`<p class="helper">Install check: ${e(game.installationCheck.message)}${game.installationCheck.metadataWarning?' '+e(game.installationCheck.metadataWarning):''}</p>`:'';
  const coverNote=game.metadataNeedsRefresh?'Refresh details to reload this game’s overview and cover.':game.coverError||'';
  const localeField = runtime.platform === 'win32' ? `<label class="field"><span>Launch locale</span><select name="launchLocale">${selectOptions(LAUNCH_LOCALES, game.launchLocale || 'auto')}</select><small>${(game.installation?.threadJapaneseLocale ?? game.threadJapaneseLocale) ? 'The opening post recommends Japanese locale. Auto uses it for 32-bit Windows games.' : 'Auto follows the opening post. Japanese locale is available for 32-bit Windows games.'}</small></label>` : '';
  return modal(`<h2>${e(game.title)}</h2><p>${sourceBadge(game)} ${e(ENGINE_NAMES[game.engine])} · ${game.threadId?'Thread '+e(game.threadId):'Local game'}${game.creator?' · '+e(game.creator):''}</p>${game.description?`<p class="game-description">${e(game.description)}</p>`:''}${coverNote?`<p class="cover-warning">${e(coverNote)}</p>`:''}${installNote}<div class="download-actions">${button('find-forum-game',game.threadId?'Change forum match':'Find forum match','search',`data-id="${e(id)}"`)}${button('refresh-game-details','Refresh details','refresh',`data-id="${e(id)}"`)}</div><label class="field"><span>Forum thread (optional)</span><input name="threadUrl" type="url" value="${e(game.threadUrl||'')}" placeholder="https://f95zone.to/threads/game.12345/"><small>Search for a match above, or paste a thread URL. Linking fetches forum details and its cover image.</small></label><label class="field"><span>Title</span><input name="title" value="${e(game.title)}" required></label><div class="field-row"><label class="field"><span>Engine</span><select name="engine">${engineOptions(game.engine)}</select></label><label class="field"><span>Current forum version</span><input name="latestVersion" value="${e(game.latestVersion)}" placeholder="Link a forum thread"></label></div><label class="field"><span>Installed version</span><input name="installedVersion" value="${e(versionKnown(game.installedVersion)?game.installedVersion:'')}" placeholder="Unknown — enter the game release if needed"><small>${game.installedVersionSource?'Source: '+e(game.installedVersionSource):'Read from local release metadata when available. The forum version never fills this field.'}</small></label><div class="download-actions">${button('register-game','Locate installed game','folder',`data-id="${e(id)}"`)}${button('attach-archive','Use downloaded archive','file',`data-id="${e(id)}"`)}</div>${game.installation?`<p class="helper">${e(game.installation.launch)}</p>`:''}${localeField}<label class="field"><span>Play status</span><select name="playStatus">${selectOptions(PLAY_STATUSES,game.playStatus||'backlog')}</select></label><label class="field"><span>Personal notes</span><textarea name="notes" rows="4" maxlength="4000">${e(game.notes||'')}</textarea></label><div class="form-actions">${button('game-details','Back',null,`data-id="${e(id)}"`)}<button class="button primary" type="submit">Save details</button></div>`,async data=>{await api('edit-game',{id,...data});await gameDetails(id);toast('Game details saved.');});
}
async function findForumMatch(id) {
  const game=currentGame(id);
  const defaultSource = gameSearchSource(state.settings, game);
  let searchNumber=0;
  async function searchMatches(form, automatic = false) {
    const results=$('#forum-match-results');if(!results)return;
    const requestNumber=++searchNumber;
    results.innerHTML = loadingStatus('Searching forum titles…');
    try {
      const rows=await api('find-forum-game',{id,query:automatic ? '' : form.query,sourceId:form.sourceId});
      if(requestNumber!==searchNumber||!$('#modal').open||$('#forum-match-results')!==results)return;
      if(automatic&&rows[0]?.sourceId&&$('#modal select[name="sourceId"]'))$('#modal select[name="sourceId"]').value=rows[0].sourceId;
      results.innerHTML=rows.length?rows.map(row=>`<article class="forum-match"><div><strong>${e(row.title)}</strong><p>${row.sourceName?`<span class="badge source-badge">${e(row.sourceName)}</span> `:''}${e(row.creator||'Creator unknown')} · ${e(row.latestVersion||'Version unknown')} · Thread ${e(row.threadId)}${row.exact?' · Matching title':''}</p></div><div class="download-actions">${button('link-forum-game','Link this thread','check',`data-id="${e(id)}" data-url="${e(row.threadUrl)}"`,true)}${button('preview-forum-game','View thread','globe',`data-url="${e(row.threadUrl)}"`)}</div></article>`).join(''):`No matching threads found on ${e(configuredSources(state.settings).find(source => source.id === form.sourceId)?.name || 'this source')}. Try a shorter title, switch the website source, or paste the thread URL in game details.`;
    } catch (error) {
      if (requestNumber === searchNumber && $('#modal').open && $('#forum-match-results') === results) {
        results.innerHTML = `<p role="alert">${e(error.message)}</p>`;
      }
    }
  }
  await modal(`<h2>Find a forum match</h2><p>Confirm which thread belongs to ${e(game.title)}. Linking fills its title, creator, current release, description, and available cover while keeping the local installation and version.</p><label class="field"><span>Website source</span><select name="sourceId">${configuredSources(state.settings).map(site=>`<option value="${e(site.id)}" ${site.id===defaultSource.id?'selected':''}>${e(site.name)}</option>`).join('')}</select></label><label class="field"><span>Game title</span><input name="query" required value="${e(game.localMetadata?.title||game.title)}"></label><div class="form-actions"><button type="submit" class="button primary">Search forum</button></div><div id="forum-match-results" class="forum-match-results"></div><div class="form-actions">${button('game-details','Back to game details',null,`data-id="${e(id)}"`)}</div>`,searchMatches);
  $('#modal select[name="sourceId"]')?.addEventListener('change',()=>{void searchMatches(formData());});
  await searchMatches(formData(), true);
}
document.addEventListener('click',event=>{
  const menu = event.target.closest('.action-menu');
  for (const open of document.querySelectorAll('.action-menu[open]')) if (open !== menu) open.open = false;
  const filters = $('#library-extra-filters[open]');
  if (filters && !filters.contains(event.target)) filters.open = false;
  const nav = event.target.closest('[data-nav]'); if(nav){void navigate(nav.dataset.nav);return;}
  const f = event.target.closest('[data-filter]');if(f){filter=f.dataset.filter;renderLibraryResults();return;}
  const source = event.target.closest('[data-source-filter]');
  if (source) {
    sourceFilter = sourceFilter === source.dataset.sourceFilter ? 'all' : source.dataset.sourceFilter;
    renderLibraryResults();
    return;
  }
  const v=event.target.closest('[data-view]');if(v){view=v.dataset.view;localStorage.setItem('view',view);renderLibraryResults();return;}
  const tabClose=event.target.closest('[data-close-tab]');if(tabClose){void api('browser-close-tab',Number(tabClose.dataset.closeTab));return;}
  const tab=event.target.closest('[data-tab]');if(tab){void api('browser-tab',Number(tab.dataset.tab));return;}
  const target=event.target.closest('[data-action]');if(!target)return;
  if (menu) {
    menu.open = false;
    menu.querySelector('summary').focus();
  }
  const {action,id}=target.dataset;
  if (action === 'select-library-games') {
    selectedGames = new Set();
    renderLibrary();
    const selectShown = $('[data-action="select-visible-games"]');
    (selectShown.disabled ? $('[data-action="finish-game-selection"]') : selectShown).focus();
    return;
  }
  if (action === 'finish-game-selection') { finishGameSelection(); return; }
  if (selectedGames && ['clear-game-selection', 'select-visible-games', 'toggle-game-selection'].includes(action)) {
    if (action === 'clear-game-selection') selectedGames.clear();
    else if (action === 'select-visible-games') visibleGameIds.forEach(gameId => selectedGames.add(gameId));
    else if (selectedGames.has(id)) selectedGames.delete(id);
    else selectedGames.add(id);
    renderLibraryResults();
    if (target.disabled) $('[data-action="finish-game-selection"]').focus();
    return;
  }
  void busy(target,async()=>{
    if(['bulk-play-status','bulk-edit-tags','bulk-watch'].includes(action)){await bulkEditGames(action);return;}
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
    if(action==='show-game-download'){
      closeModal();await navigate('downloads');
      [...content.querySelectorAll('[data-download-row]')].find(row=>row.dataset.downloadRow===id)?.focus();
      return;
    }
    if(action==='show-watched-game'){await navigate('library');await gameDetails(id,'releases');return;}
    if(action==='toggle-watch'){
      await api(action,id);if(target.dataset.detailTab)await gameDetails(id,target.dataset.detailTab);return;
    }
    if(action==='open-drive-storage'){await navigate('storage');await refreshDriveStorage();return;}
    if(action==='measure-drive-storage'){await refreshDriveStorage();return;}
    if(action==='cycle-library-privacy'){cycleLibraryPrivacy();$('.library-menu summary').focus();return;}
    if(action==='edit-game-folder'){await editGameFolder(id);return;}
    if(action==='edit-alternate-thread'){await editAlternateThread(id);return;}
    if(action==='open-alternate-thread'){
      const ref=currentGame(id).alternateThread;if(!ref)return;
      closeModal();await navigate('browse');await api('browser-open',{url:ref.threadUrl,gameId:id});return;
    }
    if(action==='promote-alternate-thread'){await api(action,id);await gameDetails(id);return;}
    if(action==='skip-game-update'){await api(action,{id,version:target.dataset.version});await gameDetails(id);return;}
    if(action==='restore-game-update'){await api(action,id);await gameDetails(id);return;}
    if(action==='add-games-root'){await api(action);renderSettings();return;}
    if(action==='remove-games-root'){await api(action,target.dataset.root);renderSettings();return;}
    if(action==='game-details'){await gameDetails(id);return;}
    if(action==='preview-game-photo'){
      const photo = target.dataset.photo;
      await gameDetails(id, 'gallery');
      if ($('#modal').open) $('#game-detail-panel')?.querySelector(`[data-gallery-photo="${CSS.escape(photo)}"]`)?.click();
      return;
    }
    if(action==='refresh-gallery'||action==='more-gallery'){
      await showGallery($('#game-detail-panel'), id, `data-id="${e(id)}"`, action==='more-gallery' ? 'more' : 'refresh');
      return;
    }
    if(action==='choose-game-cover'){
      await api(action, { id, photoId: target.dataset.photo || '' });
      await gameDetails(id, 'gallery'); return;
    }
    if(action==='edit-game-details'){await editGameDetails(id);return;}
    if(action==='detail-tab'){await gameDetails(id,target.dataset.tabName);return;}
    if(action==='toggle-favorite'){await api(action,id);await gameDetails(id,target.dataset.detailTab);return;}
    if(action==='filter-game-tag'){
      closeModal();extraFilters.tag=target.dataset.tag;
      await navigate('library');$('#library-extra-filters').open=true;return;
    }
    if(action==='inspect-save'){const file=target.dataset.file;await saveEditor(id,file,await api(action,{id,file}));return;}
    if(action==='reveal-save'){await api(action,{id,file:target.dataset.file});return;}
    if(action==='export-save-copy'){if(await api('export-save',{id,file:target.dataset.file}))toast('Save copy exported.');return;}
    if(action==='add-save-folder'){await api(action,id);await gameDetails(id,'saves');return;}
    if(action==='reveal-version'||action==='remove-version'){
      const result=await api(action,{id,root:target.dataset.root});
      if(action==='remove-version'&&result){await gameDetails(id,'storage');toast('Previous version removed.');}return;
    }
    if(action==='rollback-version'){
      const result=await api(action,{id,root:target.dataset.root});
      await gameDetails(id,'storage');
      toast(`Rolled back to ${result.version}${result.copiedSaves?` (${result.copiedSaves} save files transferred)`:''}.`);
      return;
    }
    if(action==='copy-password'){
      await api('copy-password', target.dataset.password);
      toast('Archive password copied to clipboard.');
      return;
    }
    if(action==='export-library'){
      const result = await api('export-library');
      if (result?.exported) toast(`Exported ${result.count} library games.`);
      return;
    }
    if(action==='import-library'){
      const result = await api('import-library');
      if (result?.imported) {
        if (page === 'library') renderLibrary();
        toast(`Imported library file (${result.added} added, ${result.updated} updated).`);
      }
      return;
    }
    if(action==='save-library-preset'){
      const filters=structuredClone({filter,sourceFilter,librarySort,search,extraFilters});
      await modal('<h2>Save this library view</h2><label class="field"><span>View name</span><input name="name" required maxlength="60"></label><div class="form-actions"><button class="button primary" type="submit">Save view</button></div>',async data=>{
        const name=data.name.trim();if(!name)throw new Error('Enter a name for this view.');
        if(libraryPresets.some(preset=>preset.name.toLowerCase()===name.toLowerCase()))throw new Error('A saved view already uses that name.');
        const id=crypto.randomUUID();libraryPresets.push({id,name,filters});
        localStorage.setItem('library-presets',JSON.stringify(libraryPresets));
        renderLibraryPresets();$('#library-preset').value=id;$('[data-action="remove-library-preset"]').disabled=false;
        closeModal();toast('Library view saved.');
      });return;
    }
    if(action==='remove-library-preset'){
      const id=$('#library-preset').value;
      libraryPresets=libraryPresets.filter(preset=>preset.id!==id);
      localStorage.setItem('library-presets',JSON.stringify(libraryPresets));
      renderLibraryPresets();toast('Saved view removed.');return;
    }
    if(action==='find-forum-game'){await findForumMatch(id);return;}
    if(action==='link-forum-game'){const result=await api(action,{id,threadUrl:target.dataset.url});await gameDetails(id);toast(result.coverError||'Forum thread linked. Local files and installed version preserved.',Boolean(result.coverError));return;}
    if(action==='preview-forum-game'){const url=target.dataset.url;closeModal();await navigate('browse');await api('browser-open',{url,newTab:true});return;}
    if(action==='refresh-game-details'){
      const result = await api(action, id);
      if (target.isConnected && $('#modal').open) await gameDetails(id, target.dataset.detailTab);
      toast(result.coverError || (result.linked ? 'Local and forum details refreshed.' : 'Local details refreshed. Use Find forum match to link the website thread.'), Boolean(result.coverError));
      return;
    }
    if(action==='refresh-library-details'){const result=await api(action);toast(result.errors.length?`${result.refreshed} games refreshed. ${result.errors[0]}`:`${result.refreshed} games refreshed${result.unmatched?`; ${result.unmatched} need a forum match`:''}${result.coverWarnings?`; ${result.coverWarnings} covers need attention in game details`:''}.`,Boolean(result.errors.length||result.coverWarnings));return;}
    if(action==='clear-completed-downloads'){const count=await api(action);toast(`${count} completed records removed. Files stay on disk.`);return;}
    if(action==='clear-download'){await api(action,id);toast('Removed from list. Files stay on disk.');return;}
    if(action==='reset-filter'){
      filter='all';sourceFilter='all';search='';extraFilters={...emptyExtraFilters};
      renderLibraryPresets();
      $('#library-source').value=sourceFilter;$('#game-search').value=search;
      renderLibraryResults();$('[data-filter="all"]').focus();return;
    }
    if(action==='open-source'){await navigate('browse');await api('browser-open-source',target.dataset.source);return;}
    if(action==='check-source'){const result=await api('check-source-status',target.dataset.source);toast(result.message,result.status==='error'||result.feedStatus==='error');return;}
    if(action==='logout-source'){await api('browser-logout',target.dataset.source);toast('This source’s login cleared.');return;}
    if(action==='browser-home'){const site=browserSource();await navigate('browse');await api('browser-open',{url:site.origin});return;}
    if(action==='browser-new-tab'){await api('browser-open',{url:browserSource().origin,newTab:true});return;}
    if(action==='open-game'){const game=currentGame(id);if(!game.threadUrl){await gameDetails(id);return;}closeModal();await navigate('browse');await api('browser-open',{url:game.threadUrl,gameId:id});return;}
    if(action==='get-game-update'){await showDownloadOptions(id,target.dataset.detailTab);return;}
    if(action==='open-download-option'){closeModal();await navigate('browse');await api('browser-open-download-option',{token:target.dataset.token,index:Number(target.dataset.index)});return;}
    if(action==='add-current'){await api('add-current-thread');toast('Thread added to your library.');return;}
    if(action.startsWith('browser-')){await api('browser-command',action.replace('browser-',''));return;}
    if(action==='check-updates'||action==='check-all-updates'){const result=await api(action);if(result?.error)toast(result.error,true);else if(!result?.busy)toast(result.message);return;}
    if(action==='logout'){await api('browser-logout',browserSource().id);toast('This source’s login cleared.');return;}
    if(action==='play'){await api('launch-game',id);return;}
    if(action==='register-game'){
      await api('register-game',{id});
      if($('#modal .game-detail'))await gameDetails(id);
      toast('Installation registered if a launch target was selected.');return;
    }
    if(action==='attach-archive'){await api(action,id);if($('#modal .game-detail'))await gameDetails(id,'downloads');return;}
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
document.addEventListener('dragover', event => {
  if (page !== 'library' || !event.dataTransfer?.types.includes('Files')) return;
  const card = event.target.closest('[data-library-game]');
  if (!card) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  card.classList.add('archive-drop-target');
});
document.addEventListener('dragleave', event => {
  const card = event.target.closest?.('[data-library-game]');
  if (card && !card.contains(event.relatedTarget)) card.classList.remove('archive-drop-target');
});
document.addEventListener('drop', event => {
  if (page !== 'library' || !event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  const card = event.target.closest('[data-library-game]');
  content.querySelectorAll('.archive-drop-target').forEach(node => node.classList.remove('archive-drop-target'));
  if (!card) return;
  if (event.dataTransfer.files.length !== 1) { toast('Drop one full-release archive onto its game.', true); return; }
  const file = window.library.droppedPath(event.dataTransfer.files[0]);
  const id = card.dataset.libraryGame;
  if (!file) { toast('AfterShelf could not read that file path.', true); return; }
  void api('attach-dropped-archive', { id, file }).then(() => {
    if (page === 'library') void gameDetails(id, 'downloads').catch(error => toast(error.message, true));
    toast('Archive attached. Review it before installing.');
  }).catch(error => toast(error.message, true));
});
document.addEventListener('input',event=>{
  if(event.target.id==='download-game-choice') { const creating=event.target.value==='__new__';$('#download-new-game').hidden=!creating;$('#download-new-title').required=creating;return; }
  if(event.target.dataset.candidate&&setup){if(event.target.checked)setup.selected.add(event.target.dataset.candidate);else setup.selected.delete(event.target.dataset.candidate);const status=$('#setup-scan-status');if(status)status.textContent=`${setup.candidates.length} items found · ${setup.selected.size} selected`;if(setup.importOnly)$('#modal-form [type=submit]').textContent=setup.selected.size?'Add selected games':'Done';return;}
  if(event.target.id==='game-search'){search=event.target.value;renderLibraryResults();}
  if(event.target.id==='save-field-search'){
    const query=event.target.value.trim().toLowerCase();
    for(const field of document.querySelectorAll('[data-save-field]'))field.hidden=!field.dataset.saveField.includes(query);
  }
});
document.addEventListener('change',event=>{
  if(selectedGames && event.target.dataset.selectGame){
    const id=event.target.dataset.selectGame;
    if(event.target.checked)selectedGames.add(id);else selectedGames.delete(id);
    renderLibraryResults();return;
  }
  if(event.target.id==='library-source'){sourceFilter=event.target.value;renderLibraryResults();}
  if(event.target.id==='library-sort'){librarySort=event.target.value;localStorage.setItem('library-sort',librarySort);renderLibraryResults();}
  if(event.target.dataset.extraFilter){
    extraFilters[event.target.dataset.extraFilter]=event.target.type==='checkbox'?event.target.checked:event.target.value;
    renderLibraryResults();
  }
  if(event.target.id==='library-preset'){
    const preset=libraryPresets.find(view=>view.id===event.target.value);
    $('[data-action="remove-library-preset"]').disabled=!preset;
    if(preset)applyLibraryPreset(preset);
  }
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
  if (event.key === 'Escape' && !$('#gallery-viewer').open) {
    const scope = $('#modal').open ? $('#modal') : document;
    const menu = scope.querySelector('.action-menu[open], #library-extra-filters[open]');
    if (menu) {
      menu.open = false;
      menu.querySelector('summary').focus();
      event.preventDefault();
      return;
    }
    if (page === 'library' && selectedGames && !$('#modal').open) {
      finishGameSelection();
      event.preventDefault();
      return;
    }
  }
  if(page==='library'&&event.shiftKey&&(event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='p'){
    event.preventDefault();
    if ($('#gallery-viewer').open) $('#gallery-viewer').close();
    cycleLibraryPrivacy();
    const detail=$('#modal .game-detail');
    if(detail) {
      const active=detail.querySelector('[data-tab-name][aria-pressed="true"]');
      void gameDetails(active.dataset.id,active.dataset.tabName).catch(error=>toast(error.message,true));
    }
    return;
  }
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
  if(page==='browse'||page==='settings'&&document.activeElement?.closest('form')){renderScanStatus();return;}
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

window.library.onShowGame(id => {
  if (!currentGame(id)) return;
  closeModal();
  void navigate('library').then(() => gameDetails(id, 'releases')).catch(error => toast(error.message, true));
});

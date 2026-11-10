export const ENGINES = [
  ['renpy', "Ren’Py"], ['rpgmv', 'RPG Maker MV'], ['rpgmz', 'RPG Maker MZ'],
  ['rpgxp', 'RPG Maker XP'], ['rpgvx', 'RPG Maker VX'], ['rpgvxa', 'RPG Maker VX Ace'],
  ['rpg2k', 'RPG Maker 2000 / 2003'], ['unity', 'Unity'], ['naninovel', 'Naninovel'],
  ['godot', 'Godot'], ['gamemaker', 'GameMaker'], ['unreal', 'Unreal Engine'],
  ['sugarcube', 'Twine / SugarCube'], ['harlowe', 'Twine / Harlowe'], ['html', 'HTML'],
  ['tyrano', 'TyranoScript / Builder'], ['wolf', 'WOLF RPG Editor'], ['kirikiri', 'KiriKiri'],
  ['custom', 'Other / custom']
];
export const ENGINE_NAMES = Object.fromEntries(ENGINES);
export const DEFAULT_SITE = {
  id: 'f95', shortName: 'F95', feedFormat: 'json',
  origin: 'https://f95zone.to',
  name: 'F95zone',
  latestPath: '/sam/latest_alpha/latest_data.php?cmd=list&cat=games&page={page}&sort=date&rows=90',
  loginPath: '/login/',
  blockedHosts: ['doubleclick.net', 'googlesyndication.com', 'popads.net', 'popcash.net', 'exoclick.com']
};
export const DEFAULT_LC_SITE = {
  ...DEFAULT_SITE, id: 'lc', shortName: 'LC', name: 'LewdCorner', origin: 'https://lewdcorner.com',
  latestPath: '/latest-updates?page={page}&per_page=60&cat=Games&search_scope=title&ignored_mode=hide&only_new_days=7', feedFormat: 'html'
};
export function initialState() {
  return {
    schema: 1,
    settings: { site: structuredClone(DEFAULT_SITE), sources: { f95: structuredClone(DEFAULT_SITE), lc: structuredClone(DEFAULT_LC_SITE) }, gamesRoot: '', extractor: '', retention: 'keep', theme: 'dark', intervalMinutes: 15, setupCompleted: false, downloadMode: 'download-only' },
    games: [], downloads: [], history: [], checkpoints: {}, ignoredGameRoots: [],
    scan: { active: false, message: 'Not checked yet', lastChecked: null, error: '' },
    sourceStatus: {}, sourceScans: {},
    detailScan: { active: false, message: '' },
    libraryScan: { active: false, message: '', candidates: [], warnings: [] }
  };
}
export function gameKey(origin, threadId) { return `${new URL(origin).origin}:${threadId}`; }
export function detectEngine(text = '') {
  const value = String(text).toLowerCase().replace(/[’']/g, '');
  const patterns = [
    ['naninovel', /naninovel/], ['renpy', /ren\s*py/], ['rpgvxa', /(?:rpg\s*maker\s*)?vx\s*ace|rpgvxa/],
    ['rpgmv', /rpg\s*maker\s*mv|\brpgmv\b/], ['rpgmz', /rpg\s*maker\s*mz|\brpgmz\b/],
    ['rpgxp', /rpg\s*maker\s*xp|\brpgxp\b/], ['rpgvx', /rpg\s*maker\s*vx|\brpgvx\b/],
    ['rpg2k', /rpg\s*maker\s*(?:2000|2003)|rpg2k/], ['unity', /\bunity\b/],
    ['godot', /\bgodot\b/], ['gamemaker', /game\s*maker(?!\s*(?:mv|mz|vx|xp))/],
    ['unreal', /unreal|\bue[45]\b/], ['sugarcube', /sugarcube/], ['harlowe', /harlowe/],
    ['tyrano', /tyrano/], ['wolf', /wolf\s*(?:rpg|editor)|\bwolf\b/], ['kirikiri', /kiri\s*kiri/],
    ['html', /\bhtml(?:5)?\b|\btwine\b/]
  ];
  return patterns.find(([, pattern]) => pattern.test(value))?.[0] || 'custom';
}
export function normalizedTitle(value = '') {
  return value.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLocaleLowerCase();
}
export function newGame(meta) {
  return { id: gameKey(meta.origin, meta.threadId), addedAt: Date.now(), latestVersion: '', installedVersion: '', engine: 'custom',
    installation: null, previous: [], saveOverrides: [], retention: 'default', ...meta };
}
export const PLAY_STATUSES = [['backlog', 'Backlog'], ['playing', 'Playing'], ['finished', 'Finished']];
export const LAUNCH_LOCALES = [['auto', 'Auto (from forum)'], ['default', 'System default'], ['ja-JP', 'Japanese (Japan)']];
export function normalizeVersion(value) { return String(value ?? '').trim().replace(/^v(?=\d)/i, ''); }
export function versionKnown(value) { return typeof value === 'string' && Boolean(value.trim()) && !/^(?:unknown|unspecified|n\/?a)$/i.test(value.trim()); }
export function versionRelation(installed, current) {
  if (!versionKnown(installed) || !versionKnown(current)) return 'unknown';
  const local = normalizeVersion(installed).toLowerCase(), remote = normalizeVersion(current).toLowerCase();
  if (local === remote) return 'same';
  const numeric = value => {
    if (/^0\d+$/.test(value)) return null; // Packed developer labels such as 01551.
    const match = /^(\d+(?:\.\d+)*)([a-z][\w.-]*|-[\w.-]+)?$/.exec(value);
    return match ? { parts: match[1].split('.').map(BigInt), suffix: match[2] || '' } : null;
  };
  const a = numeric(local), b = numeric(remote);
  if (!a || !b) return 'different';
  for (let i=0; i<Math.max(a.parts.length,b.parts.length); i++) {
    const left=a.parts[i]||0n, right=b.parts[i]||0n;
    if (left !== right) return right > left ? 'newer' : 'older';
  }
  return a.suffix === b.suffix ? 'same' : 'different';
}
export function updateSkipped(game) {
  const skipped = game.skippedUpdate;
  return Boolean(skipped && skipped.origin === game.origin && String(skipped.threadId) === String(game.threadId) &&
    versionRelation(skipped.version, game.latestVersion) === 'same');
}
export function hasUpdate(game) {
  return !updateSkipped(game) && ['newer', 'different'].includes(versionRelation(game.installedVersion, game.latestVersion));
}
export function canInstallArchive(job) { return Boolean(job && ['downloaded', 'awaiting-folder'].includes(job.status) && !job.archiveRemoved && typeof job.path === 'string' && job.path); }
export function offerInstallation(settings, job) { return settings.setupCompleted && settings.downloadMode === 'assisted' && canInstallArchive(job) && Boolean(job.gameId); }
export const ACTIVE_DOWNLOADS = ['queued', 'downloading', 'retrying'];
export function isInstalled(game) { return Boolean(game.installation && game.availability?.status !== 'missing'); }
export function canLaunchGame(game) { return isInstalled(game) && Boolean(game.installation.launch) && !['offline', 'unreadable'].includes(game.availability?.status); }

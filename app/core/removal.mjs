import fs from 'node:fs/promises';
import path from 'node:path';
import { isInside, assertNoLinks } from './files.mjs';

async function canonical(value) {
  try { return await fs.realpath(value); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return path.resolve(value); throw error; }
}

export function removalRoots(game) {
  return [...new Set([game.installation, ...(game.previous || [])].filter(Boolean).flatMap(install => [install.root, install.managed ? install.container : null]).filter(Boolean).map(value => path.resolve(value)))];
}

export async function planGameDeletion(game, games, { collectionRoot = '', protectedRoots = [], protectedTrees = [], signal } = {}) {
  const systemRoots = process.platform === 'darwin' ? ['/Applications', '/System', '/Library', '/Users', '/Volumes', '/private', '/usr', '/bin', '/sbin', '/etc', '/var', '/tmp'] : [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData];
  const roots = await Promise.all([...protectedRoots, ...systemRoots].filter(Boolean).map(canonical));
  const trees = await Promise.all(protectedTrees.filter(Boolean).map(canonical));
  const others = await Promise.all(games.filter(item => item.id !== game.id).flatMap(removalRoots).map(canonical));
  const targets = [];
  for (const install of [game.installation, ...(game.previous || [])].filter(Boolean)) {
    signal?.throwIfAborted();
    const input = install.managed && install.container ? install.container : install.root;
    if (!input || !path.isAbsolute(input)) throw new Error('Locate this game’s own installation folder before deleting its files.');
    const target = await canonical(input);
    if (collectionRoot && isInside(await canonical(collectionRoot), target, true)) {
      try { await fs.access(collectionRoot); }
      catch { throw new Error('The games folder is unavailable. Reconnect it to delete files, or choose Keep files.'); }
    }
    const volume = process.platform === 'darwin' && target.startsWith('/Volumes/') ? path.join('/Volumes', target.split('/')[2]) : path.parse(target).root;
    if (target === volume) throw new Error('Choose the game’s own folder rather than an entire drive.');
    try { await fs.access(volume); }
    catch { throw new Error('The game drive is unavailable. Reconnect it to delete files, or choose Keep files.'); }
    if (target === path.parse(target).root || roots.some(root => isInside(target, root, true)) || trees.some(root => isInside(target, root, true) || isInside(root, target, true))) throw new Error('This folder contains protected application, library or personal data. Locate the game’s own folder before deleting it.');
    if (others.some(root => isInside(target, root, true) || isInside(root, target, true))) throw new Error('This folder overlaps another registered game. Resolve its installation folders before deleting files.');
    if (install.managed && install.root && !isInside(target, await canonical(install.root), true)) throw new Error('The registered game folder is outside its version container. Locate its correct folder before deleting files.');
    // Refuse changed/symlinked ancestors, rather than following a newly placed link.
    await assertNoLinks(path.parse(path.resolve(input)).root, path.resolve(input));
    try {
      if (!(await fs.lstat(target)).isDirectory()) throw new Error('The registered installation is not a game directory.');
    } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue; throw error; }
    targets.push(target);
  }
  const unique = [...new Set(targets)];
  return { targets: unique.filter(target => !unique.some(parent => parent !== target && isInside(parent, target))), ignoredRoots: removalRoots(game) };
}

export async function deleteGameFiles(plan, { signal } = {}) {
  for (const target of plan.targets) {
    signal?.throwIfAborted();
    await assertNoLinks(path.parse(target).root, target);
    if (await canonical(target) !== target) throw new Error('A game folder changed while deletion was starting. Scan the library again.');
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

export function forgetGame(state, id, { deleteFiles = false, ignoredRoots = [] } = {}) {
  state.ignoredGameRoots = [...new Set([...(state.ignoredGameRoots || []), ...ignoredRoots])];
  state.games = state.games.filter(game => game.id !== id);
  for (const job of state.downloads) if (job.gameId === id) {
    job.gameId = null;
    if (deleteFiles && job.status === 'installed') {
      job.status = job.archiveRemoved ? 'removed' : 'downloaded';
      job.extractedPath = ''; job.stagingPath = '';
      job.phase = job.archiveRemoved ? 'Game files deleted and library entry removed.' : 'Game files deleted; the retained archive can be assigned and installed again.';
    }
  }
}

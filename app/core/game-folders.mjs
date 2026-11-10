import { isInside } from './files.mjs';

export function gamesFolders(settings) {
  return [...new Set([settings.gamesRoot, ...(settings.extraGamesRoots || [])].filter(Boolean))];
}

export function containingGamesFolder(settings, file) {
  if (!file) return '';
  return gamesFolders(settings).filter(root => isInside(root, file, true)).sort((a, b) => b.length - a.length)[0] || '';
}

export function gamesFolderFor(settings, game) {
  return game?.preferredGamesRoot || game?.installation?.gamesRoot ||
    containingGamesFolder(settings, game?.installation?.container || game?.installation?.root) || settings.gamesRoot;
}

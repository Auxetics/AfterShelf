import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { walk, readSmall, exists, isInside, assertNoLinks, copyVerified } from './files.mjs';
import { detectEngine } from './model.mjs';

const LOCAL_DIRS = {
  renpy: ['game/saves'], rpgmv: ['www/save', 'save'], rpgmz: ['www/save', 'save'],
  rpgxp: ['Save', 'save'], rpgvx: ['Save', 'save'], rpgvxa: ['Save', 'save'], rpg2k: [],
  unreal: ['Saved/SaveGames', 'Saved/Config'], wolf: ['Save'], kirikiri: ['savedata'], tyrano: [],
  unity: [], naninovel: [], godot: [], gamemaker: [], html: [], sugarcube: [], harlowe: [], custom: []
};
const ROOT_FILES = {
  rpgxp: /^Save\d+\.rxdata$/i, rpgvx: /^Save\d+\.rvdata$/i, rpgvxa: /^Save\d+\.rvdata2$/i,
  rpg2k: /^Save\d+\.lsd$/i, tyrano: /_tyrano_[\w.-]+\.sav$/i,
  wolf: /^SaveData\d+\.sav$/i, kirikiri: /^(?:datasc|data\d+)\.ksd$/i
};
export async function inspectInstallation(root, expectedEngine = 'custom') {
  const files = await walk(root, { depth: 4, max: 50000 });
  const names = files.map(file => file.relative);
  let engine = expectedEngine;
  if (engine === 'custom') {
    if (names.some(name => /(?:^|\/)renpy\//i.test(name))) engine = 'renpy';
    else if (names.some(name => /rmmz_core\.js$/i.test(name))) engine = 'rpgmz';
    else if (names.some(name => /rpg_core\.js$/i.test(name))) engine = 'rpgmv';
    else if (names.some(name => /UnityPlayer\.(dll|dylib)$|globalgamemanagers$/i.test(name))) engine = 'unity';
    else if (names.some(name => /project\.godot$|\.pck$/i.test(name))) engine = 'godot';
    else if (names.some(name => /data\.win$/i.test(name))) engine = 'gamemaker';
    else if (names.some(name => /Config\.tjs$/i.test(name))) engine = 'tyrano';
    else if (names.some(name => /Game\.rvproj2$|RGSS3.*\.dll$/i.test(name))) engine = 'rpgvxa';
    else if (names.some(name => /RGSS2.*\.dll$/i.test(name))) engine = 'rpgvx';
    else if (names.some(name => /RGSS1.*\.dll$/i.test(name))) engine = 'rpgxp';
    else if (names.some(name => /RPG_RT\.exe$/i.test(name))) engine = 'rpg2k';
    else if (names.some(name => /\.xp3$/i.test(name))) engine = 'kirikiri';
    else if (names.some(name => /Data\.wolf$/i.test(name))) engine = 'wolf';
    else if (names.some(name => /\.pak$/i.test(name))) engine = 'unreal';
    else if (names.some(name => /\.html?$/i.test(name))) engine = 'html';
  }
  const roots = [root];
  const wrappers = files.filter(file => file.directory && /(?:^|\/)(?:www|Resources|app)$/.test(file.relative)).slice(0, 10);
  if (engine === 'renpy') {
    for (const file of files.filter(file => file.directory && /(?:^|\/)game$/.test(file.relative))) roots.push(path.dirname(file.absolute));
  }
  if (engine === 'rpgmv' || engine === 'rpgmz') {
    // Packaged desktop games may put their content inside a macOS .app or
    // another wrapper. Use the edition's core script to locate that content.
    const core = engine === 'rpgmv' ? 'rpg_core.js' : 'rmmz_core.js';
    for (const file of files.filter(file => !file.directory && path.basename(file.absolute).toLowerCase() === core && path.basename(path.dirname(file.absolute)).toLowerCase() === 'js')) {
      roots.push(path.dirname(path.dirname(file.absolute)));
    }
  }
  const local = new Map();
  for (const base of new Set(roots)) {
    for (const relative of LOCAL_DIRS[engine] || []) {
      const candidate = path.join(base, relative);
      await assertNoLinks(root, candidate);
      if (await exists(candidate)) {
        if (!(await fs.stat(candidate)).isDirectory()) throw new Error(`Expected a save folder at ${relative}.`);
        const contents = await walk(candidate, { max: 20000 });
        for (const item of contents.filter(item => !item.directory)) local.set(item.absolute, { source: item.absolute, relative: path.relative(root, item.absolute), kind: relative.includes('Config') || /^config\.(?:rpgsave|rmmzsave)$/i.test(path.basename(item.absolute)) ? 'preferences' : 'save' });
      }
    }
  }
  const pattern = ROOT_FILES[engine];
  if (pattern) for (const item of files.filter(item => !item.directory && !item.relative.includes('/') && pattern.test(item.relative))) {
    local.set(item.absolute, { source: item.absolute, relative: item.relative, kind: 'save' });
  }
  let identity = '', company = '', product = '';
  const configFiles = files.filter(file => !file.directory && /(?:options\.rpy|Config\.tjs|project\.godot|app\.info)$/i.test(file.relative));
  for (const file of configFiles) {
    const text = await readSmall(file.absolute);
    if (engine === 'renpy') identity ||= /config\.save_directory\s*=\s*["']([^"']+)["']/.exec(text)?.[1] || '';
    if (engine === 'tyrano') identity ||= /projectID\s*=\s*["']?([^\s;"']+)/i.exec(text)?.[1] || '';
    if (engine === 'godot') identity ||= /config\/custom_user_dir_name\s*=\s*"([^"]+)"/.exec(text)?.[1] || /config\/name\s*=\s*"([^"]+)"/.exec(text)?.[1] || '';
    if (/(?:unity|naninovel)/.test(engine) && /app\.info$/i.test(file.relative)) [company, product] = text.trim().split(/\r?\n/);
  }
  const launchers = files.filter(file => !file.directory && /\.(exe|html?|sh)$/i.test(file.relative) && !/crash|unins|unitycrash|notification|lib\/|renpy\/|node_modules\//i.test(file.relative))
    .sort((a,b) => a.relative.split('/').length - b.relative.split('/').length).map(file => file.absolute);
  const apps = files.filter(file => file.directory && /\.app$/i.test(file.relative)).map(file => file.absolute);
  if (/\.app$/i.test(root)) apps.unshift(root);
  // Inventory all launch targets; detectLauncher applies the requested platform.
  return { engine, identity, company, product, local: [...local.values()], launchers: [...apps, ...launchers], wrappers: wrappers.map(item => item.relative) };
}
export function externalCandidates(engine, metadata, { home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const { identity, company, product } = metadata;
  // Values originate from untrusted game metadata; constrain them before resolving paths.
  const simple = value => value && value !== '.' && !/[\\/]|\.\./.test(value) && !path.isAbsolute(value);
  const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  if (engine === 'renpy' && simple(identity)) return [path.join(platform === 'win32' ? path.join(roaming, 'RenPy') : platform === 'darwin' ? path.join(home, 'Library', 'RenPy') : path.join(home, '.renpy'), identity)];
  if (['unity', 'naninovel'].includes(engine) && simple(company) && simple(product)) return platform === 'win32'
    ? [path.join(home, 'AppData', 'LocalLow', company, product)]
    : platform === 'darwin' ? [path.join(home, 'Library', 'Application Support', `unity.${company}.${product}`), path.join(home, 'Library', 'Application Support', company, product)]
    : [path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'unity3d', company, product)];
  if (engine === 'godot' && simple(identity)) return [path.join(platform === 'win32' ? path.join(roaming, 'Godot', 'app_userdata') : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Godot', 'app_userdata') : path.join(home, '.local', 'share', 'godot', 'app_userdata'), identity)];
  if (engine === 'gamemaker' && simple(identity)) return [path.join(platform === 'win32' ? local : platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.config'), identity)];
  return [];
}
export async function savePlan(root, engine, overrides = []) {
  const info = await inspectInstallation(root, engine);
  for (const item of overrides) {
    if (!isInside(root, item)) continue; // External overrides are left in place.
    await assertNoLinks(root, item);
    const stat = await fs.lstat(item);
    const files = stat.isDirectory() ? (await walk(item)).filter(file => !file.directory).map(file => file.absolute) : [item];
    for (const file of files) if (!info.local.some(entry => entry.source === file)) info.local.push({ source: file, relative: path.relative(root, file), kind: 'user-specified' });
  }
  const predicted = externalCandidates(info.engine, info);
  const external = [];
  for (const candidate of [...predicted, ...overrides.filter(item => !isInside(root, item))]) if (await exists(candidate)) external.push(candidate);
  return { ...info, external, predicted, ruleVersion: 'alpha-1', status: info.local.length ? (external.length ? 'mixed' : 'local') : external.length ? 'external' : info.engine !== 'custom' ? 'expected-external/no-local-data' : 'unresolved' };
}
export async function transferSaves(plan, oldRoot, newRoot, signal) {
  if (isInside(oldRoot, newRoot, true) || isInside(newRoot, oldRoot, true)) throw new Error('Extract the new release into a separate folder, outside the old installation.');
  for (const item of plan.local) {
    signal?.throwIfAborted();
    const target = path.resolve(newRoot, item.relative);
    if (!isInside(newRoot, target)) throw new Error('A save destination escapes the new installation.');
    await assertNoLinks(oldRoot, item.source); await assertNoLinks(newRoot, target);
    await copyVerified(item.source, target, signal);
  }
  return plan.local.length;
}

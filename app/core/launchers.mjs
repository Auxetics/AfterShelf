import path from 'node:path';
import { exists, isInside } from './files.mjs';

const helper = /(?:^|[\/_. -])(?:unins\w*|setup|installer|crash\w*|notification\w*|redist|dxsetup|vcredist)(?:[\/_. -]|$)/i;
const support = /(?:^|\/)(?:Contents|lib|libs|renpy|node_modules|docs?|documentation|manual|redist|__MACOSX)(?:\/|$)/i;
const key = value => path.basename(value).replace(/\.(?:app|exe|html?|sh)$/i, '').replace(/(?:[-_ ](?:x86_64|x64|amd64|arm64|aarch64|x86|32|64|console))$/i, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
const depth = (root, file) => path.relative(root, file).split(path.sep).length;

// Choose using platform/engine layout and identity, never directory ordering.
// An unresolved tie is an actual detection error, not a routine confirmation.
export async function detectLauncher(root, info, { title = '', platform = process.platform, arch = process.arch } = {}) {
  let candidates = [...new Set(info.launchers)].filter(file => isInside(root, file, true) && !helper.test(path.basename(file)));
  if (platform === 'darwin') {
    let apps = candidates.filter(file => /\.app$/i.test(file));
    apps = apps.filter(file => !apps.some(other => other !== file && isInside(other, file)));
    candidates = apps.length ? apps : candidates.filter(file => /\.(?:sh|html?)$/i.test(file) && !support.test(path.relative(root, file).split(path.sep).join('/')));
  } else {
    candidates = candidates.filter(file => /\.(?:exe|html?)$/i.test(file) && !support.test(path.relative(root, file).split(path.sep).join('/')));
    if (platform === 'win32' && candidates.some(file => /\.exe$/i.test(file))) candidates = candidates.filter(file => /\.exe$/i.test(file));
  }
  if (!candidates.length) return { launch: '', root, reason: 'No compatible game launcher was found in the extracted release.' };
  if (candidates.length > 1 && !/^(?:html|sugarcube|harlowe)$/.test(info.engine) && candidates.some(file => /\.sh$/i.test(file))) candidates = candidates.filter(file => /\.sh$/i.test(file));
  const scored = await Promise.all(candidates.map(async file => {
    const relative = path.relative(root, file).split(path.sep).join('/'), base = path.basename(file), directory = path.dirname(file);
    let score = -depth(root, file) * 5;
    if (key(file) && [key(title), key(root)].includes(key(file))) score += 40;
    if (/^index\.html?$/i.test(base)) score += 30;
    if (/console/i.test(base)) score -= 30;
    if (/\.exe$/i.test(file)) {
      if (info.engine === 'renpy' && await exists(path.join(directory, 'game')) && await exists(path.join(directory, 'renpy'))) score += 100;
      if (/^rpg/.test(info.engine) && /^Game\.exe$/i.test(base)) score += 60;
      if (['unity', 'naninovel'].includes(info.engine) && await exists(path.join(directory, path.basename(file, path.extname(file)) + '_Data'))) score += 100;
    }
    const architecture = /(?:^|[-_ .])(arm64|aarch64|x86_64|amd64|x64|x86|32|64)(?=[-_. ]|$)/i.exec(base)?.[1]?.toLowerCase();
    if (architecture) {
      const target = /arm|aarch/.test(architecture) ? 'arm64' : /64/.test(architecture) ? 'x64' : 'ia32';
      score += target === arch ? 20 : arch === 'arm64' && target === 'x64' ? 5 : -20;
    }
    return { file, score };
  }));
  scored.sort((a, b) => b.score - a.score);
  if (scored.length > 1 && scored[0].score === scored[1].score) return { launch: '', root, reason: 'More than one equally likely game launcher was found. Use Select extracted folder to choose this release’s launcher.' };
  const launch = scored[0].file;
  // Read bundle metadata and map saves relative to the actual application,
  // even when its archive also contains readmes or other wrapper files.
  return { launch, root: /\.app$/i.test(launch) ? launch : root, reason: '' };
}

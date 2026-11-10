import fs from 'node:fs/promises';
import path from 'node:path';
import { assertNoLinks, isInside } from './files.mjs';

export function installationFolder(install) {
  return install.managed && install.container ? install.container : install.root;
}

export async function measureStorage(target, directory = false) {
  try {
    await assertNoLinks(path.parse(target).root, target);
    const root = await fs.lstat(target);
    if (!directory) return root.isFile() ? { size: root.size } : { size: null };
    if (!root.isDirectory()) return { size: null };
    let size = 0, count = 0;
    const pending = [target];
    while (pending.length) {
      for (const entry of await fs.readdir(pending.pop(), { withFileTypes: true })) {
        if (++count > 150_000) return { size, partial: true };
        const file = path.join(entry.parentPath, entry.name);
        if (entry.isDirectory()) pending.push(file);
        else if (entry.isFile()) {
          const stat = await fs.lstat(file);
          if (stat.isFile()) size += stat.size;
        }
      }
    }
    return { size };
  } catch { return { size: null }; }
}

export async function storageByDrive(state, folders) {
  const drives = new Map();
  const locations = new Map();
  for (const folder of folders) {
    let device, free = null, capacity = null;
    try {
      const info = await fs.stat(folder);
      if (!info.isDirectory()) throw new Error('Unavailable');
      device = 'dev:' + info.dev;
      try {
        const volume = await fs.statfs(folder);
        free = volume.bavail * volume.bsize;
        capacity = volume.blocks * volume.bsize;
      } catch {}
    } catch { device = 'offline:' + folder; }
    if (!drives.has(device)) drives.set(device, { id: device, online: !device.startsWith('offline:'), free, capacity, folders: [], items: [], measured: 0, incomplete: 0 });
    const drive = drives.get(device);
    drive.folders.push(folder);
    locations.set(folder, drive);
  }
  const paths = new Map();
  for (const game of state.games) {
    const installs = [game.installation, ...(game.previous || [])].filter(Boolean);
    for (const install of installs) {
      const file = installationFolder(install);
      if (!file || paths.has(file)) continue;
      paths.set(file, { gameId: game.id, kind: install === game.installation ? 'Current install' : 'Previous version', version: install.version || '', directory: true });
    }
  }
  for (const job of state.downloads) {
    if (!job.path || job.archiveRemoved || job.partialRemoved || paths.has(job.path)) continue;
    paths.set(job.path, { gameId: job.gameId, jobId: job.id, kind: 'Archive', version: job.version || '', directory: false });
  }
  const measuredDirectories = [];
  for (const [file, item] of [...paths].sort(([a], [b]) => a.length - b.length)) {
    const folder = folders.find(root => isInside(root, file));
    const drive = locations.get(folder);
    if (!drive?.online) continue;
    const counted = measuredDirectories.some(parent => isInside(parent, file, true));
    const result = await measureStorage(file, item.directory);
    drive.items.push({ file, ...item, ...result });
    if (counted) continue;
    if (result.size != null) drive.measured += result.size;
    if (result.size == null || result.partial) drive.incomplete++;
    if (item.directory && result.size != null && !result.partial) measuredDirectories.push(file);
  }
  return [...drives.values()].map(drive => ({ ...drive, itemCount: drive.items.length,
    items: drive.items.sort((a, b) => (b.size ?? -1) - (a.size ?? -1)).slice(0, 15) }));
}

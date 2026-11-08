import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { archivePath } from './files.mjs';

export async function extractZip(file, destination, { signal, progress = () => {} } = {}) {
  await fs.mkdir(destination, { recursive: false });
  const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(error) : resolve(value)));
  let expanded = 0, count = 0;
  const seen = new Set();
  try {
    await new Promise((resolve, reject) => {
      let finished = false;
      const fail = error => { if (finished) return; finished = true; zip.close(); reject(error); };
      const cancel = () => fail(new Error('Installation cancelled. The original game is unchanged.'));
      signal?.addEventListener('abort', cancel, { once: true });
      zip.on('error', fail);
      zip.on('end', () => { if (!finished) { finished = true; signal?.removeEventListener('abort', cancel); resolve(); } });
      zip.on('entry', entry => {
        (async () => {
          signal?.throwIfAborted();
          if (entry.generalPurposeBitFlag & 1) throw new Error('This ZIP is password protected. Use your external extraction app, then select the extracted folder.');
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const kind = mode & 0o170000;
          if (kind && ![0o100000, 0o040000].includes(kind)) throw new Error('This archive contains symbolic links or special files. Use an external extractor and select its output.');
          expanded += entry.uncompressedSize;
          if (expanded > 100 * 1024 ** 3 || ++count > 150000) throw new Error('Archive exceeds the alpha extraction limit. Use an external extraction app.');
          const target = archivePath(destination, entry.fileName);
          const key = target.toLowerCase();
          if (seen.has(key)) throw new Error('Archive contains duplicate or case-colliding paths. Use an external extraction app.');
          seen.add(key);
          if (entry.fileName.endsWith('/')) await fs.mkdir(target, { recursive: true });
          else {
            await fs.mkdir(path.dirname(target), { recursive: true });
            const stream = await new Promise((done, no) => zip.openReadStream(entry, (error, value) => error ? no(error) : done(value)));
            await pipeline(stream, createWriteStream(target, { flags: 'wx', mode: mode & 0o111 ? 0o755 : 0o644 }), { signal });
          }
          progress(count, zip.entryCount);
          if (!finished) zip.readEntry();
        })().catch(fail);
      });
      if (signal?.aborted) cancel(); else zip.readEntry();
    });
  } finally { zip.close(); }
  if (!count) throw new Error('The ZIP archive is empty.');
  const entries = (await fs.readdir(destination, { withFileTypes: true })).filter(item => item.name !== '__MACOSX' && item.name !== '.DS_Store');
  const only = entries[0];
  return entries.length === 1 && only.isDirectory() ? path.join(destination, only.name) : destination;
}

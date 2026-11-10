import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const batchSize = 6;

export class ThreadGallery {
  #pending = new Map();

  constructor(directory) { this.directory = directory; }

  #file(ref) {
    const key = createHash('sha256').update(ref.origin + ':' + ref.threadId).digest('hex');
    return path.join(this.directory, key + '.json');
  }

  async #read(file) {
    try {
      const cache = JSON.parse(await fs.readFile(file, 'utf8'));
      if (Array.isArray(cache.groups) && Array.isArray(cache.photos) && Number.isInteger(cache.cursor)) return cache;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return null;
  }

  async load(ref, client, mode = 'cached') {
    const file = this.#file(ref);
    if (this.#pending.has(file)) return this.#pending.get(file);
    const task = this.#load(file, ref, client, mode);
    this.#pending.set(file, task);
    try { return await task; } finally { this.#pending.delete(file); }
  }

  async #load(file, ref, client, mode) {
    let cache = await this.#read(file);
    const previous = cache;
    const first = !cache || mode === 'refresh' || (!cache.photos.length && cache.failed > 0 && mode !== 'more');
    if (first) {
      const metadata = await client.thread(ref.threadUrl, { cover: false, gallery: true });
      cache = { groups: metadata.imageGroups || [], photos: [], cursor: 0, failed: 0 };
    }
    if (first || mode === 'more') {
      const batch = cache.groups.slice(cache.cursor, cache.cursor + batchSize);
      const images = await Promise.all(batch.map(async group => {
        for (const url of group) {
          try { return await client.photo(url, true); }
          catch { /* Try another URL for the same photo. */ }
        }
        return null;
      }));
      cache.cursor += batch.length;
      for (const photo of images) {
        if (!photo) cache.failed++;
        else if (!cache.photos.some(item => item.id === photo.id)) cache.photos.push(photo);
      }
      if (first && !cache.photos.length && cache.failed && previous?.photos.length) {
        return { photos: previous.photos, hasMore: previous.cursor < previous.groups.length, failed: cache.failed };
      }
      await fs.mkdir(this.directory, { recursive: true });
      const temporary = file + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(cache), { mode: 0o600 });
      await fs.rename(temporary, file);
    }
    return { photos: cache.photos, hasMore: cache.cursor < cache.groups.length, failed: cache.failed };
  }

  async choose(ref, photoId) {
    const cache = await this.#read(this.#file(ref));
    return photoId ? cache?.photos.find(photo => photo.id === photoId) : cache?.photos[0];
  }

  async preview(ref) {
    const cache = await this.#read(this.#file(ref));
    return cache?.photos.slice(0, 3) || [];
  }
}

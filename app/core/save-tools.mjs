import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync, unzipSync } from 'node:zlib';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import LZString from 'lz-string';
import yauzl from 'yauzl';
import { assertNoLinks, isInside, readSmall } from './files.mjs';
import { savePlan } from './saves.mjs';

const maxJsonSize = 16 * 1024 ** 2;
const mvFile = /^file[1-9]\d*\.rpgsave$/i;
const mzFile = /^file\d+\.rmmzsave$/i;

if (!isMainThread && typeof workerData?.mvBase64 === 'string') {
  const json = LZString.decompressFromBase64(workerData.mvBase64);
  parentPort.postMessage(json && Buffer.byteLength(json) <= maxJsonSize ? json : null);
}

function decodeMv(mvBase64) {
  return new Promise((resolve, reject) => {
    // LZ-String has no decompressed-size option. Bound the worker's heap and runtime.
    const worker = new Worker(new URL(import.meta.url), { workerData: { mvBase64 }, resourceLimits: { maxOldGenerationSizeMb: 96 } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Save decoding timed out.')); }, 5000);
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', () => { clearTimeout(timer); reject(new Error('Save decoding failed.')); });
  });
}

function editorFor(engine, name) {
  if (engine === 'rpgmv' && mvFile.test(name)) return 'mv';
  if (engine === 'rpgmz' && mzFile.test(name)) return 'mz';
  if (engine === 'renpy' && /\.save$/i.test(name)) return 'renpy';
  return '';
}

export async function listGameSaves(game) {
  if (!game.installation) throw new Error('Locate the installed game first.');
  const plan = await savePlan(game.installation.root, game.engine, game.saveOverrides);
  const files = new Map();
  const locations = new Map();
  async function add(file, scope) {
    await assertNoLinks(path.parse(file).root, file);
    const stat = await fs.lstat(file);
    if (!stat.isFile()) return;
    const directory = path.dirname(file);
    locations.set(directory, scope);
    files.set(file, { file, name: path.basename(file), scope, size: stat.size, modified: stat.mtimeMs, editor: editorFor(plan.engine, path.basename(file)) });
  }
  for (const item of plan.local) await add(item.source, 'Inside game folder');
  for (const location of new Set(plan.external)) {
    await assertNoLinks(path.parse(location).root, location);
    if (!(await fs.lstat(location)).isDirectory()) {
      await add(location, 'External');
      continue;
    }
    locations.set(location, 'External');
    const entries = await fs.readdir(location, { withFileTypes: true });
    for (const entry of entries) if (entry.isFile()) await add(path.join(location, entry.name), 'External');
  }
  return {
    locations: [...locations].map(([directory, scope]) => ({ directory, scope })),
    files: [...files.values()].sort((a, b) => b.modified - a.modified)
  };
}

function digest(data) { return createHash('sha256').update(data).digest('hex'); }

function rpgValues(data, section) {
  const values = data[section]?._data;
  return Array.isArray(values) ? values : values?.['@a'];
}

export async function labelRpgFields(root, file, fields) {
  const candidates = [path.join(path.dirname(path.dirname(file)), 'data', 'System.json'),
    path.join(root, 'www', 'data', 'System.json'), path.join(root, 'data', 'System.json')];
  for (const candidate of new Set(candidates)) {
    if (!isInside(root, candidate)) continue;
    try {
      await assertNoLinks(root, candidate);
      const system = JSON.parse(await readSmall(candidate));
      return fields.map(field => {
        const [section, index] = field.id.split('/');
        const name = index && Array.isArray(system?.[section]) ? system[section][Number(index)] : '';
        return typeof name === 'string' && name.trim() ? { ...field, label: field.label + ' · ' + name.trim().slice(0, 100) } : field;
      });
    } catch { /* Custom deployments can omit or rename the database. */ }
  }
  return fields;
}

function rpgFields(data) {
  const fields = [];
  if (Number.isSafeInteger(data.party?._gold) && data.party._gold >= 0) {
    fields.push({ id: 'gold', label: 'Gold', value: data.party._gold });
  }
  for (const [section, label] of [['variables', 'Variable'], ['switches', 'Switch']]) {
    const values = rpgValues(data, section);
    if (!Array.isArray(values)) continue;
    for (let i = 1; i < values.length && fields.length < 2000; i++) {
      const value = values[i];
      if (section === 'switches' ? typeof value === 'boolean'
        : typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 500) {
        fields.push({ id: section + '/' + i, label: label + ' ' + i, value });
      }
    }
  }
  return fields;
}

export async function readRpgSave(file, format) {
  const maxInput = format === 'mv' ? 1024 ** 2 : 8 * 1024 ** 2;
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(maxInput + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxInput) throw new Error('This save is too large for the editor.');
    const bytes = buffer.subarray(0, bytesRead);
    let json, mzEncoding = '';
    try {
      if (format === 'mv') json = await decodeMv(bytes.toString('ascii').trim());
      else {
        // Desktop MZ releases can store deflate bytes as a UTF-8 encoded byte string.
        mzEncoding = 'bytes';
        try { json = unzipSync(bytes, { maxOutputLength: maxJsonSize }).toString('utf8'); }
        catch (error) {
          if (error.code === 'ERR_BUFFER_TOO_LARGE') throw error;
          mzEncoding = 'byte-string';
          const byteString = bytes.toString('utf8');
          if (/[^\u0000-\u00ff]/.test(byteString)) throw error;
          json = inflateSync(Buffer.from(byteString, 'latin1'), { maxOutputLength: maxJsonSize }).toString('utf8');
        }
      }
      if (!json || Buffer.byteLength(json) > maxJsonSize) throw new Error('Unsupported save size');
      const data = JSON.parse(json);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Unsupported save structure');
      const fields = rpgFields(data);
      if (!fields.length) throw new Error('No supported fields');
      return { revision: digest(bytes), data, fields, mzEncoding };
    } catch {
      throw new Error('This save has an unsupported format or contains no supported editable fields.');
    }
  } finally { await handle.close(); }
}

export function editRpgSave(save, format, changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > save.fields.length) throw new Error('Choose at least one supported field to change.');
  const fields = new Map(save.fields.map(field => [field.id, field]));
  for (const { id, value } of changes) {
    const field = fields.get(id);
    if (!field || typeof field.value !== typeof value ||
      typeof value === 'number' && !Number.isFinite(value) || typeof value === 'string' && value.length > 500 ||
      id === 'gold' && (!Number.isSafeInteger(value) || value < 0 || value > 99_999_999)) {
      throw new Error('An edited value is invalid for this save.');
    }
    fields.delete(id);
    if (id === 'gold') save.data.party._gold = value;
    else {
      const [section, index] = id.split('/');
      rpgValues(save.data, section)[Number(index)] = value;
    }
  }
  const json = JSON.stringify(save.data);
  if (format === 'mv') return LZString.compressToBase64(json);
  const bytes = deflateSync(json, { level: 1 });
  return save.mzEncoding === 'byte-string' ? bytes.toString('latin1') : bytes;
}

export function readRenpySlot(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) { reject(new Error('This Ren’Py save does not contain readable slot metadata.')); return; }
      const finish = (error, value) => { zip.close(); if (error) reject(error); else resolve(value); };
      let count = 0;
      zip.once('error', error => finish(error));
      zip.once('end', () => finish(null, {}));
      zip.on('entry', entry => {
        if (++count > 100) { finish(new Error('This save archive contains too many entries.')); return; }
        if (entry.fileName !== 'json') { zip.readEntry(); return; }
        if (entry.uncompressedSize > 128 * 1024) { finish(new Error('This save has oversized slot metadata.')); return; }
        zip.openReadStream(entry, (error, stream) => {
          if (error) { finish(error); return; }
          const chunks = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.once('error', error => finish(error));
          stream.once('end', () => {
            try {
              const meta = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const value = key => typeof meta?.[key] === 'string' ? meta[key].slice(0, 500) : '';
              const version = meta?._renpy_version;
              const engineVersion = Array.isArray(version) && version.length <= 6 && version.every(Number.isSafeInteger)
                ? version.join('.') : value('_renpy_version');
              finish(null, { label: value('_save_name'), version: value('_version'), engineVersion });
            } catch { finish(new Error('This save has invalid slot metadata.')); }
          });
        });
      });
      zip.readEntry();
    });
  });
}

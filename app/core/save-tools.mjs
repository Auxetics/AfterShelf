import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync, deflateSync, inflateSync, unzipSync } from 'node:zlib';
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
              finish(null, formatRenpySlotMeta(meta));
            } catch { finish(new Error('This save has invalid slot metadata.')); }
          });
        });
      });
      zip.readEntry();
    });
  });
}

function formatRenpySlotMeta(meta) {
  const value = key => typeof meta?.[key] === 'string' ? meta[key].slice(0, 500) : '';
  const version = meta?._renpy_version;
  const engineVersion = Array.isArray(version) && version.length <= 6 && version.every(Number.isSafeInteger)
    ? version.join('.') : value('_renpy_version');
  return { label: value('_save_name'), version: value('_version'), engineVersion };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const { name, data, compress = true } of entries) {
    const filename = Buffer.from(name, 'utf8');
    const raw = Buffer.from(data);
    const compressed = compress && raw.length > 64 ? deflateRawSync(raw) : raw;
    const method = compressed !== raw ? 8 : 0;
    const crc = crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(raw.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE((0o100644 * 65536) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function readPickleString(buf, pos) {
  const op = buf[pos];
  if (op === 0x8c || op === 0x55) {
    if (pos + 2 > buf.length) return null;
    const len = buf[pos + 1];
    const end = pos + 2 + len;
    if (end > buf.length) return null;
    return { text: buf.subarray(pos + 2, end).toString('utf8'), end, byteString: op === 0x55 };
  }
  if (op === 0x58 || op === 0x54) {
    if (pos + 5 > buf.length) return null;
    const len = buf.readUInt32LE(pos + 1);
    const end = pos + 5 + len;
    if (len > 2000 || end > buf.length) return null;
    return { text: buf.subarray(pos + 5, end).toString('utf8'), end, byteString: op === 0x54 };
  }
  return null;
}

function skipPickleMemo(buf, pos) {
  let cursor = pos;
  while (cursor < buf.length) {
    const op = buf[cursor];
    if (op === 0x94) cursor += 1;
    else if (op === 0x71 && cursor + 2 <= buf.length) cursor += 2;
    else if (op === 0x72 && cursor + 5 <= buf.length) cursor += 5;
    else break;
  }
  return cursor;
}

function readPicklePrimitive(buf, pos) {
  if (pos >= buf.length) return null;
  const op = buf[pos];
  if (op === 0x88) return { value: true, kind: 'boolean', start: pos, end: pos + 1 };
  if (op === 0x89) return { value: false, kind: 'boolean', start: pos, end: pos + 1 };
  if (op === 0x4b && pos + 2 <= buf.length) return { value: buf[pos + 1], kind: 'int', start: pos, end: pos + 2 };
  if (op === 0x4d && pos + 3 <= buf.length) return { value: buf.readUInt16LE(pos + 1), kind: 'int', start: pos, end: pos + 3 };
  if (op === 0x4a && pos + 5 <= buf.length) return { value: buf.readInt32LE(pos + 1), kind: 'int', start: pos, end: pos + 5 };
  if (op === 0x8a && pos + 2 <= buf.length) {
    const len = buf[pos + 1];
    const end = pos + 2 + len;
    if (len > 6 || end > buf.length) return null;
    if (len === 0) return { value: 0, kind: 'int', start: pos, end };
    let value = 0n;
    for (let i = len - 1; i >= 0; i--) value = (value << 8n) | BigInt(buf[pos + 2 + i]);
    if (buf[pos + 1 + len] & 0x80) value -= 1n << BigInt(len * 8);
    const num = Number(value);
    if (!Number.isSafeInteger(num)) return null;
    return { value: num, kind: 'int', start: pos, end };
  }
  if (op === 0x47 && pos + 9 <= buf.length) {
    const value = buf.readDoubleBE(pos + 1);
    if (!Number.isFinite(value)) return null;
    return { value, kind: 'float', start: pos, end: pos + 9 };
  }
  const str = readPickleString(buf, pos);
  if (str && str.text.length <= 500 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(str.text)) {
    return { value: str.text, kind: 'string', byteString: str.byteString, start: pos, end: str.end };
  }
  return null;
}

function encodePicklePrimitive(field, value) {
  if (field.kind === 'boolean') return Buffer.from([value ? 0x88 : 0x89]);
  if (field.kind === 'int' && Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647) {
    if (value >= 0 && value <= 255) return Buffer.from([0x4b, value]);
    if (value >= 0 && value <= 65535) {
      const out = Buffer.alloc(3); out[0] = 0x4d; out.writeUInt16LE(value, 1); return out;
    }
    const out = Buffer.alloc(5); out[0] = 0x4a; out.writeInt32LE(value, 1); return out;
  }
  if (field.kind === 'int' || field.kind === 'float') {
    const out = Buffer.alloc(9); out[0] = 0x47; out.writeDoubleBE(Number(value), 1); return out;
  }
  const bytes = Buffer.from(String(value), 'utf8');
  if (bytes.length <= 255) {
    return Buffer.concat([Buffer.from([field.byteString ? 0x55 : 0x8c, bytes.length]), bytes]);
  }
  const header = Buffer.alloc(5);
  header[0] = field.byteString ? 0x54 : 0x58;
  header.writeUInt32LE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

function scanRenpyLogFields(logBuffer) {
  const fields = [];
  const seen = new Set();
  for (let i = 0; i < logBuffer.length && fields.length < 2000; i++) {
    const key = readPickleString(logBuffer, i);
    if (!key || !/^store\.[A-Za-z_][A-Za-z0-9_.]*$/.test(key.text)) continue;
    const name = key.text.slice(6);
    if (name.startsWith('_') || seen.has(key.text)) continue;
    const valuePos = skipPickleMemo(logBuffer, key.end);
    const primitive = readPicklePrimitive(logBuffer, valuePos);
    if (!primitive) continue;
    seen.add(key.text);
    fields.push({
      id: 'store/' + name,
      label: name,
      value: primitive.value,
      kind: primitive.kind,
      byteString: Boolean(primitive.byteString),
      start: primitive.start,
      end: primitive.end
    });
    i = primitive.end - 1;
  }
  return fields;
}

export async function readRenpySave(file) {
  const stat = await fs.stat(file);
  if (stat.size > 16 * 1024 ** 2) throw new Error('This save is too large for the editor.');
  const rawZip = await fs.readFile(file);
  const revision = digest(rawZip);
  const entries = await new Promise((resolve, reject) => {
    yauzl.fromBuffer(rawZip, { lazyEntries: true }, (error, zip) => {
      if (error) { reject(new Error('This Ren’Py save archive could not be opened.')); return; }
      const list = [];
      let total = 0;
      const finish = (err, res) => { zip.close(); if (err) reject(err); else resolve(res); };
      zip.once('error', finish);
      zip.once('end', () => finish(null, list));
      zip.on('entry', entry => {
        if (list.length >= 100) { finish(new Error('This save archive contains too many entries.')); return; }
        total += entry.uncompressedSize;
        if (total > 24 * 1024 ** 2) { finish(new Error('This save has oversized entries.')); return; }
        zip.openReadStream(entry, (err, stream) => {
          if (err) { finish(err); return; }
          const chunks = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.once('error', finish);
          stream.once('end', () => {
            list.push({ name: entry.fileName, data: Buffer.concat(chunks), compress: entry.compressionMethod !== 0 });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
  let jsonMeta = {}, slot = { label: '', version: '', engineVersion: '' };
  const fields = [];
  const jsonEntry = entries.find(item => item.name === 'json');
  if (jsonEntry) {
    try {
      jsonMeta = JSON.parse(jsonEntry.data.toString('utf8'));
      slot = formatRenpySlotMeta(jsonMeta);
      if (typeof jsonMeta._save_name === 'string') {
        fields.push({ id: 'json/_save_name', label: 'Save slot label (_save_name)', value: jsonMeta._save_name.slice(0, 500), kind: 'string' });
      }
      for (const [key, value] of Object.entries(jsonMeta)) {
        if (key.startsWith('_')) continue;
        if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 500) {
          fields.push({ id: 'json/' + key, label: 'Slot JSON · ' + key, value, kind: typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'float' : 'string' });
        }
      }
    } catch { throw new Error('This save has invalid slot metadata.'); }
  }
  const logEntry = entries.find(item => item.name === 'log');
  if (logEntry) fields.push(...scanRenpyLogFields(logEntry.data));
  return { revision, slot, fields, entries, jsonMeta };
}

export function editRenpySave(save, changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > save.fields.length) throw new Error('Choose at least one supported field to change.');
  const fields = new Map(save.fields.map(field => [field.id, field]));
  const logEdits = [];
  let jsonChanged = false, saveNameChanged = null;
  const nextJson = structuredClone(save.jsonMeta || {});
  for (const { id, value } of changes) {
    const field = fields.get(id);
    if (!field || typeof field.value !== typeof value ||
      typeof value === 'number' && !Number.isFinite(value) ||
      typeof value === 'string' && value.length > 500) {
      throw new Error('An edited value is invalid for this save.');
    }
    fields.delete(id);
    if (id.startsWith('json/')) {
      const key = id.slice(5);
      nextJson[key] = value;
      jsonChanged = true;
      if (key === '_save_name') saveNameChanged = String(value);
    } else if (id.startsWith('store/')) {
      const targetField = field.kind === 'int' && !Number.isInteger(value) ? { ...field, kind: 'float' } : field;
      logEdits.push({ start: field.start, end: field.end, replacement: encodePicklePrimitive(targetField, value) });
    }
  }
  logEdits.sort((a, b) => b.start - a.start);
  const updatedEntries = [];
  for (const entry of save.entries) {
    if (entry.name === 'signatures' && (logEdits.length || jsonChanged)) continue;
    if (entry.name === 'json' && jsonChanged) {
      updatedEntries.push({ ...entry, data: Buffer.from(JSON.stringify(nextJson), 'utf8') });
    } else if (entry.name === 'extra_info' && saveNameChanged !== null) {
      updatedEntries.push({ ...entry, data: Buffer.from(saveNameChanged, 'utf8') });
    } else if (entry.name === 'log' && logEdits.length) {
      let data = Buffer.from(entry.data);
      for (const edit of logEdits) {
        data = Buffer.concat([data.subarray(0, edit.start), edit.replacement, data.subarray(edit.end)]);
      }
      updatedEntries.push({ ...entry, data });
    } else {
      updatedEntries.push(entry);
    }
  }
  return buildZip(updatedEntries);
}

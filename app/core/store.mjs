import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { initialState } from './model.mjs';
import { migrateSources, configuredSources } from './sources.mjs';

export function redact(value) {
  return String(value ?? '').replace(/https?:\/\/[^\s<>"']+/gi, raw => {
    try { const url = new URL(raw); return `${url.origin}${url.pathname}${url.search ? '?[redacted]' : ''}`; } catch { return '[URL]'; }
  }).replace(/((?:cookie|authorization|password|token|secret|set-cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(/(?:\/Users\/|\/home\/)[^/\s]+/g, '[home]').replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, '[home]');
}
export class Store extends EventEmitter {
  constructor(directory) { super(); this.file = path.join(directory, 'library.json'); this.data = initialState(); this.pending = Promise.resolve(); }
  async open() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const stored = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (stored.schema !== 1 || !Array.isArray(stored.games) || !Array.isArray(stored.downloads)) throw new Error('Unsupported library format. The existing library file has not been overwritten.');
      this.data = { ...this.data, ...stored, settings: { ...this.data.settings, ...stored.settings }, scan: { ...this.data.scan, ...stored.scan, active: false } };
      this.data.libraryScan = { active: false, message: '', candidates: [], warnings: [] };
      this.data.detailScan = { active: false, message: '' };
      if (stored.scan?.active) { this.data.scan.message = 'Previous update check was interrupted. Run another check.'; this.data.scan.error = 'The app closed before the update check finished.'; }
      for (const game of this.data.games) {
        if (game.metadataParserVersion !== 2 && /"lightbox_(?:close|next|previous|error)"\s*:/i.test(game.description || '')) { game.description = ''; game.metadataNeedsRefresh = true; }
      }
      for (const job of this.data.downloads) {
        if (['downloading', 'retrying', 'queued'].includes(job.status)) { job.managedDownload = true; job.status = 'cancelled'; job.error = 'The app closed before this download completed. Open its thread to download again.'; }
        if (job.status === 'installing') { job.status = job.extractedPath ? 'awaiting-folder' : 'downloaded'; job.error = 'Installation was not confirmed. Select its extracted folder or run Install / Update again.'; }
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    migrateSources(this.data);
  }
  snapshot() { return structuredClone(this.data); }
  update(mutator) {
    mutator(this.data);
    const serialized = JSON.stringify(this.data, null, 2);
    this.pending = this.pending.catch(() => {}).then(async () => {
      const temporary = `${this.file}.tmp`;
      await fs.writeFile(temporary, serialized, { mode: 0o600 });
      await fs.rename(temporary, this.file);
    });
    this.pending.catch(error => this.emit('write-error', error));
    this.emit('change', this.snapshot());
    return this.pending;
  }
  log(message, details = '') {
    return this.update(state => { state.history.unshift({ at: Date.now(), message: redact(message), details: redact(details) }); state.history = state.history.slice(0, 200); });
  }
  diagnostic(version, platform, arch) {
    return ['AfterShelf diagnostics', `App: ${version}`, `Platform: ${platform} ${arch}`, `Generated: ${new Date().toISOString()}`,
      `Site: ${this.data.settings.site.origin}`, `Games: ${this.data.games.length}`, `Downloads: ${this.data.downloads.length}`,
      ...configuredSources(this.data.settings).map(source => `Source ${source.shortName}: ${source.origin}; feed=${source.feedFormat}; status=${redact(this.data.sourceStatus[source.id]?.message || 'not checked')}; check=${redact(this.data.sourceScans[source.id]?.message || 'not checked')}`),
      'Rule set: alpha-1 (experimental; live game validation pending)', '',
      `Last completed update check: ${this.data.scan.lastChecked || 'never'}`,
      `Update check: ${redact(this.data.scan.message)}; ${redact(this.data.scan.error || '')}`,
      `Update summary: ${redact(JSON.stringify(this.data.scan.summary || {}))}`, '',
      ...this.data.games.map(game => `Game ${game.id}: thread=${game.threadId || 'unlinked'}; engine=${game.engine || 'custom'}; cover=${game.coverStatus || 'not checked'}; ${redact(game.coverError || '')}; install-check=${game.installationCheck?.status || 'not checked'}; ${redact(game.installationCheck?.metadataWarning || '')}`), '',
      ...this.data.downloads.map(job => `Download ${job.id}: ${job.status}; game=${job.gameId || 'unassigned'}; ${redact(job.error || '')}`), '',
      ...this.data.history.flatMap(item => [`${new Date(item.at).toISOString()} ${item.message}`, item.details].filter(Boolean))].join('\n');
  }
}

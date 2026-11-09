import fs from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { extractZip } from './archive.mjs';

import { displayAppVersion } from './app-update-state.mjs';
export { displayAppVersion, restartBlockReason } from './app-update-state.mjs';

export function parseAppVersion(version) {
  const cleaned = String(version ?? '').trim().replace(/^v(?=\d)/i, '');
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(cleaned);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    prerelease: (match[4] || '').toLowerCase()
  };
}

export function compareAppVersions(left, right) {
  const a = parseAppVersion(left);
  const b = parseAppVersion(right);
  if (!a || !b) return null;
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const aParts = a.prerelease.split(/[.-]/);
  const bParts = b.prerelease.split(/[.-]/);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const x = aParts[i];
    const y = bParts[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x) ? Number(x) : null;
    const yNum = /^\d+$/.test(y) ? Number(y) : null;
    if (xNum !== null && yNum !== null) return xNum > yNum ? 1 : -1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function selectReleaseUpdate(releases, {
  currentVersion,
  platform = process.platform,
  arch = process.arch
} = {}) {
  const list = Array.isArray(releases) ? releases : releases ? [releases] : [];
  const platformToken = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : '';
  if (!platformToken || !parseAppVersion(currentVersion)) return null;

  const zipPattern = new RegExp(`^AfterShelf-.*-${platformToken}-${arch}\\.zip$`, 'i');
  const winPayloadPattern = new RegExp(`^aftershelf-.*-${arch}\\.nsis\\.7z$`, 'i');
  const winInstallerPattern = new RegExp(`^AfterShelf-Web-Setup-.*-win-${arch}\\.exe$`, 'i');
  const candidates = [];

  for (const release of list) {
    if (!release || release.draft) continue;
    const rawVersion = release.tag_name || release.name || '';
    const cmp = compareAppVersions(rawVersion, currentVersion);
    if (cmp === null || cmp <= 0) continue;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    let asset = assets.find(item => item?.name && zipPattern.test(item.name) && item.browser_download_url);
    let installerAsset = null;
    if (!asset && platform === 'win32') {
      const nsisPayload = assets.find(item => item?.name && winPayloadPattern.test(item.name) && item.browser_download_url);
      const nsisInstaller = assets.find(item => item?.name && winInstallerPattern.test(item.name) && item.browser_download_url);
      if (nsisPayload && nsisInstaller) {
        asset = nsisPayload;
        installerAsset = {
          name: nsisInstaller.name,
          url: nsisInstaller.browser_download_url,
          size: Number(nsisInstaller.size) || 0
        };
      }
    }
    if (!asset) continue;
    const checksumAsset = assets.find(item => item?.name === `${asset.name}.sha256` && item.browser_download_url) || null;
    candidates.push({
      version: displayAppVersion(rawVersion),
      tagName: release.tag_name || rawVersion,
      asset: {
        name: asset.name,
        url: asset.browser_download_url,
        size: Number(asset.size) || 0
      },
      installerAsset,
      checksumAsset: checksumAsset
        ? { name: checksumAsset.name, url: checksumAsset.browser_download_url }
        : null,
      htmlUrl: release.html_url || ''
    });
  }

  candidates.sort((a, b) => compareAppVersions(b.version, a.version) || 0);
  return candidates[0] || null;
}

function defaultGetStream(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.get(
      parsed,
      {
        headers: {
          'User-Agent': 'AfterShelf-Updater',
          Accept: 'application/vnd.github+json, application/octet-stream, */*'
        }
      },
      res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects <= 0) {
            reject(new Error('Too many redirects while checking for app updates.'));
            return;
          }
          const nextUrl = new URL(res.headers.location, parsed).href;
          resolve(defaultGetStream(nextUrl, redirects - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`App update request failed with HTTP ${res.statusCode}.`));
          return;
        }
        resolve(res);
      }
    );
    req.on('error', reject);
  });
}

async function fetchJson(url, getStream = defaultGetStream) {
  const stream = await getStream(url);
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function fetchText(url, getStream = defaultGetStream) {
  const stream = await getStream(url);
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function downloadFile(url, destination, { getStream = defaultGetStream, expectedTotal = 0, onProgress } = {}) {
  const stream = await getStream(url);
  const total = Number(stream.headers?.['content-length']) || expectedTotal || 0;
  const hash = createHash('sha256');
  const out = createWriteStream(destination, { mode: 0o600 });
  let received = 0;
  let lastReport = 0;

  try {
    for await (const chunk of stream) {
      const buf = Buffer.from(chunk);
      received += buf.length;
      hash.update(buf);
      if (!out.write(buf)) {
        await new Promise(resolve => out.once('drain', resolve));
      }
      const now = Date.now();
      if (onProgress && (now - lastReport >= 200 || (total && received >= total))) {
        lastReport = now;
        onProgress({ received, total });
      }
    }
    await new Promise((resolve, reject) => {
      out.end(err => (err ? reject(err) : resolve()));
    });
    if (onProgress) onProgress({ received, total: total || received });
    return { sha256: hash.digest('hex'), received, total: total || received };
  } catch (error) {
    out.destroy();
    throw error;
  }
}

export function resolveInstalledAppTarget({
  platform = process.platform,
  execPath = process.execPath,
  overrideTarget = process.env.AFTERSHELF_APP_TARGET || ''
} = {}) {
  if (overrideTarget) return path.resolve(overrideTarget);
  if (platform === 'darwin') {
    const match = /^(.+?\.app)\/Contents\/MacOS\/[^/]+$/i.exec(execPath);
    if (!match || /\/Electron\.app$/i.test(match[1])) return '';
    return match[1];
  }
  if (platform === 'win32') {
    if (/electron\.exe$/i.test(execPath)) return '';
    return path.dirname(execPath);
  }
  return '';
}

export function buildMacRestartScript({ pid, stagedAppPath, targetAppPath, updatesDir, relaunch = true }) {
  return `#!/bin/zsh
set -euo pipefail
PID=${JSON.stringify(String(pid))}
STAGED_APP=${JSON.stringify(stagedAppPath)}
TARGET_APP=${JSON.stringify(targetAppPath)}
UPDATES_DIR=${JSON.stringify(updatesDir)}

for _ in {1..150}; do
  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi
  /bin/sleep 0.2
done

DEST_DIR="$(/usr/bin/dirname "$TARGET_APP")"
TEMP_APP="$DEST_DIR/.AfterShelf.app.update.$$"
/bin/rm -rf "$TEMP_APP"
/usr/bin/ditto "$STAGED_APP" "$TEMP_APP"
/usr/bin/xattr -dr com.apple.quarantine "$TEMP_APP" >/dev/null 2>&1 || true
/bin/rm -rf "$TARGET_APP"
/bin/mv "$TEMP_APP" "$TARGET_APP"
/bin/rm -rf "$UPDATES_DIR"
${relaunch ? '/usr/bin/open "$TARGET_APP"' : ''}
`;
}

export function buildWindowsRestartScript({ pid, stagedDirPath, installerExePath = '', packageFilePath = '', targetDirPath, exeName = 'AfterShelf.exe', updatesDir, relaunch = true }) {
  const escapedUpdates = updatesDir.replace(/'/g, "''");
  if (installerExePath && packageFilePath) {
    const escapedInstaller = installerExePath.replace(/'/g, "''");
    const escapedPkg = packageFilePath.replace(/'/g, "''");
    const args = relaunch
      ? `'/S', '--force-run', '--package-file="${escapedPkg}"'`
      : `'/S', '--package-file="${escapedPkg}"'`;
    return `$ErrorActionPreference = 'SilentlyContinue'
$procId = ${Number(pid)}
for ($i = 0; $i -lt 150; $i++) {
  if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 200
}
Start-Process -FilePath '${escapedInstaller}' -ArgumentList @(${args}) -Wait
Remove-Item -Path '${escapedUpdates}' -Recurse -Force
`;
  }
  const escapedStage = stagedDirPath.replace(/'/g, "''");
  const escapedTarget = targetDirPath.replace(/'/g, "''");
  const escapedExe = path.join(targetDirPath, exeName).replace(/'/g, "''");
  return `$ErrorActionPreference = 'SilentlyContinue'
$procId = ${Number(pid)}
for ($i = 0; $i -lt 150; $i++) {
  if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 200
}
Copy-Item -Path '${escapedStage}\\*' -Destination '${escapedTarget}' -Recurse -Force
Remove-Item -Path '${escapedUpdates}' -Recurse -Force
${relaunch ? `Start-Process -FilePath '${escapedExe}'` : ''}
`;
}

export class AppUpdater {
  constructor({
    currentVersion,
    userDataDir,
    owner = 'Auxetics',
    repo = 'AfterShelf',
    platform = process.platform,
    arch = process.arch,
    apiUrl = process.env.AFTERSHELF_UPDATE_API_URL || `https://api.github.com/repos/${owner}/${repo}/releases?per_page=10`,
    getStream = defaultGetStream,
    getBlockReason = () => '',
    onChange = () => {},
    onLog = () => {}
  }) {
    this.currentVersion = currentVersion;
    this.updatesDir = path.join(userDataDir, 'updates');
    this.platform = platform;
    this.arch = arch;
    this.apiUrl = apiUrl;
    this.getStream = getStream;
    this.getBlockReason = getBlockReason;
    this.onChange = onChange;
    this.onLog = onLog;
    this.stagedPath = '';
    this.state = { status: 'idle', version: '', received: 0, total: 0, percent: 0 };
    this.checking = null;
  }

  snapshot() {
    return { ...this.state };
  }

  setState(changes) {
    this.state = { ...this.state, ...changes };
    this.onChange(this.snapshot());
  }

  async checkForUpdates() {
    if (this.checking) return this.checking;
    this.checking = this.#runCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  async #runCheck() {
    try {
      const releases = await fetchJson(this.apiUrl, this.getStream);
      const update = selectReleaseUpdate(releases, {
        currentVersion: this.currentVersion,
        platform: this.platform,
        arch: this.arch
      });
      if (!update) {
        this.setState({ status: 'idle', version: '', received: 0, total: 0, percent: 0 });
        return null;
      }

      await fs.rm(this.updatesDir, { recursive: true, force: true });
      await fs.mkdir(this.updatesDir, { recursive: true });
      const archivePath = path.join(this.updatesDir, update.asset.name);

      this.setState({
        status: 'downloading',
        version: update.version,
        received: 0,
        total: update.asset.size || 0,
        percent: 0
      });

      const downloaded = await downloadFile(update.asset.url, archivePath, {
        getStream: this.getStream,
        expectedTotal: update.asset.size,
        onProgress: ({ received, total }) => {
          const percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0;
          this.setState({ status: 'downloading', version: update.version, received, total, percent });
        }
      });

      if (update.checksumAsset) {
        const checksumText = await fetchText(update.checksumAsset.url, this.getStream);
        const expectedSha = checksumText.trim().split(/\s+/)[0]?.toLowerCase();
        if (expectedSha && expectedSha !== downloaded.sha256.toLowerCase()) {
          throw new Error(`Downloaded update checksum mismatch for ${update.asset.name}.`);
        }
      }

      const stageDir = path.join(this.updatesDir, 'staged');
      await fs.mkdir(stageDir, { recursive: true });
      this.stagedInstallerPath = '';
      if (this.platform === 'darwin') {
        execFileSync('/usr/bin/ditto', ['-x', '-k', archivePath, stageDir]);
        const appBundle = path.join(stageDir, 'AfterShelf.app');
        if (!existsSync(path.join(appBundle, 'Contents', 'Info.plist'))) {
          throw new Error('Downloaded macOS update did not contain a valid AfterShelf.app bundle.');
        }
        this.stagedPath = appBundle;
        await fs.rm(archivePath, { force: true });
      } else if (this.platform === 'win32') {
        if (update.installerAsset) {
          const installerPath = path.join(stageDir, update.installerAsset.name);
          const payloadPath = path.join(stageDir, update.asset.name);
          await fs.rename(archivePath, payloadPath);
          await downloadFile(update.installerAsset.url, installerPath, {
            getStream: this.getStream,
            expectedTotal: update.installerAsset.size
          });
          this.stagedInstallerPath = installerPath;
          this.stagedPath = payloadPath;
        } else {
          const extractedRoot = await extractZip(archivePath, stageDir);
          const exeCandidate = existsSync(path.join(extractedRoot, 'AfterShelf.exe'))
            ? extractedRoot
            : existsSync(path.join(stageDir, 'AfterShelf.exe'))
              ? stageDir
              : '';
          if (!exeCandidate) {
            throw new Error('Downloaded Windows update did not contain AfterShelf.exe.');
          }
          this.stagedPath = exeCandidate;
          await fs.rm(archivePath, { force: true });
        }
      } else {
        throw new Error(`Self-updating is not supported on platform ${this.platform}.`);
      }

      this.setState({
        status: 'ready',
        version: update.version,
        received: downloaded.received,
        total: downloaded.total,
        percent: 100
      });
      await this.onLog('App update ready', `AfterShelf ${update.version} downloaded and ready to apply on restart.`);
      return update;
    } catch (error) {
      this.stagedPath = '';
      this.setState({ status: 'idle', version: '', received: 0, total: 0, percent: 0 });
      await this.onLog('App update check needs attention', error.message);
      return null;
    }
  }

  async applyOnRestart({
    pid = process.pid,
    execPath = process.execPath,
    overrideTarget = process.env.AFTERSHELF_APP_TARGET || '',
    relaunch = process.env.AFTERSHELF_UPDATE_NO_RELAUNCH !== '1',
    spawnProcess = spawn
  } = {}) {
    if (this.state.status !== 'ready' || !this.stagedPath || !existsSync(this.stagedPath)) {
      throw new Error('No completed application update is ready to install.');
    }
    const blockReason = this.getBlockReason();
    if (blockReason) {
      throw new Error(blockReason);
    }
    const targetPath = resolveInstalledAppTarget({
      platform: this.platform,
      execPath,
      overrideTarget
    });
    if (!targetPath) {
      throw new Error('Self-update restart requires a packaged AfterShelf installation.');
    }

    if (this.platform === 'darwin') {
      const scriptPath = path.join(this.updatesDir, 'apply-update.sh');
      const script = buildMacRestartScript({
        pid,
        stagedAppPath: this.stagedPath,
        targetAppPath: targetPath,
        updatesDir: this.updatesDir,
        relaunch
      });
      await fs.writeFile(scriptPath, script, { mode: 0o755 });
      const child = spawnProcess('/bin/zsh', [scriptPath], { detached: true, stdio: 'ignore' });
      child.unref();
    } else if (this.platform === 'win32') {
      const scriptPath = path.join(this.updatesDir, 'apply-update.ps1');
      const script = buildWindowsRestartScript({
        pid,
        stagedDirPath: this.stagedPath,
        installerExePath: this.stagedInstallerPath || '',
        packageFilePath: this.stagedInstallerPath ? this.stagedPath : '',
        targetDirPath: targetPath,
        updatesDir: this.updatesDir,
        relaunch
      });
      await fs.writeFile(scriptPath, script, 'utf8');
      const child = spawnProcess(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      child.unref();
    } else {
      throw new Error(`Self-updating is not supported on platform ${this.platform}.`);
    }

    this.setState({ status: 'restarting' });
    return { restarting: true, version: this.state.version };
  }
}

// Build lightweight macOS Web Setup installers (.pkg and .dmg when hdiutil is
// available) that check system prerequisites and download the architecture-specific
// application payload from GitHub Releases during installation.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sha256File(file) {
  const hash = createHash('sha256');
  const handle = await fs.open(file);
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

export function installerInfoPlist(version, bundleVersion = version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Install AfterShelf</string>
  <key>CFBundleExecutable</key>
  <string>aftershelf-web-setup</string>
  <key>CFBundleIconFile</key>
  <string>aftershelf.icns</string>
  <key>CFBundleIdentifier</key>
  <string>com.aftershelf.desktop.installer</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Install AfterShelf</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${bundleVersion}</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

export function installerScript({ version, arch, owner, repo, expectedSha256 = '', pkgMode = false }) {
  const baseUrl = `https://github.com/${owner}/${repo}/releases/download/${version}`;
  return `#!/bin/zsh
set -euo pipefail

VERSION=${JSON.stringify(version)}
BUILT_ARCH=${JSON.stringify(arch)}
EXPECTED_SHA256=${JSON.stringify(expectedSha256)}
RELEASE_BASE="\${AFTERSHELF_RELEASE_BASE_URL:-${baseUrl}}"
NONINTERACTIVE="\${AFTERSHELF_NONINTERACTIVE:-${pkgMode ? '1' : '0'}}"
PKG_TARGET_VOLUME="\${3:-}"

alert_error() {
  local msg="\$1"
  if [[ "\$NONINTERACTIVE" == "1" ]]; then
    print -u2 "AfterShelf Web Setup error: \$msg"
  else
    /usr/bin/osascript -e "display alert \\"AfterShelf Setup Could Not Complete\\" message \\"\${msg//\\"/\\\\\\"}\\" as critical" >/dev/null 2>&1 || true
  fi
  exit 1
}

# 1. Verify OS and required macOS system dependencies
if [[ "\$(/usr/bin/uname -s)" != "Darwin" ]]; then
  alert_error "This installer requires macOS."
fi

for tool in /usr/bin/curl /usr/bin/ditto /usr/bin/shasum /usr/bin/osascript /usr/bin/xattr /usr/bin/codesign; do
  if [[ ! -x "\$tool" ]]; then
    alert_error "Required system tool missing: \$tool"
  fi
done

# 2. Detect native hardware architecture (including under Rosetta)
if [[ -n "\${AFTERSHELF_TARGET_ARCH:-}" ]]; then
  TARGET_ARCH="\$AFTERSHELF_TARGET_ARCH"
elif [[ "\$(/usr/bin/uname -m)" == "arm64" ]] || [[ "\$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" == "1" ]]; then
  TARGET_ARCH="arm64"
else
  TARGET_ARCH="x64"
fi

if /usr/bin/pgrep -x "AfterShelf" >/dev/null 2>&1; then
  alert_error "AfterShelf is currently running. Please quit AfterShelf before installing or updating."
fi

# 3. Choose installation directory
if [[ -n "\${AFTERSHELF_INSTALL_DIR:-}" ]]; then
  DEST_DIR="\$AFTERSHELF_INSTALL_DIR"
elif [[ -n "\$PKG_TARGET_VOLUME" ]] && [[ -d "\${PKG_TARGET_VOLUME%/}/Applications" ]]; then
  DEST_DIR="\${PKG_TARGET_VOLUME%/}/Applications"
elif [[ "\$NONINTERACTIVE" == "1" ]]; then
  if [[ -w "/Applications" ]]; then
    DEST_DIR="/Applications"
  else
    DEST_DIR="\$HOME/Applications"
    /bin/mkdir -p "\$DEST_DIR"
  fi
else
  CHOICE=\$(/usr/bin/osascript -e "button returned of (display dialog \\"Install AfterShelf \$VERSION (\$TARGET_ARCH)?\\n\\nThis web installer will download the AfterShelf application package and runtime dependencies from GitHub Releases and install AfterShelf.app.\\" buttons {\\"Cancel\\", \\"Choose Folder…\\", \\"Install in Applications\\"} default button \\"Install in Applications\\" cancel button \\"Cancel\\" with title \\"AfterShelf Web Setup\\")" 2>/dev/null) || exit 0
  if [[ "\$CHOICE" == "Choose Folder…" ]]; then
    DEST_DIR=\$(/usr/bin/osascript -e 'POSIX path of (choose folder with prompt "Select where to install AfterShelf.app:")' 2>/dev/null) || exit 0
    DEST_DIR="\${DEST_DIR%/}"
  elif [[ -w "/Applications" ]]; then
    DEST_DIR="/Applications"
  else
    DEST_DIR="\$HOME/Applications"
    /bin/mkdir -p "\$DEST_DIR"
  fi
fi

if [[ ! -d "\$DEST_DIR" ]] || [[ ! -w "\$DEST_DIR" ]]; then
  alert_error "The destination folder (\$DEST_DIR) is not writable. Choose another folder such as ~/Applications."
fi

PAYLOAD_NAME="AfterShelf-\${VERSION}-mac-\${TARGET_ARCH}.zip"
PAYLOAD_URL="\${RELEASE_BASE}/\${PAYLOAD_NAME}"
CHECKSUM_URL="\${PAYLOAD_URL}.sha256"

WORK_DIR="\$(/usr/bin/mktemp -d "\${TMPDIR:-/tmp}/aftershelf-web-setup.XXXXXX")"
trap '/bin/rm -rf "\$WORK_DIR"' EXIT INT TERM

ARCHIVE_PATH="\$WORK_DIR/\$PAYLOAD_NAME"
EXTRACT_DIR="\$WORK_DIR/extracted"

# 4. Download application payload on demand
if ! /usr/bin/curl -fL --retry 3 --connect-timeout 15 --max-time 900 -o "\$ARCHIVE_PATH" "\$PAYLOAD_URL"; then
  alert_error "Could not download \$PAYLOAD_NAME from GitHub Releases. Check your internet connection and verify release \$VERSION is published."
fi

# 5. Verify SHA-256 checksum
EXPECTED=""
if [[ "\$TARGET_ARCH" == "\$BUILT_ARCH" ]] && [[ -n "\$EXPECTED_SHA256" ]]; then
  EXPECTED="\$EXPECTED_SHA256"
elif /usr/bin/curl -fsSL --retry 2 --connect-timeout 10 -o "\$ARCHIVE_PATH.sha256" "\$CHECKSUM_URL" 2>/dev/null; then
  EXPECTED="\$(/usr/bin/awk '{print \$1}' "\$ARCHIVE_PATH.sha256" | /usr/bin/tr -d '\\r\\n')"
fi

if [[ -n "\$EXPECTED" ]]; then
  ACTUAL="\$(/usr/bin/shasum -a 256 "\$ARCHIVE_PATH" | /usr/bin/awk '{print \$1}')"
  if [[ "\$ACTUAL" != "\$EXPECTED" ]]; then
    alert_error "Downloaded package checksum mismatch (expected \$EXPECTED, got \$ACTUAL). Installation aborted."
  fi
fi

# 6. Extract and validate bundle structure before replacing existing app
/bin/mkdir -p "\$EXTRACT_DIR"
if ! /usr/bin/ditto -x -k "\$ARCHIVE_PATH" "\$EXTRACT_DIR"; then
  alert_error "The downloaded archive could not be extracted."
fi

APP_BUNDLE="\$EXTRACT_DIR/AfterShelf.app"
if [[ ! -f "\$APP_BUNDLE/Contents/Info.plist" ]]; then
  alert_error "The downloaded archive did not contain a valid AfterShelf.app bundle."
fi

STAGING_APP="\$DEST_DIR/.AfterShelf.app.staging.\$\$"
/bin/rm -rf "\$STAGING_APP"
/usr/bin/ditto "\$APP_BUNDLE" "\$STAGING_APP"
/usr/bin/xattr -dr com.apple.quarantine "\$STAGING_APP" >/dev/null 2>&1 || true

TARGET_APP="\$DEST_DIR/AfterShelf.app"
/bin/rm -rf "\$TARGET_APP"
/bin/mv "\$STAGING_APP" "\$TARGET_APP"

if [[ "\$NONINTERACTIVE" != "1" ]]; then
  OPEN_CHOICE=\$(/usr/bin/osascript -e "button returned of (display dialog \\"AfterShelf \$VERSION has been installed in \$DEST_DIR.\\" buttons {\\"Done\\", \\"Open AfterShelf\\"} default button \\"Open AfterShelf\\" with title \\"AfterShelf Installed\\")" 2>/dev/null) || OPEN_CHOICE="Done"
  if [[ "\$OPEN_CHOICE" == "Open AfterShelf" ]]; then
    /usr/bin/open "\$TARGET_APP"
  fi
fi
`;
}

async function buildCompactIcns(assetsDir, outFile) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aftershelf-setup-icns-'));
  try {
    const iconset = path.join(temp, 'AfterShelf.iconset');
    await fs.mkdir(iconset);
    const source256 = path.join(assetsDir, 'aftershelf-256.png');
    for (const [size, scale, pixels] of [
      [16, '', 16], [16, '@2x', 32],
      [32, '', 32], [32, '@2x', 64],
      [128, '', 128], [128, '@2x', 256]
    ]) {
      const target = path.join(iconset, `icon_${size}x${size}${scale}.png`);
      const prebuilt = path.join(assetsDir, `aftershelf-${pixels}.png`);
      if (existsSync(prebuilt)) await fs.copyFile(prebuilt, target);
      else execFileSync('sips', ['-z', String(pixels), String(pixels), source256, '--out', target], { stdio: 'ignore' });
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', outFile], { stdio: 'ignore' });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

export async function buildMacBootstrap({
  arches = ['arm64', 'x64'],
  releaseDir = path.join(rootDir, 'release'),
  assetsDir = path.join(rootDir, 'app', 'assets'),
  packageJsonPath = path.join(rootDir, 'package.json')
} = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS bootstrap installer creation requires macOS.');
  const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  const pkgVersion = pkg.version;
  const version = pkgVersion.replace(/^(\d+\.\d+)\.0(-Alpha.*)$/i, '$1$2');
  const publish = pkg.build?.publish?.[0] || { owner: 'Auxetics', repo: 'AfterShelf' };
  await fs.mkdir(releaseDir, { recursive: true });

  const built = [];
  for (const arch of arches) {
    const payloadZip = path.join(releaseDir, `AfterShelf-${version}-mac-${arch}.zip`);
    let expectedSha256 = '';
    if (existsSync(payloadZip)) {
      expectedSha256 = await sha256File(payloadZip);
    }

    const staging = await fs.mkdtemp(path.join(os.tmpdir(), `aftershelf-mac-setup-${arch}-`));
    try {
      const dmgStage = path.join(staging, 'dmg');
      const appDir = path.join(dmgStage, 'Install AfterShelf.app');
      const contentsDir = path.join(appDir, 'Contents');
      const macosDir = path.join(contentsDir, 'MacOS');
      const resourcesDir = path.join(contentsDir, 'Resources');
      await fs.mkdir(macosDir, { recursive: true });
      await fs.mkdir(resourcesDir, { recursive: true });

      await fs.writeFile(path.join(contentsDir, 'Info.plist'), installerInfoPlist(version, pkgVersion), 'utf8');
      const executable = path.join(macosDir, 'aftershelf-web-setup');
      await fs.writeFile(executable, installerScript({ version, arch, owner: publish.owner, repo: publish.repo, expectedSha256 }), { mode: 0o755 });
      await buildCompactIcns(assetsDir, path.join(resourcesDir, 'aftershelf.icns'));
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', appDir], { stdio: 'ignore' });

      const dmgPath = path.join(releaseDir, `AfterShelf-Web-Setup-${version}-mac-${arch}.dmg`);
      try {
        execFileSync('hdiutil', [
          'create',
          '-volname', 'AfterShelf Web Setup',
          '-srcfolder', dmgStage,
          '-ov',
          '-format', 'UDZO',
          '-imagekey', 'zlib-level=9',
          dmgPath
        ], { stdio: 'ignore' });
        built.push(dmgPath);
      } catch {
        // Fallback for restricted local sandboxes where hdiutil cannot attach disk images.
        const pkgScriptsDir = path.join(staging, 'pkg-scripts');
        await fs.mkdir(pkgScriptsDir, { recursive: true });
        await fs.writeFile(
          path.join(pkgScriptsDir, 'postinstall'),
          installerScript({ version, arch, owner: publish.owner, repo: publish.repo, expectedSha256, pkgMode: true }),
          { mode: 0o755 }
        );
        const pkgPath = path.join(releaseDir, `AfterShelf-Web-Setup-${version}-mac-${arch}.pkg`);
        execFileSync('pkgbuild', [
          '--nopayload',
          '--scripts', pkgScriptsDir,
          '--identifier', `com.aftershelf.desktop.installer.${arch}`,
          '--version', pkgVersion,
          pkgPath
        ], { stdio: 'ignore' });
        built.push(pkgPath);
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
  return built;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const archIndex = process.argv.indexOf('--arch');
  const arches = archIndex !== -1 && process.argv[archIndex + 1] ? [process.argv[archIndex + 1]] : ['arm64', 'x64'];
  const outputs = await buildMacBootstrap({ arches });
  for (const output of outputs) console.log(`Built macOS Web Setup bootstrap: ${path.relative(rootDir, output)}`);
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extractZip } from '../app/core/archive.mjs';
import { LOCALE_EMULATOR_PROFILE } from '../app/core/launch-locale.mjs';

const url = 'https://github.com/xupefei/Locale-Emulator/releases/download/v2.5.0.1/Locale.Emulator.2.5.0.1.zip';
const sha256 = '808ff584426d52cc775ad6406da00622f454be95bd4c8fbca42eef4b7235ad5c';
const files = ['LEProc.exe', 'LEVersion.xml', 'LoaderDll.dll', 'LocaleEmulator.dll'];
const profile = `<?xml version="1.0" encoding="utf-8"?>
<LEConfig>
  <Profiles>
    <Profile Name="AfterShelf Japanese" Guid="${LOCALE_EMULATOR_PROFILE}" MainMenu="false">
      <Parameter />
      <Location>ja-JP</Location>
      <Timezone>Tokyo Standard Time</Timezone>
      <RunAsAdmin>false</RunAsAdmin>
      <RedirectRegistry>true</RedirectRegistry>
      <IsAdvancedRedirection>false</IsAdvancedRedirection>
      <RunWithSuspend>false</RunWithSuspend>
    </Profile>
  </Profiles>
</LEConfig>
`;

async function stageLocaleEmulator(projectDir, localArchive) {
  const cache = path.join(projectDir, '.cache');
  const destination = path.join(cache, 'locale-emulator');
  const archive = localArchive || path.join(cache, 'locale-emulator-v2.5.0.1.zip');
  await fs.mkdir(cache, { recursive: true });
  let archiveBytes = await fs.readFile(archive).catch(error => {
    if (localArchive || error.code !== 'ENOENT') throw error;
    return null;
  });
  const download = archiveBytes === null;
  if (download) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Could not fetch Locale Emulator v2.5.0.1 (HTTP ${response.status}).`);
    archiveBytes = Buffer.from(await response.arrayBuffer());
  }
  const digest = createHash('sha256').update(archiveBytes).digest('hex');
  if (digest !== sha256) throw new Error(`Locale Emulator archive failed its SHA-256 check: ${archive}`);
  if (download) await fs.writeFile(archive, archiveBytes);
  const staging = await fs.mkdtemp(path.join(cache, 'locale-emulator-'));
  try {
    const extracted = path.join(staging, 'extracted');
    const payload = path.join(staging, 'payload');
    await extractZip(archive, extracted);
    await fs.mkdir(payload);
    for (const file of files) await fs.copyFile(path.join(extracted, file), path.join(payload, file));
    await fs.cp(path.join(projectDir, 'third-party', 'locale-emulator'), payload, { recursive: true });
    await fs.writeFile(path.join(payload, 'LEConfig.xml'), profile);
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(payload, destination);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export default async function beforePack({ electronPlatformName, packager }) {
  if (electronPlatformName === 'win32') await stageLocaleEmulator(packager.projectDir);
}

const script = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  await stageLocaleEmulator(path.resolve(path.dirname(script), '..'), process.argv[2]);
}

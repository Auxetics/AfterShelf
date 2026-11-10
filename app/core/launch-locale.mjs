import { open } from 'node:fs/promises';

export const LOCALE_EMULATOR_PROFILE = '9453db1d-dbb3-45ed-b004-3eace0dd9355';

export function threadSuggestsJapaneseLocale(body) {
  const target = /\b(?:locale[\s_-]*emulator|japanese(?:\s*\(japan\))?\s+(?:system )?locale|(?:system )?locale\s*(?:(?:set )?to|[:=])\s*japanese)\b/i;
  const instruction = /\b(?:requires?|required|needs?|needed|recommend(?:s|ed|ation)?|must|should|use|using|launch(?:es|ed|ing)?|run(?:s|ning)?|play|set|switch|change)\b/i;
  const negated = /\b(?:no need|not (?:required|needed|necessary|recommended)|(?:do|does) not (?:need|require|use)|(?:don['’]t|doesn['’]t) (?:need|require|use)|without)\b/i;
  return body.split(/[\n.!?;]+/).some(line =>
    target.test(line) && !negated.test(line) && (instruction.test(line) || /^\s*locale[\s_-]*emulator\s*:?(?:\s*$)/i.test(line)));
}

// Locale Emulator only supports native 32-bit x86 Windows executables.
export async function isWindowsX86Executable(file) {
  if (!/\.exe$/i.test(file)) return false;
  const handle = await open(file, 'r');
  try {
    const dos = Buffer.alloc(64);
    if ((await handle.read(dos, 0, dos.length, 0)).bytesRead !== dos.length || dos.toString('ascii', 0, 2) !== 'MZ') return false;
    const offset = dos.readUInt32LE(60);
    const pe = Buffer.alloc(26);
    if (offset < dos.length || (await handle.read(pe, 0, pe.length, offset)).bytesRead !== pe.length) return false;
    return pe.readUInt32LE(0) === 0x4550 && pe.readUInt16LE(4) === 0x14c && pe.readUInt16LE(24) === 0x10b;
  } finally {
    await handle.close();
  }
}

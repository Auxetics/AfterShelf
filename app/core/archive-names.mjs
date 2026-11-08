export function archiveTitle(filename = '') {
  return String(filename).replace(/(?:\.part\d+)?\.(?:zip|7z|rar|tar(?:\.(?:gz|bz2|xz))?|tgz|tbz2|txz)(?:\.\d{3})?$/i, '').replace(/[_]+/g, ' ').trim().slice(0, 200) || 'Downloaded game';
}
export function isArchiveName(filename) { return /\.(?:zip|7z|rar|tar(?:\.(?:gz|bz2|xz))?|tgz|tbz2|txz)(?:\.001)?$/i.test(filename) && !/\.part(?:[2-9]|\d{2,})\.rar$/i.test(filename); }

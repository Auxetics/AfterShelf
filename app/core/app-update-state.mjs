// Shared by the sandboxed renderer and the main process.
export function displayAppVersion(version) {
  return String(version ?? '')
    .trim()
    .replace(/^v(?=\d)/i, '')
    .replace(/^(\d+\.\d+)\.0(-(alpha|beta)(?:[.-].*)?)$/i, '$1$2');
}

export function restartBlockReason(state, {
  activeDownloads = 0,
  activeInstallations = 0,
  activeDetailScans = 0,
  activeLibraryScan = false
} = {}) {
  if (
    activeDownloads > 0 ||
    state?.downloads?.some(job => ['queued', 'downloading', 'retrying'].includes(job.status))
  ) {
    return 'Wait for active downloads to finish before restarting to update.';
  }
  if (
    activeInstallations > 0 ||
    state?.downloads?.some(job => job.status === 'installing')
  ) {
    return 'Wait for active game updates or installations to finish before restarting.';
  }
  if (
    state?.scan?.active ||
    Object.values(state?.sourceScans || {}).some(scan => scan?.active) ||
    Object.values(state?.sourceStatus || {}).some(status => status?.active)
  ) {
    return 'Wait for active update checks or site syncs to finish before restarting.';
  }
  if (
    activeDetailScans > 0 ||
    state?.detailScan?.active ||
    activeLibraryScan ||
    state?.libraryScan?.active
  ) {
    return 'Wait for active scans to finish before restarting to update.';
  }
  return '';
}

const active = ['downloading', 'queued', 'retrying', 'installing'];
const completed = ['installed', 'removed'];

export function downloadGroup(job) {
  if (active.includes(job.status)) return 'active';
  if (completed.includes(job.status) && (!job.path || job.archiveRemoved || job.status === 'removed')) return 'completed';
  return 'attention';
}
export function downloadProgress(job) {
  return job.total > 0 ? Math.max(0, Math.min(100, Math.floor((job.received || 0) * 100 / job.total))) : null;
}
export function downloadLabel(job) {
  if (job.status === 'installing') return job.phase || 'Installing';
  if (job.status === 'downloading' && job.error) return 'Connection interrupted';
  const labels = {
    downloading: 'Downloading', queued: 'Queued', retrying: 'Retrying',
    downloaded: 'Ready to install', 'awaiting-folder': job.extractedPath ? 'Ready to finish' : 'Choose extracted folder',
    failed: 'Download failed', cancelled: 'Cancelled', installed: job.archiveRemoved ? 'Installed' : 'Archive cleanup pending', removed: 'Game removed'
  };
  return labels[job.status] || job.status;
}
export function currentGameDownload(jobs) {
  return jobs.find(job => downloadGroup(job) === 'active') || jobs.find(job => ['downloaded', 'awaiting-folder', 'failed'].includes(job.status));
}

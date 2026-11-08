export function manualInstallReason(job, engine) {
  if (engine === 'custom' || !engine) return 'Unknown engines require manual installation. Open the extraction app, then use Locate installed game.';
  if (job.releaseType === 'patch' || /(?:^|[\s_.-])(?:patch|hotfix|update-only)(?=$|[\s_.-])/i.test(job.filename || '')) return 'Patches require manual installation. Download a full release for assisted updates.';
  return '';
}

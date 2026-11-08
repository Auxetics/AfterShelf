import { normalizeVersion, versionKnown, versionRelation } from './model.mjs';

export function checkInstalledVersion(localMetadata, forumVersion) {
  const local = versionKnown(localMetadata.version) ? normalizeVersion(localMetadata.version) : '';
  const forum = versionKnown(forumVersion) ? normalizeVersion(forumVersion) : '';
  if (!local) return { status: 'unverified', local, forum, message: 'Installed. This release has no readable local version metadata; version parity could not be verified.' };
  if (!forum) return { status: 'unverified', local, forum, message: `Installed ${local}. The linked forum version is unavailable for comparison.` };
  if (versionRelation(local, forum) === 'same') return { status: 'matched', local, forum, message: `Installed ${local} · matches the linked forum release.` };
  return { status: 'mismatch', local, forum, message: `Installed ${local} · linked forum release is ${forum}. The downloaded release does not match.` };
}

export function remotePreferences(session, preferences = {}) {
  return { ...preferences, session, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webviewTag: false, preload: undefined, webSecurity: true, allowRunningInsecureContent: false, safeDialogs: true, navigateOnDragDrop: false };
}

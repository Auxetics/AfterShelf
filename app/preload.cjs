const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('library', Object.freeze({
  call: (action, input) => ipcRenderer.invoke('library:action', action, input),
  onState: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('library:state', listener); return () => ipcRenderer.removeListener('library:state', listener); },
  onBrowser: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('library:browser', listener); return () => ipcRenderer.removeListener('library:browser', listener); },
  onNotice: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('library:notice', listener); ipcRenderer.on('library:storage-error', listener);
    return () => { ipcRenderer.removeListener('library:notice', listener); ipcRenderer.removeListener('library:storage-error', listener); };
  }
}));

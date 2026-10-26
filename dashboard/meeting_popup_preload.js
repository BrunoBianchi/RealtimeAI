const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the "meeting detected" popup only (src/meeting_popup.html).
contextBridge.exposeInMainWorld('rtaiPopup', {
  onData: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('popup:data', handler);
    return () => ipcRenderer.removeListener('popup:data', handler);
  },
  ready: () => ipcRenderer.send('popup:ready'),
  start: (agentId) => ipcRenderer.invoke('popup:start', { agentId }),
  stop: () => ipcRenderer.invoke('popup:stop'),
  dismiss: (opts) => ipcRenderer.send('popup:dismiss', opts || {}),
  openDashboard: () => ipcRenderer.send('popup:open-dashboard'),
  resize: (height) => ipcRenderer.send('popup:resize', height)
});

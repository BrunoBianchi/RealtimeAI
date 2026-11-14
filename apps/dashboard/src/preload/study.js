const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lipcueStudy', {
  bootstrap: () => ipcRenderer.invoke('rtai:study-bootstrap'),
  request: (method, route, body, key) => ipcRenderer.invoke('rtai:study-request', method, route, body, key),
  cancel: (key) => ipcRenderer.send('rtai:study-cancel', key),
  onChunk: (key, callback) => {
    const listener = (_event, id, text) => { if (id === key) callback(text); };
    ipcRenderer.on('rtai:study-chunk', listener);
    return () => ipcRenderer.removeListener('rtai:study-chunk', listener);
  },
  onAccount: (callback) => {
    const listener = (_event, account) => callback(account);
    ipcRenderer.on('rtai:study-account', listener);
    return () => ipcRenderer.removeListener('rtai:study-account', listener);
  },
  navigate: (target) => ipcRenderer.send('rtai:study-navigate', target),
});

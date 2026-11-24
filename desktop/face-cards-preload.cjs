const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('faceCardsApi', {
  api: (path, init) => ipcRenderer.invoke('panel:api', path, init || {}),
  fileUrl: path => ipcRenderer.invoke('face-cards:file-url', path),
})

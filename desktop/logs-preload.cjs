const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('logsApi', {
  listFiles: () => ipcRenderer.invoke('logs:list'),
  readFrom: (name, offset) => ipcRenderer.invoke('logs:read', name, offset),
  openDir: () => ipcRenderer.invoke('logs:open-dir'),
})
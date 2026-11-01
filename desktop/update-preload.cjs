const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('updaterApi', {
  onState: cb => {
    const handler = (_event, state) => cb(state)
    ipcRenderer.on('update:state', handler)
    return () => ipcRenderer.removeListener('update:state', handler)
  },
  cancel: () => ipcRenderer.invoke('update:cancel'),
  retry: () => ipcRenderer.invoke('update:retry'),
  install: () => ipcRenderer.invoke('update:install'),
  openFolder: () => ipcRenderer.invoke('update:open-folder'),
  openPage: () => ipcRenderer.invoke('update:open-page'),
})
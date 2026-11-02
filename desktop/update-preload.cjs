const { contextBridge, ipcRenderer } = require('electron')

/**
 * 更新窗口只做展示，动作一律转交主进程：
 * 渲染进程不碰下载字节数，也不自己判断有没有新版本。
 */
contextBridge.exposeInMainWorld('updaterApi', {
  onState: cb => {
    const handler = (_event, state) => cb(state)
    ipcRenderer.on('update:state', handler)
    return () => ipcRenderer.removeListener('update:state', handler)
  },
  download: () => ipcRenderer.invoke('update:download'),
  check: () => ipcRenderer.invoke('update:check'),
  resize: height => ipcRenderer.invoke('update:resize', height),
  cancel: () => ipcRenderer.invoke('update:cancel'),
  retry: () => ipcRenderer.invoke('update:retry'),
  install: () => ipcRenderer.invoke('update:install'),
  openFolder: () => ipcRenderer.invoke('update:open-folder'),
  openPage: () => ipcRenderer.invoke('update:open-page'),
})

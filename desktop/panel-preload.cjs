const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('panelApi', {
  // 状态由主进程每两秒推一次；订阅方拿到取消函数，页面卸载时能摘掉监听
  onState: cb => {
    const handler = (_event, state) => cb(state)
    ipcRenderer.on('panel:state', handler)
    return () => ipcRenderer.removeListener('panel:state', handler)
  },
  action: (name, payload) => ipcRenderer.invoke('panel:action', name, payload),
  api: (path, init) => ipcRenderer.invoke('panel:api', path, init || {}),
})
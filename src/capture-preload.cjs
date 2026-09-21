const { contextBridge, ipcRenderer } = require('electron');
const channels = ['quick:toggle', 'quick:hide', 'quick:save', 'capture:start', 'capture:get', 'capture:recognize', 'capture:save', 'capture:discard', 'capture:login', 'capture:permissions', 'float:drag-start', 'float:drag', 'float:drag-end', 'float:menu'];
contextBridge.exposeInMainWorld('pikuCapture', {
  call: (channel, data) => { if (!channels.includes(channel)) throw new Error('未知操作'); return ipcRenderer.invoke(channel, data); },
  onFocus: callback => ipcRenderer.on('quick:focus', callback),
  onState: callback => ipcRenderer.on('capture:state', (_event, data) => callback(data))
});

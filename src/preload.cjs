const { contextBridge, ipcRenderer } = require('electron');
const channels = ['state:get', 'auth:refresh', 'auth:login', 'auth:cancel', 'auth:logout', 'task:add', 'task:update', 'task:remove', 'ai:extract', 'ai:review', 'action:execute', 'action:cancel', 'draft:reveal', 'settings:save', 'notification:test'];
contextBridge.exposeInMainWorld('piku', {
  call: (channel, data) => {
    if (!channels.includes(channel)) throw new Error('未知操作');
    return ipcRenderer.invoke(channel, data);
  },
  onState: callback => ipcRenderer.on('state', (_event, state) => callback(state)),
  onNotice: callback => ipcRenderer.on('notice', (_event, message) => callback(message))
});

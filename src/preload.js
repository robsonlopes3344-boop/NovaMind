const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nova', {
  desktopEnable: enabled => ipcRenderer.invoke('desktop:enable', enabled),
  desktopCapture: () => ipcRenderer.invoke('desktop:capture'),
  desktopAction: action => ipcRenderer.invoke('desktop:action', action),
  ollamaTags: base => ipcRenderer.invoke('ollama:tags', base),
  ollamaChat: payload => ipcRenderer.invoke('ollama:chat', payload),
  providerChat: payload => ipcRenderer.invoke('provider:chat', payload),
  onProviderProgress: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('provider:progress', listener);
    return () => ipcRenderer.removeListener('provider:progress', listener);
  },
  cancelProviderChat: requestId => ipcRenderer.invoke('provider:cancel', requestId),
  webSearch: query => ipcRenderer.invoke('web:search', query),
  webFetch: url => ipcRenderer.invoke('web:fetch', url),
  hermesModels: payload => ipcRenderer.invoke('hermes:models', payload),
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  setPermission: mode => ipcRenderer.invoke('permissions:set', mode),
  listConversations: () => ipcRenderer.invoke('conversations:list'),
  getConversation: id => ipcRenderer.invoke('conversations:get', id),
  saveConversation: conversation => ipcRenderer.invoke('conversations:save', conversation),
  deleteConversation: id => ipcRenderer.invoke('conversations:delete', id),
  updateConversationFlags: (id, flags) => ipcRenderer.invoke('conversations:flags', id, flags),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  readFile: path => ipcRenderer.invoke('workspace:read', path),
  writeFile: (path, content) => ipcRenderer.invoke('workspace:write', path, content),
  listFiles: path => ipcRenderer.invoke('workspace:list', path),
  snapshotWorkspace: path => ipcRenderer.invoke('workspace:snapshot', path),
  compareWorkspaceSnapshot: id => ipcRenderer.invoke('workspace:compareSnapshot', id),
  releaseWorkspaceSnapshot: id => ipcRenderer.invoke('workspace:releaseSnapshot', id),
  onFilesystemEvent: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:filesystem-event', listener);
    return () => ipcRenderer.removeListener('agent:filesystem-event', listener);
  },
  runShell: payload => ipcRenderer.invoke('shell:run', payload),
  cancelShell: requestId => ipcRenderer.invoke('shell:cancel', requestId),
  openExternal: url => ipcRenderer.invoke('app:openExternal', url)
});
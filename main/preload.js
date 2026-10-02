'use strict';
/*
 * API Manager - preload (sandboxed).
 * Exposes a minimal, validated bridge. The renderer never gets Node access;
 * API traffic goes to the same-origin loopback proxy via fetch.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apim', {
  isElectron: true,
  appInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  onMenuCommand: (cb) => {
    const listener = (_e, cmd) => {
      try {
        cb(cmd);
      } catch (err) {
        /* renderer error; keep the bridge stable */
      }
    };
    ipcRenderer.on('menu:command', listener);
    return () => ipcRenderer.removeListener('menu:command', listener);
  },
});

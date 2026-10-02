'use strict';
/*
 * API Manager - native application menu (macOS / Windows / Linux).
 * Menu commands are forwarded to the renderer as 'menu:command' events.
 */
const { Menu, app, shell, BrowserWindow } = require('electron');

const DEV = 'manishkumars264@gmail.com';

function buildAppMenu(opts) {
  opts = opts || {};
  const isMac = process.platform === 'darwin';
  const send = (cmd) => {
    if (typeof opts.onCommand === 'function') opts.onCommand(cmd);
  };
  const focusedWindow = () => {
    if (typeof opts.getWindow === 'function') return opts.getWindow();
    return BrowserWindow.getFocusedWindow();
  };
  const dispatch = (cmd) => {
    const w = focusedWindow();
    if (w && !w.isDestroyed()) w.webContents.send('menu:command', cmd);
  };

  const bugReportUrl =
    'mailto:' + DEV +
    '?subject=' + encodeURIComponent('API Manager v' + (app.getVersion ? app.getVersion() : '1.0.0') + ' - bug report') +
    '&body=' + encodeURIComponent(
      'API Manager version:\nApp version:\nOS:\n\nSummary:\n\nDescription:\n\nSteps to reproduce:\n1. \n2. \n3. \n'
    );

  const template = [];

  if (isMac) {
    template.push({
      label: app.name || 'API Manager',
      submenu: [
        { role: 'about', label: 'About API Manager', click: () => dispatch('app:about') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'File',
    submenu: [
      { label: 'New Request Tab', accelerator: 'CmdOrCtrl+T', click: () => dispatch('tab:new') },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => dispatch('tab:close') },
      { type: 'separator' },
      { label: 'Import Postman Collection…', click: () => dispatch('import:collection') },
      { label: 'Import Postman Environment…', click: () => dispatch('import:environment') },
      { label: 'Import cURL Command…', click: () => dispatch('import:curl') },
      { label: 'Restore Workspace Backup…', click: () => dispatch('import:backup') },
      { type: 'separator' },
      { label: 'Export Active Collection…', click: () => dispatch('export:collection') },
      { label: 'Export Environment…', click: () => dispatch('export:environment') },
      { label: 'Save Workspace Backup…', click: () => dispatch('export:backup') },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit', label: 'Quit' },
    ],
  });

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { label: 'Console', accelerator: 'CmdOrCtrl+Shift+U', click: () => dispatch('view:console') },
      { type: 'separator' },
      { role: 'resetZoom', label: 'Actual Size' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Toggle Full Screen' },
      ...(opts.isDev ? [{ type: 'separator' }, { role: 'toggleDevTools', label: 'Toggle Developer Tools' }] : []),
    ],
  });

  template.push({
    label: 'Request',
    submenu: [
      { label: 'Send Request', accelerator: 'CmdOrCtrl+Enter', click: () => dispatch('request:send') },
      { label: 'Duplicate Tab', accelerator: 'CmdOrCtrl+D', click: () => dispatch('tab:duplicate') },
      { type: 'separator' },
      { label: 'Next Tab', accelerator: 'Alt+ArrowRight', click: () => dispatch('tab:next') },
      { label: 'Previous Tab', accelerator: 'Alt+ArrowLeft', click: () => dispatch('tab:prev') },
      { type: 'separator' },
      { label: 'Generate Code Snippet…', accelerator: 'CmdOrCtrl+Shift+X', click: () => dispatch('request:codegen') },
    ],
  });

  template.push({
    label: 'Help',
    submenu: [
      {
        label: 'Documentation',
        click: () => {
          const w = focusedWindow();
          if (w && !w.isDestroyed()) w.webContents.send('menu:command', 'help:docs');
        },
      },
      {
        label: 'Report a Bug…',
        click: () => {
          try {
            shell.openExternal(bugReportUrl);
          } catch (e) {
            /* ignore */
          }
        },
      },
      { type: 'separator' },
      { label: 'About API Manager', click: () => dispatch('app:about') },
    ],
  });

  void send;
  return Menu.buildFromTemplate(template);
}

module.exports = { buildAppMenu };

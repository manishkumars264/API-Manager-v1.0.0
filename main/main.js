'use strict';
/*
 * API Manager - Electron main process.
 *
 * Security posture:
 *   - contextIsolation: true, nodeIntegration: false, sandbox: true
 *   - renderer talks to the world only through the loopback proxy (fetch)
 *     and a minimal, validated contextBridge API (external links, app info)
 *   - all navigation to external pages is blocked; window.open goes to the
 *     system browser
 *   - single-instance lock prevents duplicate app instances / duplicate
 *     proxy servers
 */
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { createProxyServer } = require('./proxy');
const { buildAppMenu } = require('./menu');

const APP_NAME = 'API Manager';
const DEFAULT_PORT = 7317;
const PORT_FILE = 'apimanager-port.json';

let server = null;
let mainWindow = null;

function userDataPath() {
  return path.join(app.getPath('userData'), PORT_FILE);
}

function readSavedPort() {
  try {
    const data = JSON.parse(fs.readFileSync(userDataPath(), 'utf8'));
    return Number.isInteger(data.port) ? data.port : null;
  } catch (e) {
    return null;
  }
}

function savePort(port) {
  try {
    fs.mkdirSync(path.dirname(userDataPath()), { recursive: true });
    fs.writeFileSync(userDataPath(), JSON.stringify({ port, savedAt: new Date().toISOString() }, null, 2));
  } catch (e) {
    /* non-fatal */
  }
}

function isFreePort(port) {
  return new Promise((resolve) => {
    const srv = require('net').createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, '127.0.0.1');
  });
}

/** Check whether our own app is already running on a port (healthz probe). */
function isOurAppOnPort(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 700 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data).app === APP_NAME);
        } catch (e) {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function pickPort() {
  // Prefer the persisted port if it is free or already ours.
  const saved = readSavedPort();
  if (saved) {
    if (await isOurAppOnPort(saved)) {
      // A previous instance is still holding it (should not happen with the
      // single-instance lock); quit instead of running two proxies.
      console.log('[apimanager] port ' + saved + ' still held by previous instance - exiting');
      app.exit(0);
    }
    if (await isFreePort(saved)) return saved;
  }
  for (const p of [DEFAULT_PORT, 7318, 7319, 7320, 7321, 7322, 7323, 7324]) {
    if (await isFreePort(p)) return p;
  }
  // Last resort: ask the OS for any free port (origin changes; data still
  // lives in IndexedDB per origin, so this is a documented limitation).
  const net = require('net');
  const ephemeral = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.once('listening', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.listen(0, '127.0.0.1');
  });
  return ephemeral;
}

async function startServer() {
  const port = await pickPort();
  server = await createProxyServer({ staticDir: path.join(__dirname, '..', 'renderer'), port, host: '127.0.0.1' });
  const addr = server.address();
  if (addr.address !== '127.0.0.1') {
    throw new Error('Proxy bound to non-loopback address ' + addr.address);
  }
  savePort(port);
  console.log('[apimanager] proxy + UI on http://127.0.0.1:' + port);
  return port;
}

async function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    backgroundColor: '#14161c',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: true,
    },
  });

  // Never navigate away from the app origin.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://127.0.0.1:' + port)) e.preventDefault();
  });
  // window.open / target=_blank -> system browser (validated schemes only).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL('http://127.0.0.1:' + port + '/');
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    name: APP_NAME,
    version: app.getVersion(),
    developer: 'Manish Kumar Singh',
    email: 'manishkumars264@gmail.com',
    platform: process.platform,
    isElectron: true,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }));

  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (typeof url !== 'string') return { ok: false, error: 'Invalid URL' };
    if (!/^(https?:|mailto:)/i.test(url)) return { ok: false, error: 'Only http(s) and mailto links are allowed' };
    return shell.openExternal(url).then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message }));
  });

  ipcMain.on('menu:action', (_e, command) => {
    if (mainWindow) mainWindow.webContents.send('menu:command', String(command));
  });

  ipcMain.handle('window:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const isDev = process.argv.includes('--dev') || !app.isPackaged;
    try {
      const port = await startServer();
      Menu.setApplicationMenu(buildAppMenu({ isDev, getWindow: () => mainWindow }));
      registerIpc();
      await createWindow(port);
      if (isDev) {
        // DevTools only in dev mode
        mainWindow.webContents.openDevTools({ mode: 'detach' });
      }
    } catch (e) {
      console.error('[apimanager] fatal startup error:', e);
      try {
        const { dialog } = require('electron');
        dialog.showErrorBox(APP_NAME + ' failed to start', String(e && e.message || e));
      } catch (e2) {
        /* ignore */
      }
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', async () => {
    if (mainWindow === null) {
      try {
        const port = server ? server.address().port : await pickPort();
        await createWindow(port);
      } catch (e) {
        console.error(e);
      }
    }
  });

  app.on('before-quit', () => {
    if (server) {
      try {
        server.close();
      } catch (e) {
        /* ignore */
      }
    }
  });

  // Keep the app resilient: uncaught errors in main should not crash silently.
  process.on('uncaughtException', (e) => {
    console.error('[apimanager] uncaughtException:', e);
  });
}

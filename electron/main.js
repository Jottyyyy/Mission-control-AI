const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');
const { startBackend, stopBackend } = require('./backend-manager');

const isDev = !app.isPackaged || process.env.NODE_ENV === 'development';
const DEV_URL = 'http://localhost:5173';

let mainWindow = null;

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
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
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      role: 'window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Mission Control',
    backgroundColor: '#fafafa',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open external links in the user's default browser, not inside Electron.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Mirror renderer console messages to the main-process stderr so crashes are
  // visible even when the renderer has white-screened. Also surface unhandled
  // renderer errors via crashed / did-fail-load.
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const levels = ['log', 'warn', 'error'];
    process.stderr.write(`[renderer:${levels[level] || level}] ${message}  (${sourceId}:${line})\n`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    process.stderr.write(`[renderer] render-process-gone: ${JSON.stringify(details)}\n`);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    process.stderr.write(`[renderer] did-fail-load ${code} ${desc} ${url}\n`);
  });

  // Auto-open DevTools when MC_DEVTOOLS=1. Keeps packaged builds clean for
  // Adam but lets us flip it on for debugging.
  if (process.env.MC_DEVTOOLS === '1' || isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  if (isDev) {
    mainWindow.loadURL(DEV_URL);
  } else {
    const indexHtml = path.join(__dirname, '..', 'dist', 'index.html');
    mainWindow.loadFile(indexHtml);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function bootstrap() {
  buildMenu();

  const ok = await startBackend({
    onUnexpectedExit: () => {
      if (app.isQuiting) return;
      dialog.showErrorBox(
        'Mission Control',
        'Mission Control backend stopped. Please restart the app.'
      );
      app.isQuiting = true;
      app.quit();
    },
  });

  if (!ok) {
    dialog.showErrorBox(
      'Mission Control',
      `Backend failed to start within 30 seconds.\n\n` +
        `If this is a fresh install, run scripts/mac-setup.sh first to install Python 3.12 and the backend dependencies.`
    );
    app.quit();
    return;
  }

  createWindow();
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  // On macOS apps usually stay alive after window close, but for a single-window
  // utility like this we want a full exit so the backend dies with the UI.
  app.isQuiting = true;
  app.quit();
});

app.on('before-quit', async (event) => {
  if (app.isQuiting) return;
  app.isQuiting = true;
  event.preventDefault();
  await stopBackend();
  app.exit(0);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

#!/usr/bin/env node
// Окно PSBees на Windows (Electron): поднимает тот же локальный сервер,
// что и Linux-версия, и открывает интерфейс в собственном окне.
import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../scripts/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function distRoot() {
  return join(here, '..', 'dist');
}

let mainWindow = null;
let localServer = null;

ipcMain.on('psbees:close-app', (event) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow && senderWindow === mainWindow) senderWindow.close();
});

app.on('before-quit', () => {
  localServer?.close();
  localServer?.closeAllConnections?.();
  localServer = null;
});

function createWindow(url) {
  const icon = join(here, '..', 'build', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    show: false,
    title: 'PSBees — редактор печатных плат',
    icon: existsSync(icon) ? icon : undefined,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  Menu.setApplicationMenu(null);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    shell.openExternal(u);
    return { action: 'deny' };
  });
  const origin = new URL(url).origin;
  mainWindow.webContents.on('will-navigate', (e, u) => {
    if (!u.startsWith(origin)) {
      e.preventDefault();
      shell.openExternal(u);
    }
  });
  return mainWindow.loadURL(url);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    const root = distRoot();
    if (!existsSync(join(root, 'index.html'))) {
      dialog.showErrorBox(
        'PSBees',
        'Не найдена собранная программа (dist/index.html).\n'
        + 'Соберите её командой npm run build или установите PSBees-Setup.exe.',
      );
      app.quit();
      return;
    }
    try {
      const server = await startServer({
        port: Number(process.env.PCB_APP_PORT || 8484),
        host: '127.0.0.1',
        root,
        fallbackPorts: 30,
        cloudDataDir: null, // Electron остаётся персональным офлайн-клиентом, даже если задана переменная окружения сервера
      });
      localServer = server.server;
      await createWindow(server.url);
    } catch (e) {
      dialog.showErrorBox('PSBees', 'Не удалось запустить локальный сервер:\n' + (e?.message || e));
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
}

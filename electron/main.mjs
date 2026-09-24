#!/usr/bin/env node
// Окно PSBees на Windows (Electron): поднимает тот же локальный сервер,
// что и Linux-версия, и открывает интерфейс в собственном окне.
import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../scripts/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function distRoot() {
  return join(here, '..', 'dist');
}

let mainWindow = null;

function createWindow(url) {
  const icon = join(here, '..', 'build', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    show: false,
    title: 'PSBees — редактор печатных плат',
    icon: existsSync(icon) ? icon : undefined,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
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
      const { url } = await startServer({
        port: Number(process.env.PCB_APP_PORT || 8484),
        host: '127.0.0.1',
        root,
        fallbackPorts: 30,
      });
      await createWindow(url);
    } catch (e) {
      dialog.showErrorBox('PSBees', 'Не удалось запустить локальный сервер:\n' + (e?.message || e));
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
}

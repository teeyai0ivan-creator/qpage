/**
 * shell-preload.js — สะพานเชื่อมสำหรับ "แถบเครื่องมือของโปรแกรม" (shell.html)
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qpageShell', {
  nav: (path) => ipcRenderer.send('shell:nav', String(path)),
  reload: () => ipcRenderer.send('shell:reload'),
  zoom: (delta) => ipcRenderer.send('shell:zoom', Number(delta) || 0),
  fullscreen: () => ipcRenderer.send('shell:fullscreen'),
  openSettings: () => ipcRenderer.send('shell:settings'),
  testPrint: () => ipcRenderer.invoke('shell:test-print'),
  toggleTheme: () => ipcRenderer.invoke('shell:toggle-theme'),
  logout: () => ipcRenderer.send('shell:logout'),
  toggleCollapse: () => ipcRenderer.send('shell:collapse-toggle'),
  refreshStatus: () => ipcRenderer.send('shell:status-now'),
  onStatus: (cb) => ipcRenderer.on('shell-status', (event, data) => cb(data)),
  onVisible: (cb) => ipcRenderer.on('shell-visible', (event, on) => cb(on)),
  onCollapsed: (cb) => ipcRenderer.on('shell-collapsed', (event, mini) => cb(mini)),
});

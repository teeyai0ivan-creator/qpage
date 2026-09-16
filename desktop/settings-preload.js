/**
 * settings-preload.js — สะพานเชื่อมสำหรับ "หน้าตั้งค่า" ของโปรแกรม
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qpageSettings', {
  getState: () => ipcRenderer.invoke('settings:get'),
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  listPrinters: () => ipcRenderer.invoke('printers:list'),
  testPrint: (kind) => ipcRenderer.invoke('print:test', kind),
  recentJobs: () => ipcRenderer.invoke('jobs:recent'),
  me: () => ipcRenderer.invoke('me:info'),
  reloadMain: () => ipcRenderer.invoke('app:reload-main'),
  onPrintLog: (cb) => ipcRenderer.on('print-log', (event, entry) => cb(entry)),
});

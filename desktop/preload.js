/**
 * preload.js — สะพานเชื่อมระหว่างหน้าเว็บ (ที่โหลดจากเซิร์ฟเวอร์) กับโปรแกรม
 *
 * เปิดให้หน้าเว็บเรียกได้แค่ "สั่งพิมพ์" เท่านั้น (ไม่เปิดให้เข้าถึงไฟล์/ระบบของเครื่อง)
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qpageDesktop', {
  // หน้าเว็บเรียกแทน window.print() → โปรแกรมจะพิมพ์เงียบไปเครื่องที่ตั้งไว้
  silentPrint: () => ipcRenderer.send('print-now'),
  openSettings: () => ipcRenderer.invoke('app:open-settings'),
  isDesktop: true,
});

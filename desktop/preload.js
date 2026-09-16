/**
 * preload.js — สะพานเชื่อมระหว่าง "เนื้อหาในหน้าต่างโปรแกรม" กับตัวโปรแกรม
 *
 * ใช้กับทั้งหน้าเว็บของระบบ (โหลดจากเซิร์ฟเวอร์) และหน้าจอที่โปรแกรมวาดเอง:
 *  - qpageDesktop : ให้หน้าเว็บสั่งพิมพ์เงียบผ่านโปรแกรม + เปิดหน้าตั้งค่า
 *  - qpageKitchen : ให้หน้าจอครัว/แคชเชียร์ของโปรแกรมเรียกข้อมูลผ่าน main (main ถือ session อยู่)
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qpageDesktop', {
  // หน้าเว็บเรียกแทน window.print() → โปรแกรมจะพิมพ์เงียบไปเครื่องที่ตั้งไว้
  silentPrint: () => ipcRenderer.send('print-now'),
  openSettings: () => ipcRenderer.invoke('app:open-settings'),
  isDesktop: true,
});

// หน้าจอครัว/แคชเชียร์ (ไฟล์ในเครื่อง) — ทุกอย่างผ่าน main เพราะไฟล์ในเครื่องเรียก API ข้ามโดเมนไม่ได้
contextBridge.exposeInMainWorld('qpageKitchen', {
  list: (station) => ipcRenderer.invoke('kitchen:list', station),
  start: (ids) => ipcRenderer.invoke('kitchen:start', ids),
  status: (id, status) => ipcRenderer.invoke('kitchen:status', { id, status }),
  cancel: (id, reason) => ipcRenderer.invoke('kitchen:cancel', { id, reason }),
  printRound: (round) => ipcRenderer.send('kitchen:print-round', round || {}),
  onLive: (cb) => ipcRenderer.on('kitchen:live', (event, state) => cb(state)),
  onEvent: (cb) => ipcRenderer.on('kitchen:event', (event, evt) => cb(evt)),
});

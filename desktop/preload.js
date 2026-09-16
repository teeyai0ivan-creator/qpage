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

// หน้าจอ "ประวัติ" ของโปรแกรม (บิลที่ปิดแล้ว + QR โต๊ะที่ปิดใช้งาน + ประวัติสั่งครัว)
contextBridge.exposeInMainWorld('qpageHistory', {
  bills: (opts) => ipcRenderer.invoke('history:bills', opts || {}),
  prints: (limit) => ipcRenderer.invoke('history:prints', limit),
  retired: () => ipcRenderer.invoke('history:retired'),
  qr: (tableId) => ipcRenderer.invoke('history:qr', tableId),
  saveCsv: (payload) => ipcRenderer.invoke('history:save-csv', payload || {}),
  saveQr: (payload) => ipcRenderer.invoke('history:save-qr', payload || {}),
  reveal: (filePath) => ipcRenderer.send('app:reveal', filePath),
  printReceipt: (payload) => ipcRenderer.send('orders:print-receipt', payload || {}),
  printRound: (payload) => ipcRenderer.send('kitchen:print-round', payload || {}),
  onLive: (cb) => ipcRenderer.on('kitchen:live', (event, state) => cb(state)),
  onEvent: (cb) => ipcRenderer.on('kitchen:event', (event, evt) => cb(evt)),
});

// หน้าจอ "สั่งอาหาร" ของโปรแกรม (ผังโต๊ะ + บิล + เพิ่มอาหาร + เช็คบิล)
contextBridge.exposeInMainWorld('qpageOrders', {
  tables: () => ipcRenderer.invoke('orders:tables'),
  tableNames: () => ipcRenderer.invoke('orders:table-names'),
  createQrForName: (code, zoneId) => ipcRenderer.invoke('orders:create-qr', { code, zoneId }),
  zones: () => ipcRenderer.invoke('orders:zones'),
  openBills: () => ipcRenderer.invoke('orders:open-bills'),
  catalog: () => ipcRenderer.invoke('orders:catalog'),
  addItems: (tableId, items) => ipcRenderer.invoke('orders:add-items', { tableId, items }),
  deleteItem: (itemId) => ipcRenderer.invoke('orders:delete-item', itemId),
  checkout: (tableId) => ipcRenderer.invoke('orders:checkout', tableId),
  addTable: (code, zoneId) => ipcRenderer.invoke('orders:add-table', { code, zoneId }),
  addZone: (name) => ipcRenderer.invoke('orders:add-zone', name),
  printReceipt: (payload) => ipcRenderer.send('orders:print-receipt', payload || {}),
  onLive: (cb) => ipcRenderer.on('kitchen:live', (event, state) => cb(state)),
  onEvent: (cb) => ipcRenderer.on('kitchen:event', (event, evt) => cb(evt)),
});


/**
 * preload.js — สะพานเชื่อมระหว่าง "เนื้อหาในหน้าต่างโปรแกรม" กับตัวโปรแกรม
 *
 * ใช้กับทั้งหน้าเว็บของระบบ (โหลดจากเซิร์ฟเวอร์) และหน้าจอที่โปรแกรมวาดเอง:
 *  - qpageDesktop : ให้หน้าเว็บสั่งพิมพ์เงียบผ่านโปรแกรม + เปิดหน้าตั้งค่า
 *  - qpageKitchen : ให้หน้าจอครัว/แคชเชียร์ของโปรแกรมเรียกข้อมูลผ่าน main (main ถือ session อยู่)
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// หน้าจอเข้าสู่ระบบของโปรแกรม (บัญชีต้องมีร้าน + แพ็กเกจที่ยังไม่หมดอายุ)
contextBridge.exposeInMainWorld('qpageLogin', {
  state: () => ipcRenderer.invoke('login:state'),
  login: (payload) => ipcRenderer.invoke('login:do', payload || {}),
  logout: () => ipcRenderer.invoke('login:logout'),
  recheck: () => ipcRenderer.invoke('login:state'),
  enterApp: () => ipcRenderer.invoke('login:enter'),
  openPurchase: () => ipcRenderer.invoke('login:open-purchase'),
});

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

// ให้หน้าจอของโปรแกรมพาไปหน้าอื่นในโปรแกรม (ไม่ใช่เปิดเว็บ) — เช่น ปุ่ม "ดูประวัติ"
contextBridge.exposeInMainWorld('qpageNav', {
  go: (path) => ipcRenderer.send('nav:go', String(path || '')),
});

// หน้าจอจัดการร้านของโปรแกรม (ข้อมูลร้าน · หมวดหมู่/เมนู/ตัวเลือก · แจ้งเตือน · ตั้งค่าระบบ)
contextBridge.exposeInMainWorld('qpageShop', {
  all: () => ipcRenderer.invoke('shop:all'),
  save: (fields) => ipcRenderer.invoke('shop:save', fields || {}),
  upload: (dataUrl) => ipcRenderer.invoke('shop:upload', dataUrl),
  imageData: (path) => ipcRenderer.invoke('shop:image-data', path),
  addCategory: (fields) => ipcRenderer.invoke('shop:add-category', fields || {}),
  updateCategory: (id, fields) => ipcRenderer.invoke('shop:update-category', { id, fields }),
  deleteCategory: (id) => ipcRenderer.invoke('shop:delete-category', id),
  addMenu: (fields) => ipcRenderer.invoke('shop:add-menu', fields || {}),
  updateMenu: (id, fields) => ipcRenderer.invoke('shop:update-menu', { id, fields }),
  deleteMenu: (id) => ipcRenderer.invoke('shop:delete-menu', id),
  setMenuGroups: (id, groupIds) => ipcRenderer.invoke('shop:set-menu-groups', { id, groupIds }),
  addOptionGroup: (fields) => ipcRenderer.invoke('shop:add-option-group', fields || {}),
  updateOptionGroup: (id, fields) => ipcRenderer.invoke('shop:update-option-group', { id, fields }),
  deleteOptionGroup: (id) => ipcRenderer.invoke('shop:delete-option-group', id),
  addOptionItem: (groupId, fields) => ipcRenderer.invoke('shop:add-option-item', { groupId, fields }),
  updateOptionItem: (id, fields) => ipcRenderer.invoke('shop:update-option-item', { id, fields }),
  deleteOptionItem: (id) => ipcRenderer.invoke('shop:delete-option-item', id),
  notifyGroups: () => ipcRenderer.invoke('notify:groups'),
  addNotifyGroup: (fields) => ipcRenderer.invoke('notify:add', fields || {}),
  updateNotifyGroup: (id, fields) => ipcRenderer.invoke('notify:update', { id, fields }),
  deleteNotifyGroup: (id) => ipcRenderer.invoke('notify:delete', id),
  setQrAutoDelete: (enabled) => ipcRenderer.invoke('sys:set-qr-auto-delete', enabled),
  printReceipt: (payload) => ipcRenderer.send('orders:print-receipt', payload || {}),
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


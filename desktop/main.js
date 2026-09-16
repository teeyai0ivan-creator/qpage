/**
 * main.js — โปรแกรมร้านค้า QPage สำหรับ Windows (Electron)
 *
 * ทำอะไร
 *   1) เปิดหน้าจอระบบร้าน (สั่งอาหาร/ครัว/แคชเชียร์/ประวัติ) ในหน้าต่างโปรแกรม ไม่มีแถบเบราว์เซอร์
 *   2) "ดัก" การพิมพ์ของหน้าเว็บ (window.print) แล้วพิมพ์เงียบไปเครื่องพิมพ์ที่ตั้งไว้
 *      — รองรับใบสั่งครัว / ใบเสร็จ / ป้าย QR แยกเครื่องพิมพ์และขนาดกระดาษได้
 *   3) เป็น "ตัวช่วยพิมพ์" ให้มือถือ/แท็บเล็ต: รับงานจากเซิร์ฟเวอร์มาพิมพ์ที่เครื่องนี้ (ดู lib/agent.js)
 *
 * ค่าตั้งทั้งหมดอยู่ในไฟล์ settings.json (ดู lib/settings.js) — แก้ผ่านหน้าตั้งค่าในโปรแกรม
 */
'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell, dialog, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const settingsLib = require('./lib/settings');
const printLib = require('./lib/print');
const { PrintAgent, PRINT_WAIT_MS } = require('./lib/agent');

const PARTITION = 'persist:qpage';     // เก็บคุกกี้/session ถาวร → ล็อกอินครั้งเดียวใช้ได้ยาว
const ARGS = process.argv.slice(1);
const SELFTEST = ARGS.includes('--selftest');
const argValue = (name) => {
  const hit = ARGS.find((a) => a.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : '';
};

let mainWindow = null;
let settingsWindow = null;
let agent = null;
const printLog = [];                    // ประวัติการพิมพ์ในเครื่องนี้ (ให้หน้าตั้งค่าแสดง)
const pendingJobs = new Map();          // webContents.id → { job, resolve, timer }

// ---------------------------------------------------------------------------
// ดักการพิมพ์ของหน้าเว็บ
// ---------------------------------------------------------------------------
// แทน window.print ของหน้าเว็บด้วยการเรียกเข้าโปรแกรม (แทรกหลัง DOM พร้อม ก่อนหน้าเว็บสั่งพิมพ์ ~500ms)
const HOOK_JS = `(() => {
  if (window.__qpagePrintHooked) return 'already';
  window.__qpagePrintHooked = true;
  const native = window.print ? window.print.bind(window) : null;
  window.print = function () {
    try {
      if (window.qpageDesktop && window.qpageDesktop.silentPrint) { window.qpageDesktop.silentPrint(); return; }
    } catch (e) { /* ตกไปใช้กล่องพิมพ์ปกติ */ }
    if (native) return native();
  };
  return 'hooked';
})()`;

function installHook(contents) {
  contents.executeJavaScript(HOOK_JS, true).catch(() => { /* หน้าอาจยังไม่พร้อม — dom-ready ครั้งถัดไปจะลองใหม่ */ });
}

function addPrintLog(entry) {
  printLog.unshift(Object.assign({ at: Date.now() }, entry));
  if (printLog.length > 30) printLog.pop();
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('print-log', printLog[0]);
}

/** พิมพ์เนื้อหาของ webContents หนึ่ง ๆ ตามชนิดเอกสาร + ค่าตั้ง */
async function printContents(kind, contents, silentOverride) {
  const settings = settingsLib.get();
  const result = await printLib.printContents(contents, kind, settings, silentOverride);
  addPrintLog({
    kind, ok: result.success, reason: result.reason || '',
    device: result.device, paper: result.paper, url: contents.getURL(),
  });
  if (!result.success) console.error(`🖨 พิมพ์${printLib.KIND_LABEL[kind] || ''}ไม่สำเร็จ: ${result.reason}`);
  else console.log(`🖨 พิมพ์${printLib.KIND_LABEL[kind] || ''} → ${result.device} (${result.paper})`);
  return result;
}

// ---------------------------------------------------------------------------
// หน้าต่างหลัก
// ---------------------------------------------------------------------------
function createMainWindow() {
  const s = settingsLib.get();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'QPage Shop — ระบบร้านค้า',
    backgroundColor: '#f4f5fb',
    autoHideMenuBar: false,
    fullscreen: !!s.fullscreen,
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(s.serverUrl);
  mainWindow.webContents.on('dom-ready', () => installHook(mainWindow.webContents));
  // หน้าเว็บเปิด "แท็บใหม่" ผ่าน window.open (ใบสั่งครัว/ใบเสร็จ/ป้าย QR)
  // → ให้ Electron สร้างหน้าต่างให้ แต่ต้องใช้ preload + session ชุดเดียวกัน เพื่อให้ดักพิมพ์ได้เหมือนกัน
  mainWindow.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      width: 900,
      height: 1200,
      title: 'QPage Shop',
      webPreferences: {
        partition: PARTITION,
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    },
  }));
  // หน้าต่างที่ถูกสร้างใหม่ (รวมกรณีเปิด about:blank แล้วค่อยเปลี่ยนที่อยู่) → ติดตั้งตัวดักพิมพ์ทุกครั้งที่โหลดเสร็จ
  mainWindow.webContents.on('did-create-window', (child) => {
    child.webContents.on('dom-ready', () => installHook(child.webContents));
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 900,
    height: 860,
    title: 'ตั้งค่าโปรแกรมพิมพ์',
    parent: mainWindow || undefined,
    backgroundColor: '#f4f5fb',
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ---------------------------------------------------------------------------
// เมนูโปรแกรม
// ---------------------------------------------------------------------------
function buildMenu() {
  const go = (url) => () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(settingsLib.get().serverUrl.replace(/\/+$/, '') + url); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'ไฟล์',
      submenu: [
        { label: 'ตั้งค่าเครื่องพิมพ์…', accelerator: 'CmdOrCtrl+,', click: createSettingsWindow },
        { type: 'separator' },
        { label: 'ออกจากโปรแกรม', role: 'quit' },
      ],
    },
    {
      label: 'มุมมอง',
      submenu: [
        { label: 'รีเฟรช', accelerator: 'F5', click: () => mainWindow && mainWindow.reload() },
        { label: 'ย้อนกลับ', accelerator: 'Alt+Left', click: () => mainWindow && mainWindow.webContents.navigationHistory.goBack() },
        { type: 'separator' },
        { label: 'ซูมเข้า', role: 'zoomIn' },
        { label: 'ซูมออก', role: 'zoomOut' },
        { label: 'ขนาดปกติ', role: 'resetZoom' },
        { type: 'separator' },
        { label: 'เต็มจอ', accelerator: 'F11', click: () => { if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen()); } },
      ],
    },
    {
      label: 'ไปหน้า',
      submenu: [
        { label: 'หน้าแรกของเว็บ', click: go('/') },
        { label: 'สั่งอาหาร', click: go('/shop/orders.html') },
        { label: 'ครัว', click: go('/shop/kitchen.html') },
        { label: 'แคชเชียร์', click: go('/shop/cashier.html') },
        { label: 'ประวัติ', click: go('/shop/history.html') },
        { label: 'ประวัติสั่งครัว', click: go('/shop/kitchen-history.html') },
        { type: 'separator' },
        { label: 'เปิดในเบราว์เซอร์ปกติ', click: () => shell.openExternal(settingsLib.get().serverUrl) },
      ],
    },
    {
      label: 'ช่วยเหลือ',
      submenu: [
        {
          label: 'เกี่ยวกับโปรแกรม',
          click: () => dialog.showMessageBox(mainWindow || undefined, {
            type: 'info',
            title: 'เกี่ยวกับ QPage Shop',
            message: 'QPage Shop ' + app.getVersion(),
            detail: 'โปรแกรมร้านค้าสำหรับ Windows\nที่อยู่เซิร์ฟเวอร์: ' + settingsLib.get().serverUrl
              + '\nไฟล์ตั้งค่า: ' + settingsLib.file()
              + '\n\nการพิมพ์: ' + (settingsLib.get().silent ? 'พิมพ์เงียบ (ไม่ขึ้นกล่องยืนยัน)' : 'แสดงกล่องพิมพ์ของเบราว์เซอร์')
              + '\nตัวช่วยพิมพ์ให้มือถือ/แท็บเล็ต: ' + (agent && agent.kinds().length ? 'เปิด' : 'ปิด'),
            buttons: ['ตกลง'],
          }),
        },
        {
          label: 'เปิดโฟลเดอร์ตั้งค่า',
          click: () => shell.openPath(settingsLib.dir()),
        },
      ],
    },
  ]));
}

// ---------------------------------------------------------------------------
// IPC — ให้หน้าเว็บ/หน้าตั้งค่าเรียกใช้
// ---------------------------------------------------------------------------
ipcMain.on('print-now', async (event) => {
  const contents = event.sender;
  const kind = printLib.detectKind(contents.getURL());
  const result = await printContents(kind, contents);
  // ถ้าเป็นการพิมพ์งานที่มาจากคิว (หน้าต่างซ่อน) → ส่งผลกลับให้ตัวช่วยพิมพ์รายงานต่อ
  const pending = pendingJobs.get(contents.id);
  if (pending) {
    pendingJobs.delete(contents.id);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }
});

ipcMain.handle('printers:list', async () => {
  const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow : settingsWindow;
  if (!target) return [];
  try {
    const list = await target.webContents.getPrintersAsync();
    return (list || []).map((p) => ({
      name: p.name,                 // ชื่อระบบ — ใช้เป็น deviceName ตอนพิมพ์
      displayName: p.displayName || p.name,
      isDefault: !!p.isDefault,
      status: p.status || 0,
    }));
  } catch (err) {
    return [];
  }
});

ipcMain.handle('settings:get', () => {
  const s = settingsLib.get();
  return {
    settings: s,
    file: settingsLib.file(),
    version: app.getVersion(),
    printers: [],
    log: printLog.slice(0, 10),
    agentActive: !!(agent && agent.kinds().length),
  };
});

ipcMain.handle('settings:save', (event, patch) => {
  const before = settingsLib.get();
  const after = settingsLib.save(patch || {});
  // เปลี่ยนที่อยู่เซิร์ฟเวอร์ → เปิดหน้าใหม่
  if (patch && patch.serverUrl && patch.serverUrl !== before.serverUrl && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(after.serverUrl);
  }
  // เปิด/ปิดตัวช่วยพิมพ์ตามค่าใหม่
  if (agent) { agent.stop(); if (agent.kinds().length) agent.start(); }
  applyAutoStart(after);
  return { settings: after };
});

ipcMain.handle('print:test', async (event, kind) => {
  const k = ['ticket', 'receipt', 'label', 'other'].includes(kind) ? kind : 'ticket';
  const win = new BrowserWindow({
    show: false, width: 900, height: 1200,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadFile(path.join(__dirname, 'test-ticket.html'), { query: { kind: k, t: String(Date.now()) } });
    await new Promise((r) => setTimeout(r, 300));
    return await printContents(k, win.webContents);
  } catch (err) {
    return { success: false, reason: err.message };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
});

ipcMain.handle('jobs:recent', async () => {
  const sess = session.fromPartition(PARTITION);
  const base = String(settingsLib.get().serverUrl || '').replace(/\/+$/, '');
  try {
    const res = await sess.fetch(base + '/api/shop/print-jobs?history=1&limit=20', {
      headers: { 'X-QPage-Device': settingsLib.get().deviceId },
    });
    if (!res.ok) return { ok: false, status: res.status, jobs: [] };
    const data = await res.json();
    return { ok: true, jobs: (data && data.jobs) || [] };
  } catch (err) {
    return { ok: false, error: err.message, jobs: [] };
  }
});

ipcMain.handle('me:info', async () => {
  const sess = session.fromPartition(PARTITION);
  const base = String(settingsLib.get().serverUrl || '').replace(/\/+$/, '');
  try {
    const res = await sess.fetch(base + '/api/me', { headers: { 'X-QPage-Device': settingsLib.get().deviceId } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) return { loggedIn: false };
    return { loggedIn: true, email: data.user.email, role: data.user.role, name: (data.shop && data.shop.name) || '' };
  } catch (err) {
    return { loggedIn: false, error: err.message };
  }
});

ipcMain.handle('app:open-settings', () => createSettingsWindow());
ipcMain.handle('app:reload-main', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload(); });

// ---------------------------------------------------------------------------
// ตัวช่วยพิมพ์ (รับงานจากมือถือ/แท็บเล็ต)
// ---------------------------------------------------------------------------
function startAgent() {
  if (!agent) {
    agent = new PrintAgent({
      getSettings: () => settingsLib.get(),
      session: () => session.fromPartition(PARTITION),
      onLog: (msg) => addPrintLog({ kind: 'agent', ok: true, reason: msg, device: '', paper: '' }),
      // หน้าต่างซ่อนของงานหนึ่ง ๆ: ดักการพิมพ์แล้วรอผล
      attachPrintHook: (contents, job) => new Promise((resolve) => {
        const id = contents.id;
        const timer = setTimeout(() => {
          if (pendingJobs.has(id)) {
            pendingJobs.delete(id);
            resolve({ success: false, reason: `หน้าเว็บไม่สั่งพิมพ์ภายใน ${Math.round(PRINT_WAIT_MS / 1000)} วินาที` });
          }
        }, PRINT_WAIT_MS);
        pendingJobs.set(id, { job, resolve, timer });
        installHook(contents);
      }),
    });
  }
  agent.stop();
  agent.start();
}

// เพิ่มรหัสเครื่องให้ทุกคำขอที่ออกจากโปรแกรม (ให้เซิร์ฟเวอร์รู้ว่าคำสั่งนี้มาจากเครื่องที่พิมพ์เอง → ไม่ต้องส่งงานกลับมา)
function wireDeviceHeader() {
  const sess = session.fromPartition(PARTITION);
  sess.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      details.requestHeaders['X-QPage-Device'] = settingsLib.get().deviceId;
    } catch (e) { /* ข้าม */ }
    callback({ requestHeaders: details.requestHeaders });
  });
}

function applyAutoStart(s) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!s.autoStart, path: process.execPath, args: [] });
  } catch (err) { console.error('ตั้งค่าเปิดพร้อมเครื่องไม่สำเร็จ:', err.message); }
}

// ---------------------------------------------------------------------------
// โหมดทดสอบตัวเอง (ใช้ตรวจสอบตอนพัฒนา): npm run selftest
// ---------------------------------------------------------------------------
async function runSelfTest() {
  const out = { ok: true, steps: [] };
  const push = (name, data) => { out.steps.push(Object.assign({ name }, data)); };

  const s = settingsLib.get();
  push('settings', { serverUrl: s.serverUrl, silent: s.silent, deviceIdSet: !!s.deviceId, printers: s.printers, kinds: s.kinds });

  const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { contextIsolation: true } });
  const printers = await win.webContents.getPrintersAsync().catch(() => []);
  push('printers', { count: printers.length, list: printers.map((p) => ({ name: p.name, displayName: p.displayName, isDefault: !!p.isDefault })) });

  // 1) เรนเดอร์ใบสั่งครัวตัวอย่าง แล้วออกเป็น PDF (ตรวจว่าหน้าพิมพ์มาถูกและขนาดกระดาษตรงกับที่ตั้งไว้)
  await win.loadFile(path.join(__dirname, 'test-ticket.html'), { query: { kind: 'ticket', t: 'selftest' } });
  await new Promise((r) => setTimeout(r, 400));
  const pdf80 = await win.webContents.printToPDF({ usePrinterDefaultPageSize: true, margins: { marginType: 'none' }, printBackground: true });
  const pdfA4 = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
  const mediaBox = (buf) => {
    const txt = buf.toString('latin1');
    const m = txt.match(/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    if (!m) return null;
    const w = (Number(m[3]) - Number(m[1])) / 72 * 25.4;   // pt → mm
    const h = (Number(m[4]) - Number(m[2])) / 72 * 25.4;
    return { widthMM: Math.round(w * 10) / 10, heightMM: Math.round(h * 10) / 10 };
  };
  push('printToPDF', {
    ticketRoll: { bytes: pdf80.length, page: mediaBox(pdf80) },
    a4: { bytes: pdfA4.length, page: mediaBox(pdfA4) },
    hasHeaderText: pdf80.length > 2000,
  });

  // 2) ดักการพิมพ์: หน้าที่เรียก window.print() ต้องถูกดักและส่งเข้าโปรแกรม (ใช้โหมดทดสอบ = ไม่ยิงเข้าปริ้นเตอร์จริง)
  const probe = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  let hookFired = 0;
  probe.webContents.on('dom-ready', () => installHook(probe.webContents));
  ipcMain.removeAllListeners('print-now');
  ipcMain.on('print-now', () => { hookFired++; });
  await probe.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<h1>ทดสอบการดักพิมพ์</h1><script>setTimeout(function(){window.print();},100);</script>'));
  await new Promise((r) => setTimeout(r, 900));
  const stillHooked = await probe.webContents.executeJavaScript('!!window.__qpagePrintHooked', true).catch(() => false);
  push('printHook', { fired: hookFired, installed: !!stillHooked });
  if (!stillHooked || hookFired < 1) out.ok = false;

  // 3) พิมพ์จริงแบบเงียบ (ถ้าระบุเครื่องปลายทางมา) — ใช้ตรวจกับเครื่องพิมพ์จริง/เสมือน
  const target = argValue('--print-to');
  if (target) {
    const r = await printLib.printContents(win.webContents, 'ticket', Object.assign({}, s, { printers: Object.assign({}, s.printers, { ticket: { device: target, paper: 'auto' } }) }), true, 20000);
    push('silentPrint', Object.assign({ target }, r));
    if (!r.success) out.ok = false;
  } else {
    push('silentPrint', { skipped: 'ไม่ได้ระบุ --print-to=<ชื่อเครื่องพิมพ์>' });
  }

  push('done', {});
  const line = 'SELFTEST_RESULT ' + JSON.stringify(out);
  // แอปที่ build แล้วเป็นโปรแกรม GUI — ข้อความในคอนโซลไม่แสดง จึงเขียนผลลงไฟล์ให้ตรวจสอบได้
  try { fs.writeFileSync(path.join(settingsLib.dir(), 'selftest-result.json'), JSON.stringify(out, null, 2), 'utf8'); } catch (e) { /* ข้าม */ }
  console.log(line);
  app.exit(out.ok ? 0 : 2);
}

// ---------------------------------------------------------------------------
// เริ่มโปรแกรม
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  app.whenReady().then(() => {
    wireDeviceHeader();
    if (SELFTEST) { runSelfTest().catch((err) => { console.log('SELFTEST_RESULT ' + JSON.stringify({ ok: false, error: err.message })); app.exit(3); }); return; }
    buildMenu();
    createMainWindow();
    startAgent();
    applyAutoStart(settingsLib.get());
  });

  app.on('window-all-closed', () => {
    if (agent) agent.stop();
    app.quit();
  });
}

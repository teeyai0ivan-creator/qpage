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

const { app, BrowserWindow, WebContentsView, ipcMain, Menu, shell, dialog, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const settingsLib = require('./lib/settings');
const printLib = require('./lib/print');
const { PrintAgent, PRINT_WAIT_MS } = require('./lib/agent');
const api = require('./lib/api');

const PARTITION = 'persist:qpage';     // เก็บคุกกี้/session ถาวร → ล็อกอินครั้งเดียวใช้ได้ยาว
const ARGS = process.argv.slice(1);
const SELFTEST = ARGS.includes('--selftest');
const argValue = (name) => {
  const hit = ARGS.find((a) => a.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : '';
};

let mainWindow = null;
let shellView = null;      // แถบเครื่องมือของโปรแกรม
let contentView = null;    // เนื้อหาที่โหลดจากเว็บ
let statusTimer = null;

// หน้าแรกของโปรแกรม (ใช้ทั้งตอนเปิดโปรแกรมและตอนกลับจากหน้าเว็บไซต์)
const APP_HOME = '/shop/kitchen.html';
const LOGIN_URL = '/login.html?next=' + encodeURIComponent(APP_HOME);

/** ตรวจว่าล็อกอินอยู่หรือยัง (ใช้ session ของโปรแกรม) + ชื่อร้านไว้แสดงบนแถบเครื่องมือ */
async function checkLogin() {
  const sess = session.fromPartition(PARTITION);
  const base = String(settingsLib.get().serverUrl || '').replace(/\/+$/, '');
  const headers = { 'X-QPage-Device': settingsLib.get().deviceId };
  try {
    const res = await sess.fetch(base + '/api/me', { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) return { loggedIn: false };
    let name = '';
    // ชื่อร้านมาจากอีกเส้นทางหนึ่ง (/api/me ให้แค่ข้อมูลผู้ใช้)
    if (data.user && data.user.role === 'shop') {
      try {
        const r2 = await sess.fetch(base + '/api/shop/me', { headers });
        const d2 = await r2.json().catch(() => ({}));
        if (r2.ok && d2.ok && d2.shop) name = d2.shop.name || '';
      } catch (e) { /* ยังไม่มีร้าน ก็ไม่เป็นไร */ }
    }
    return { loggedIn: true, email: data.user.email, role: data.user.role, name };
  } catch (err) {
    return { loggedIn: false, error: err.message };
  }
}

/** ที่อยู่ที่จะเปิดตอนเริ่มโปรแกรม: ล็อกอินแล้วเข้าหน้าครัวเลย ยังไม่ล็อกอินก็เข้าหน้าล็อกอิน */
async function startUrl() {
  const base = String(settingsLib.get().serverUrl || '').replace(/\/+$/, '');
  const me = await checkLogin();
  return base + (me.loggedIn ? APP_HOME : LOGIN_URL);
}

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

// ปรับหน้าตาให้เป็น "โปรแกรม" ไม่ใช่เว็บไซต์ — ซ่อนส่วนของเว็บที่โปรแกรมมีของตัวเองแล้ว
// (แก้ที่โปรแกรมเท่านั้น หน้าเว็บจริงไม่กระทบ)
const APP_CSS = [
  '/* ลิงก์ "กลับหน้าแรก" ของเว็บไซต์ ไม่มีความหมายในโปรแกรม */',
  '.back-home { display: none !important; }',
  '/* หน้าล็อกอินของโปรแกรม: เหลือแค่เข้าสู่ระบบ (ไม่ต้องมีสมัครสมาชิก) */',
  '.auth-switch { display: none !important; }',
  '/* แถบเมนูด้านบนของเว็บ + เมนูด้านซ้าย = โปรแกรมมีแถบเครื่องมือของตัวเองแล้ว */',
  '.site-nav { display: none !important; }',
  '.shop-side { display: none !important; }',
  '.menu-toggle, .side-menu-backdrop { display: none !important; }',
  '/* ปรับระยะให้เนื้อหาเต็มพื้นที่โปรแกรม (ไม่มีแถบเว็บด้านบนแล้ว) */',
  '.shop-shell { padding-top: 18px !important; }',
  ':root { --nav-h: 0px !important; }',
  '/* ซ่อนส่วนชวนสมัคร/แพ็กเกจ ถ้ามีหลุดเข้ามาในหน้าต่างโปรแกรม */',
  '.land-band, .land-packages, .land-hero { display: none !important; }',
].join('\n');

function applyAppLook(contents) {
  contents.insertCSS(APP_CSS).catch(() => { /* ข้าม */ });
}

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
  // หน้าต่างพิมพ์อาจถูกปิดไปแล้วระหว่างรอผล (เช่น พิมพ์จากหน้าต่างซ่อน) → อย่าให้ throw จนเสีย log
  let url = '';
  try { if (!contents.isDestroyed()) url = contents.getURL(); } catch (e) { url = ''; }
  addPrintLog({
    kind, ok: result.success, reason: result.reason || '',
    device: result.device, paper: result.paper, url,
  });
  if (!result.success) console.error(`🖨 พิมพ์${printLib.KIND_LABEL[kind] || ''}ไม่สำเร็จ: ${result.reason}`);
  else console.log(`🖨 พิมพ์${printLib.KIND_LABEL[kind] || ''} → ${result.device} (${result.paper})`);
  return result;
}

// ---------------------------------------------------------------------------
// หน้าต่างหลัก = "เปลือกของโปรแกรม" (แถบเครื่องมือของเราเอง) + เนื้อหาที่โหลดจากเว็บ
// ---------------------------------------------------------------------------
// หน้าจอที่โปรแกรมวาดเอง (ไม่โหลดหน้าเว็บ) — ค่อย ๆ ย้ายทีละหน้า
// key = path ของเว็บ, value = ไฟล์ในโปรแกรม + query ที่ต้องส่งต่อ
const NATIVE_PAGES = {
  '/shop/kitchen.html': { file: 'app/kitchen.html', query: { station: 'kitchen' } },
  '/shop/cashier.html': { file: 'app/kitchen.html', query: { station: 'cashier' } },
  '/shop/orders.html': { file: 'app/orders.html' },
  '/shop/history.html': { file: 'app/history.html' },
  // ประวัติสั่งครัว = แท็บที่ 3 ของหน้าจอประวัติ (แบบเดียวกับหน้าเว็บที่มีปุ่มเชื่อมกัน)
  '/shop/kitchen-history.html': { file: 'app/history.html', query: { tab: 'prints' } },
};

const SHELL_WIDTH = 226;          // ความกว้างแถบเมนูด้านซ้าย (px)
const SHELL_WIDTH_MINI = 64;      // ความกว้างเมื่อย่อ (เหลือไอคอน)
let shellVisible = false;         // แถบเมนูแสดงเฉพาะหลังเข้าสู่ระบบแล้ว

function createMainWindow() {
  const s = settingsLib.get();
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'QPage Shop — ระบบร้านค้า',
    backgroundColor: '#0f1626',
    autoHideMenuBar: false,
    fullscreen: !!s.fullscreen,
    show: false,
  });
  mainWindow.on('page-title-updated', (e) => e.preventDefault());

  // แถบเครื่องมือของโปรแกรม (ไฟล์ในเครื่อง ไม่ใช่หน้าเว็บ)
  shellView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  shellView.setBackgroundColor('#0f1626');
  shellView.webContents.loadFile(path.join(__dirname, 'shell.html'));

  // เนื้อหา (หน้าเว็บของระบบ) — ใช้ session ถาวร + preload สำหรับดักการพิมพ์
  contentView = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  contentView.setBackgroundColor('#f4f5fb');

  mainWindow.contentView.addChildView(shellView);
  mainWindow.contentView.addChildView(contentView);
  layoutViews();
  mainWindow.on('resize', layoutViews);
  // ⚠️ หน้าต่างแบบ "เปลือก + เนื้อหา" (WebContentsView) ไม่มีหน้าเว็บของตัวเอง
  //    → เหตุการณ์ ready-to-show อาจไม่เกิด ทำให้หน้าต่างค้างซ่อนอยู่ (เจอปัญหาจริงตอนทดสอบ)
  //    จึงแสดงเมื่อ "แถบเครื่องมือโหลดเสร็จ" และมีตัวจับเวลาสำรองอีกชั้น
  mainWindow.once('ready-to-show', showMainWindow);
  shellView.webContents.once('did-finish-load', showMainWindow);
  setTimeout(showMainWindow, 2500);

  // เปิดโปรแกรมแล้วเข้าหน้าล็อกอินทันที (ถ้าล็อกอินอยู่แล้วเข้าหน้าครัวเลย) — ไม่ผ่านหน้าเว็บไซต์สาธารณะ
  loadAppPage(null);

  const cc = contentView.webContents;
  cc.on('dom-ready', () => { installHook(cc); applyAppLook(cc); });
  // หน้าที่โปรแกรมวาดเอง — ถ้าหน้าเว็บพาไปเส้นทางเหล่านี้ (เช่น ล็อกอินเสร็จแล้วเด้งไป /shop/kitchen.html)
  // ต้องเปลี่ยนเป็นหน้าจอของโปรแกรมทันที ไม่ใช่โหลดหน้าเว็บมาแสดง
  const nativePathOf = (url) => { try { const p = new URL(url).pathname; return NATIVE_PAGES[p] ? p : ''; } catch (e) { return ''; } };
  cc.on('did-navigate', (e, url) => {
    const np = nativePathOf(url);
    if (np) { loadAppPage(np); return; }
    pushStatus(); setTimeout(() => pushStatus(), 1200);
  });
  cc.on('did-navigate-in-page', () => pushStatus());
  // กันไม่ให้หลุดไปหน้าเว็บไซต์สาธารณะในหน้าต่างโปรแกรม (ถ้ามีลิงก์ชี้ไปหน้าแรก → พากลับเข้าหน้าของโปรแกรม)
  cc.on('will-navigate', (e, url) => {
    const base = String(settingsLib.get().serverUrl || '').replace(/\/+$/, '');
    const np = nativePathOf(url);
    if (np) { e.preventDefault(); loadAppPage(np); return; }
    if (url === base || url === base + '/' || /^https?:\/\/[^/]+\/?$/.test(url)) {
      e.preventDefault();
      loadAppPage(null);
    }
  });
  // หน้าเว็บเปิด "แท็บใหม่" ผ่าน window.open (ใบสั่งครัว/ใบเสร็จ/ป้าย QR)
  // → ให้ Electron สร้างหน้าต่างให้ แต่ต้องใช้ preload + session ชุดเดียวกัน เพื่อให้ดักพิมพ์ได้เหมือนกัน
  cc.setWindowOpenHandler(() => ({
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
  cc.on('did-create-window', (child) => {
    child.webContents.on('dom-ready', () => installHook(child.webContents));
  });

  mainWindow.on('closed', () => { mainWindow = null; shellView = null; contentView = null; });
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(() => pushStatus(), 5000);
}

/** แสดงหน้าต่างโปรแกรม (เรียกซ้ำได้ ไม่พังถ้าถูกเรียกหลายครั้ง) */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } catch (err) {
    console.error('แสดงหน้าต่างไม่สำเร็จ:', err.message);
  }
}

/** จัดตำแหน่ง: แถบเครื่องมือบนสุด + เนื้อหาใต้ลงมา */
function layoutViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { width, height } = mainWindow.getContentBounds();
  const collapsed = !!settingsLib.get().sidebarCollapsed;
  const barW = collapsed ? SHELL_WIDTH_MINI : SHELL_WIDTH;
  if (shellView) {
    // ก่อนเข้าสู่ระบบ: ซ่อนแถบเมนูทั้งหมด ให้หน้าเข้าสู่ระบบเต็มหน้าต่าง
    shellView.setVisible(shellVisible);
    shellView.setBounds({ x: 0, y: 0, width: shellVisible ? barW : 0, height });
  }
  if (contentView) {
    contentView.setBounds({ x: shellVisible ? barW : 0, y: 0, width: Math.max(0, width - (shellVisible ? barW : 0)), height });
  }
}

/** เปิด/ปิดแถบเมนูตามสถานะการเข้าสู่ระบบ */
function setShellVisible(on) {
  if (shellVisible === on) return;
  shellVisible = !!on;
  if (shellView && !shellView.webContents.isDestroyed()) {
    shellView.webContents.send('shell-visible', shellVisible);
    shellView.webContents.send('shell-collapsed', !!settingsLib.get().sidebarCollapsed);
  }
  layoutViews();
  startupLog('แถบเมนูด้านซ้าย: ' + (shellVisible ? 'แสดง' : 'ซ่อน') + ' (ยังไม่/เข้าสู่ระบบแล้ว)');
}

/** เปิดหน้าของโปรแกรม (path = '/shop/kitchen.html' …) · ส่ง null = ใช้หน้าเริ่มต้นตามสถานะล็อกอิน */
function loadAppPage(p) {
  if (!contentView) return;
  const base = String(settingsLib.get().serverUrl || '').replace(/\/+$/, '');
  const native = p ? NATIVE_PAGES[p] : null;
  if (native) {
    // หน้าจอที่โปรแกรมวาดเอง (ไฟล์ในเครื่อง) — รับข้อมูลผ่าน IPC จาก main
    contentView.webContents.loadFile(path.join(__dirname, native.file), native.query ? { query: native.query } : undefined);
    startKitchenLive();
    return;
  }
  stopKitchenLive();
  if (p) { contentView.webContents.loadURL(base + p); return; }
  startUrl()
    .then((url) => {
      if (!contentView) return;
      // หน้าเริ่มต้น (ครัว) เป็นหน้าจอของโปรแกรมเองแล้ว
      if (url === base + APP_HOME && NATIVE_PAGES[APP_HOME]) { loadAppPage(APP_HOME); return; }
      contentView.webContents.loadURL(url);
    })
    .catch(() => { if (contentView) contentView.webContents.loadURL(base + LOGIN_URL); });
}

/** เปิด/ปิดสายอัปเดตสด (SSE) ให้หน้าจอครัวของโปรแกรม */
let kitchenLive = null;
function startKitchenLive() {
  if (kitchenLive) return;
  kitchenLive = api.openEvents(
    (evt) => { if (contentView && !contentView.webContents.isDestroyed()) contentView.webContents.send('kitchen:event', evt); },
    (state) => { if (contentView && !contentView.webContents.isDestroyed()) contentView.webContents.send('kitchen:live', state); }
  );
}
function stopKitchenLive() {
  if (kitchenLive) { kitchenLive.abort(); kitchenLive = null; }
}

/** พิมพ์ใบสั่งครัวของ "รอบพิมพ์" หนึ่งรอบ (เปิดหน้าพิมพ์ในหน้าต่างซ่อน แล้วดักพิมพ์เงียบ) */
async function printRoundTicket(urlPath) {
  const base = String(settingsLib.get().serverUrl || '').replace(/\/+$/, '');
  const win = new BrowserWindow({
    show: false, width: 900, height: 1200,
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  try {
    win.webContents.on('dom-ready', () => installHook(win.webContents));
    await win.loadURL(base + urlPath);
    // หน้าใบสั่งครัวยิงพิมพ์เองหลังเรนเดอร์ → รอผลจากตัวดักพิมพ์ (สูงสุด 20 วินาที)
    return await new Promise((resolve) => {
      const id = win.webContents.id;
      const timer = setTimeout(() => { pendingJobs.delete(id); resolve({ success: false, reason: 'หน้าใบสั่งครัวไม่สั่งพิมพ์ภายใน 20 วินาที' }); }, 20000);
      pendingJobs.set(id, { job: null, timer, resolve });
    });
  } catch (err) {
    return { success: false, reason: err.message };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** ส่งข้อมูลสถานะไปให้แถบเครื่องมือ (ร้าน/ผู้ใช้ · เครื่องพิมพ์ · งานพิมพ์ค้าง) */
async function pushStatus() {
  if (!shellView || !mainWindow || mainWindow.isDestroyed() || shellView.webContents.isDestroyed()) return;
  const s = settingsLib.get();
  const path = contentView ? (() => { try { return new URL(contentView.webContents.getURL()).pathname; } catch (e) { return ''; } })() : '';
  let pendingJobs = 0;
  try {
    const sess = session.fromPartition(PARTITION);
    const base = String(s.serverUrl || '').replace(/\/+$/, '');
    const res = await sess.fetch(base + '/api/shop/print-jobs?deviceId=' + encodeURIComponent(s.deviceId), { headers: { 'X-QPage-Device': s.deviceId } });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      pendingJobs = ((data && data.jobs) || []).length;
    }
  } catch (err) { /* ออฟไลน์/ยังไม่ล็อกอิน = 0 */ }
  const me = await checkLogin();
  setShellVisible(!!me.loggedIn);   // ซ่อนแถบเมนูจนกว่าจะเข้าสู่ระบบ
  const printerNames = await listPrinterDisplayNames();
  const configured = (s.printers && s.printers.ticket && s.printers.ticket.device) || '';
  shellView.webContents.send('shell-status', {
    path,
    loggedIn: !!me.loggedIn,
    email: me.email || '',
    shopName: me.name || '',
    silent: s.silent !== false,
    printerName: configured ? (printerNames[configured] || configured) : '',
    collapsed: !!s.sidebarCollapsed,
    agentActive: !!(agent && agent.kinds().length),
    pendingJobs,
  });
}

/** ชื่อที่แสดงของเครื่องพิมพ์ (ไว้โชว์บนแถบเครื่องมือ) */
async function listPrinterDisplayNames() {
  const map = {};
  try {
    const target = (contentView && !contentView.webContents.isDestroyed()) ? contentView : (settingsWindow || null);
    if (!target) return map;
    const list = await target.webContents.getPrintersAsync();
    for (const p of list || []) map[p.name] = p.displayName || p.name;
  } catch (err) { /* ข้าม */ }
  return map;
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
        { label: 'รีเฟรช', accelerator: 'F5', click: () => contentView && contentView.webContents.reload() },
        { label: 'ย้อนกลับ', accelerator: 'Alt+Left', click: () => contentView && contentView.webContents.navigationHistory.goBack() },
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
        { label: 'หน้าเข้าสู่ระบบของโปรแกรม', click: go(LOGIN_URL) },
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
  // ใช้ webContents ที่ยังอยู่ (เนื้อหา/หน้าตั้งค่า) ขอรายชื่อเครื่องพิมพ์จากระบบ
  const target = (contentView && !contentView.webContents.isDestroyed()) ? contentView
    : (settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null);
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

// ---------------------------------------------------------------------------
// IPC — จากแถบเครื่องมือของโปรแกรม (shell)
// ---------------------------------------------------------------------------
ipcMain.on('shell:nav', (event, p) => {
  const path = String(p || '');
  // อนุญาตเฉพาะเส้นทางภายในเว็บของเรา (กันคำสั่งแปลกปลอม)
  if (!/^\/[A-Za-z0-9._\-/?=&%]*$/.test(path)) return;
  loadAppPage(path);
});
ipcMain.on('shell:reload', () => { if (contentView) contentView.webContents.reload(); });
ipcMain.on('shell:zoom', (event, delta) => {
  if (!contentView) return;
  const wc = contentView.webContents;
  const now = wc.getZoomFactor();
  const next = Math.min(2, Math.max(0.6, Math.round((now + Number(delta) * 0.1) * 100) / 100));
  wc.setZoomFactor(next);
});
ipcMain.on('shell:fullscreen', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setFullScreen(!mainWindow.isFullScreen());
});
ipcMain.on('shell:settings', () => createSettingsWindow());
ipcMain.on('shell:status-now', () => { pushStatus(); });

// ---------------------------------------------------------------------------
// IPC — หน้าจอครัว/แคชเชียร์ของโปรแกรม (เรียก API ให้ เพราะหน้าจอเป็นไฟล์ในเครื่อง)
// ---------------------------------------------------------------------------
ipcMain.handle('kitchen:list', async (event, station) => {
  const data = await api.kitchenItems(station);
  return { station: data.station, items: data.items };
});
ipcMain.handle('kitchen:start', async (event, ids) => api.startItems(Array.isArray(ids) ? ids : []));
ipcMain.handle('kitchen:status', async (event, payload) => api.setItemStatus(payload && payload.id, payload && payload.status));
ipcMain.handle('kitchen:cancel', async (event, payload) => api.cancelItem(payload && payload.id, payload && payload.reason));
ipcMain.on('kitchen:print-round', async (event, payload) => {
  const urlPath = (payload && payload.url_path) || ('/shop/ticket.html?round=' + Number(payload && payload.roundId));
  const r = await printRoundTicket(urlPath);
  if (r.success) console.log(`🖨 พิมพ์ใบสั่งครัว (รอบ #${payload && payload.roundId}) → ${r.device} (${r.paper})`);
  else console.error(`🖨 พิมพ์ใบสั่งครัว (รอบ #${payload && payload.roundId}) ไม่สำเร็จ: ${r.reason}`);
});

// ---------------------------------------------------------------------------
// IPC — หน้าจอ "ประวัติ" ของโปรแกรม (บิลที่ปิดแล้ว + QR โต๊ะที่ปิดใช้งาน)
// ---------------------------------------------------------------------------
ipcMain.handle('history:bills', (event, payload) => api.history(payload || {}));
ipcMain.handle('history:prints', (event, limit) => api.kitchenPrints(limit));
ipcMain.handle('history:retired', () => api.retiredTables());
ipcMain.handle('history:qr', (event, tableId) => api.qrImage(tableId));
/** บันทึกไฟล์ลงโฟลเดอร์ Downloads ของเครื่อง (ไม่มีกล่องให้เลือกพาธ — ใช้ชื่อไฟล์ที่ส่งมาแบบปลอดภัย) */
function saveToDownloads(name, data) {
  const safe = String(name || 'qpage.txt').replace(/[\\/:*?"<>|]/g, '_').slice(-120);
  const dir = app.getPath('downloads');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, safe);
  fs.writeFileSync(file, data);
  startupLog('บันทึกไฟล์ให้ผู้ใช้: ' + file);
  return file;
}
ipcMain.handle('history:save-csv', (event, payload) => {
  const p = saveToDownloads((payload && payload.name) || 'qpage.csv', '\ufeff' + String((payload && payload.csv) || ''));
  return { path: p };
});
ipcMain.handle('history:save-qr', async (event, payload) => {
  const id = Number(payload && payload.tableId);
  const img = await api.qrImage(id);
  const b64 = String(img.dataUrl).replace(/^data:image\/png;base64,/, '');
  const p = saveToDownloads((payload && payload.name) || ('table-' + id + '-qr.png'), Buffer.from(b64, 'base64'));
  return { path: p };
});
ipcMain.on('app:reveal', (event, filePath) => {
  try { shell.showItemInFolder(String(filePath)); } catch (e) { /* ข้าม */ }
});

// ---------------------------------------------------------------------------
// IPC — หน้าจอ "สั่งอาหาร" ของโปรแกรม (ผังโต๊ะ + บิล)
// ---------------------------------------------------------------------------
ipcMain.handle('orders:tables', () => api.tables());
ipcMain.handle('orders:table-names', () => api.tableNames());
ipcMain.handle('orders:create-qr', (event, payload) => api.createQrForName(payload && payload.code, payload && payload.zoneId));
ipcMain.handle('orders:zones', () => api.zones());
ipcMain.handle('orders:open-bills', () => api.openBills());
ipcMain.handle('orders:catalog', () => api.catalog());
ipcMain.handle('orders:add-items', (event, payload) => api.addItems(payload && payload.tableId, payload && payload.items));
ipcMain.handle('orders:delete-item', (event, itemId) => api.deleteItem(itemId));
ipcMain.handle('orders:checkout', (event, tableId) => api.checkout(tableId));
ipcMain.handle('orders:add-table', (event, payload) => api.addTable(payload && payload.code, payload && payload.zoneId));
ipcMain.handle('orders:add-zone', (event, name) => api.addZone(name));
ipcMain.on('orders:print-receipt', async (event, payload) => {
  const urlPath = (payload && payload.url_path) || ('/shop/receipt.html?order=' + Number(payload && payload.orderId));
  const r = await printRoundTicket(urlPath);   // ใช้กลไกเดียวกับใบสั่งครัว (หน้าต่างซ่อน + ดักพิมพ์)
  if (r.success) console.log(`🖨 พิมพ์ใบเสร็จ (บิล #${payload && payload.orderId}) → ${r.device} (${r.paper})`);
  else console.error(`🖨 พิมพ์ใบเสร็จ (บิล #${payload && payload.orderId}) ไม่สำเร็จ: ${r.reason}`);
});
ipcMain.on('shell:collapse-toggle', () => {
  const collapsed = !settingsLib.get().sidebarCollapsed;
  settingsLib.save({ sidebarCollapsed: collapsed });
  startupLog('ย่อ/ขยายแถบเมนู: ' + (collapsed ? 'ย่อ' : 'ขยาย'));
  layoutViews();
  // บอกแถบเมนูทันที (ไม่รอรอบสถานะทุก 5 วินาที)
  if (shellView && !shellView.webContents.isDestroyed()) shellView.webContents.send('shell-collapsed', collapsed);
  pushStatus();
});
ipcMain.on('shell:logout', async () => {
  startupLog('กดออกจากระบบ');
  const sess = session.fromPartition(PARTITION);
  const base = String(settingsLib.get().serverUrl || '').replace(/\/+$/, '');
  try {
    await sess.fetch(base + '/api/logout', { method: 'POST', headers: { 'X-QPage-Device': settingsLib.get().deviceId } });
  } catch (err) { /* ออกที่เซิร์ฟเวอร์ไม่สำเร็จ ก็ยังต้องออกในเครื่องให้จบ */ }
  // ⚠️ ต้อง "ล้างคุกกี้" เป็นขั้นสุดท้าย ไม่งั้นการเขียนคุกกี้ลงดิสก์อาจพาค่าเดิมกลับมา
  //    แล้วแถบเมนู/หน้าเดิมจะค้างอยู่ (ทดสอบพบปัญหานี้)
  try { await flushCookies(); } catch (err) { /* ข้าม */ }
  try { await sess.clearStorageData({ storages: ['cookies'] }); } catch (err) { /* ข้าม */ }
  startupLog('ออกจากระบบ: ล้างคุกกี้แล้ว');
  loadAppPage(LOGIN_URL);
  setTimeout(() => pushStatus(), 800);
  setTimeout(() => pushStatus(), 2500);
});
ipcMain.handle('shell:toggle-theme', async () => {
  if (!contentView) return { theme: 'light' };
  try {
    const theme = await contentView.webContents.executeJavaScript(`(() => {
      const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      const next = cur === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('member-theme', next); } catch (e) {}
      document.documentElement.setAttribute('data-theme', next);
      return next;
    })()`, true);
    return { theme };
  } catch (err) {
    return { theme: 'light' };
  }
});
ipcMain.handle('shell:test-print', async () => {
  const win = new BrowserWindow({
    show: false, width: 900, height: 1200,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadFile(path.join(__dirname, 'test-ticket.html'), { query: { kind: 'ticket', t: String(Date.now()) } });
    await new Promise((r) => setTimeout(r, 300));
    return await printContents('ticket', win.webContents);
  } catch (err) {
    return { success: false, reason: err.message };
  } finally {
    if (!win.isDestroyed()) win.destroy();
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
    loadAppPage(null);
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

ipcMain.handle('me:info', () => checkLogin());

ipcMain.handle('app:open-settings', () => createSettingsWindow());
ipcMain.handle('app:reload-main', () => { if (contentView && !contentView.webContents.isDestroyed()) contentView.webContents.reload(); });

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
  // คำตอบที่มี header ไม่ใช่ ASCII (เช่น Date ที่จัดรูปแบบตาม locale ไทย) ทำให้ Electron โยน error
  // ตอนแปลงเป็น Headers — บันทึกไว้ให้ตามสาเหตุได้ (ไม่ให้บันทึกรัว ๆ)
  let lastNote = 0;
  sess.webRequest.onHeadersReceived((details, callback) => {
    try {
      const bad = Object.entries(details.responseHeaders || {}).filter(([k, v]) => !HEADER_OK.test(String(v == null ? '' : v)) || !HEADER_OK.test(k));
      if (bad.length && Date.now() - lastNote > 60000) {
        lastNote = Date.now();
        startupLog(`⚠️ เซิร์ฟเวอร์ตอบ header ที่มีอักษรพิเศษ (${bad.map(([k, v]) => k + '=' + String(v).slice(0, 30)).join(', ')}) จาก ${String(details.url).slice(0, 90)} — มักเกิดจากตั้ง "ที่อยู่เซิร์ฟเวอร์" ไม่ถูกต้อง`);
      }
    } catch (e) { /* ข้าม */ }
    callback({ responseHeaders: details.responseHeaders });
  });
  guardSessionFetch(sess);
}

/**
 * กันโปรแกรม "พังทั้งตัว" จาก header ที่มีอักษรไทย
 * HTTP header ส่งได้เฉพาะ Latin-1 — คำขอที่มีอักษรอื่นจะโยน error ใน main process แล้วเด้งกล่อง
 * "A JavaScript error occurred in the main process" (เจอจริงจากหน้างาน) จึงตัด header นั้นทิ้งและบันทึกไว้
 * รองรับทั้ง object ธรรมดา, Headers และ array ของคู่ [ชื่อ, ค่า]
 */
const HEADER_OK = /^[\x20-\x7E]*$/;
function headerPairs(src) {
  if (!src) return [];
  if (typeof Headers !== 'undefined' && src instanceof Headers) return [...src.entries()];
  if (Array.isArray(src)) return src.map((p) => [p[0], p[1]]);
  if (typeof src === 'object') return Object.entries(src);
  return [];
}
function cleanHeaders(src, url) {
  const pairs = headerPairs(src);
  if (!pairs.length) return null;
  const out = {};
  let changed = false;
  for (const [name, value] of pairs) {
    const n = String(name == null ? '' : name);
    const v = value == null ? '' : String(value);
    if (!HEADER_OK.test(n) || !HEADER_OK.test(v)) {
      changed = true;
      startupLog(`⚠️ ตัด header ที่มีอักษรพิเศษออก: ${n} = "${v.slice(0, 60)}" (${Buffer.from(v).toString('hex').slice(0, 24)}…) → ${String(url).slice(0, 90)}`);
      continue;
    }
    out[n] = v;
  }
  return changed ? out : null;
}
function guardSessionFetch(sess) {
  if (sess.__qpageGuarded) return;
  const original = sess.fetch.bind(sess);
  sess.__qpageGuarded = true;
  sess.fetch = (url, opts) => {
    try {
      const clean = cleanHeaders(opts && opts.headers, url);
      if (clean) return original(url, Object.assign({}, opts, { headers: clean }));
    } catch (e) { startupLog('⚠️ ตรวจ header ไม่สำเร็จ: ' + e.message); }
    return original(url, opts);
  };
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
  try { for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed()) w.destroy(); } } catch (e) { /* ข้าม */ }
  app.exit(out.ok ? 0 : 2);
}

// ---------------------------------------------------------------------------
// เริ่มโปรแกรม
// ---------------------------------------------------------------------------
/** เขียนบันทึกการเริ่มโปรแกรมลงไฟล์ (ไว้ตามปัญหากรณีเปิดแล้วไม่มีอะไรขึ้น) */
function startupLog(msg) {
  const line = new Date().toISOString() + '  ' + msg + '\n';
  try {
    fs.mkdirSync(settingsLib.dir(), { recursive: true });
    fs.appendFileSync(path.join(settingsLib.dir(), 'startup.log'), line, 'utf8');
  } catch (e) { /* ข้าม */ }
  console.log('[start] ' + msg);
}

// ถ้ามีโปรแกรมเปิดอยู่แล้ว: อินสแตนซ์ใหม่จะปิดตัวเอง — แต่จะบอกอินสแตนซ์เดิมให้ "แสดงหน้าต่าง" ทันที
// (กันกรณีหน้าต่างเดิมถูกซ่อนอยู่แล้วผู้ใช้คิดว่าโปรแกรมไม่ขึ้น)
if (!app.requestSingleInstanceLock()) {
  startupLog('มีโปรแกรมเปิดอยู่แล้ว → ปิดอินสแตนซ์ใหม่ (สั่งให้ตัวเดิมแสดงหน้าต่าง)');
  app.quit();
} else {
  app.on('second-instance', () => {
    startupLog('มีคนเปิดโปรแกรมซ้ำ → แสดงหน้าต่างเดิม');
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      showMainWindow();
    }
  });

  app.whenReady().then(() => {
    startupLog('โปรแกรมเริ่มทำงาน (เวอร์ชัน ' + app.getVersion() + ')');
    // ห้ามให้โปรแกรม "ล้มทั้งตัว" จาก error ที่เกิดในไลบรารีของ Electron (เช่น แปลง header ที่มีอักษรไทย
    // จากเซิร์ฟเวอร์/พร็อกซีที่ไม่มาตรฐาน) — เจอจริงจากหน้างาน: โปรแกรมเด้งกล่อง error แล้วปิดไปทั้งตัว
    let errCount = 0;
    process.on('uncaughtException', (err) => {
      errCount++;
      const msg = String((err && err.message) || err);
      const hint = /ByteString/.test(msg + String(err && err.stack))
        ? ' → สาเหตุ: เซิร์ฟเวอร์ตอบ header ที่มีอักษรพิเศษ (ตรวจ "ที่อยู่เซิร์ฟเวอร์" ในหน้าตั้งค่าโปรแกรม)'
        : '';
      // บันทึกไม่ให้ท่วม: 3 ครั้งแรก แล้วเว้นไปทุก ๆ 30 ครั้ง
      if (errCount <= 3 || errCount % 30 === 0) {
        startupLog(`💥 พบข้อผิดพลาดที่ไม่คาดคิด (ครั้งที่ ${errCount} — โปรแกรมทำงานต่อ): ` + (err && err.stack || msg) + hint);
      }
      try { console.error('💥 uncaughtException:', msg.slice(0, 200)); } catch (e) { /* ข้าม */ }
    });
    process.on('unhandledRejection', (err) => {
      startupLog('💥 พบ promise ที่ไม่สำเร็จ (โปรแกรมทำงานต่อ): ' + ((err && err.message) || err));
    });
    try {
      wireDeviceHeader();
    } catch (err) { startupLog('ตั้งค่า header ไม่สำเร็จ: ' + err.message); }
    if (SELFTEST) { runSelfTest().catch((err) => { console.log('SELFTEST_RESULT ' + JSON.stringify({ ok: false, error: err.message })); app.exit(3); }); return; }
    try {
      buildMenu();
      createMainWindow();
      startAgent();
      applyAutoStart(settingsLib.get());
      startupLog('เปิดหน้าต่างโปรแกรมแล้ว');
    } catch (err) {
      startupLog('เปิดโปรแกรมไม่สำเร็จ: ' + (err && err.stack || err));
      try {
        dialog.showErrorBox('เปิดโปรแกรมไม่สำเร็จ', String(err && err.message || err)
          + '\n\nไฟล์บันทึก: ' + path.join(settingsLib.dir(), 'startup.log'));
      } catch (e) { /* ข้าม */ }
    }
  });

  app.on('window-all-closed', () => {
    if (agent) agent.stop();
    flushCookies().finally(() => app.quit());
  });

  // ⚠️ คุกกี้ (session การล็อกอิน) ถูกเก็บในหน่วยความจำก่อน — ต้องสั่งเขียนลงดิสก์เอง
  //    ไม่งั้นปิดโปรแกรมแล้วเปิดใหม่จะต้องล็อกอินซ้ำทุกครั้ง (ทดสอบพบปัญหานี้จริง)
  app.on('before-quit', () => { flushCookies(); });
  // เขียนเป็นระยะด้วย เผื่อเครื่องถูกปิดกะทันหัน/ไฟดับ
  setInterval(() => { flushCookies(); }, 120000).unref?.();
}

/** เขียนคุกกี้ของ session โปรแกรมลงดิสก์ (จำการล็อกอินไว้ใช้ครั้งถัดไป) */
function flushCookies() {
  try {
    return session.fromPartition(PARTITION).cookies.flushStore().catch(() => { /* ข้าม */ });
  } catch (err) {
    return Promise.resolve();
  }
}

/**
 * settings.js — ค่าตั้งของโปรแกรม (เก็บไฟล์ JSON ในโฟลเดอร์ข้อมูลผู้ใช้ของ Windows)
 *
 * ไฟล์อยู่ที่ %APPDATA%\QPage Shop\settings.json — ผู้ใช้แก้ผ่านหน้าตั้งค่าในโปรแกรมเท่านั้น
 * ค่าที่เก็บ: ที่อยู่เซิร์ฟเวอร์, เครื่องพิมพ์/ขนาดกระดาษแยกตามชนิดเอกสาร, สวิตช์พิมพ์เงียบ,
 *            ชนิดงานที่รับพิมพ์จากมือถือ/แท็บเล็ต, เปิดพร้อมเครื่อง, เต็มจอ
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let app = null;
try { app = require('electron').app; } catch (e) { app = null; }

const FILE_NAME = 'settings.json';

// ค่าเริ่มต้น — กระดาษเริ่มต้น 80mm (ม้วนมาตรฐาน) ปรับได้ในหน้าตั้งค่า
const DEFAULTS = {
  serverUrl: 'https://qpage.website',
  deviceId: '',
  label: '',
  silent: true,      // พิมพ์เงียบ (ไม่ขึ้นกล่องยืนยัน) — ปิดเพื่อกลับไปใช้กล่องพิมพ์ของเบราว์เซอร์
  fullscreen: false,
  sidebarCollapsed: false,   // ย่อแถบเมนูด้านซ้ายเหลือเฉพาะไอคอน
  autoStart: false,
  kinds: { ticket: true, receipt: true, label: true },   // รับงานพิมพ์จากมือถือ/แท็บเล็ต
  printers: {
    ticket: { device: '', paper: 'auto' },   // '' = ใช้เครื่องพิมพ์เริ่มต้นของ Windows · 'auto' = ใช้ขนาดกระดาษที่ตั้งในไดรเวอร์
    receipt: { device: '', paper: 'auto' },
    label: { device: '', paper: 'auto' },
    other: { device: '', paper: 'a4' },
  },
};

function dir() {
  if (app && typeof app.getPath === 'function') return app.getPath('userData');
  return path.join(process.cwd(), '.data');
}

function file() {
  return path.join(dir(), FILE_NAME);
}

function merge(base, patch) {
  const out = Object.assign({}, base);
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = merge(base[k] || {}, v);
    else out[k] = v;
  }
  return out;
}

let cache = null;

/** อ่านค่าตั้ง (ครั้งแรกจะสร้างไฟล์ให้พร้อมรหัสเครื่อง) */
function get() {
  if (cache) return cache;
  let saved = {};
  try {
    if (fs.existsSync(file())) saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch (err) {
    console.error('⚠️ อ่านไฟล์ตั้งค่าไม่ได้ (จะใช้ค่าเริ่มต้น):', err.message);
    saved = {};
  }
  cache = merge(DEFAULTS, saved);
  // ย้ายค่าตั้งเก่า: ขนาดกระดาษ 58mm/80mm แบบกำหนดเองใช้ไม่ได้บน Windows (Chromium ไม่รับ) → เปลี่ยนเป็น auto
  for (const k of Object.keys(cache.printers || {})) {
    const paper = cache.printers[k] && cache.printers[k].paper;
    if (paper === '58mm' || paper === '80mm') cache.printers[k].paper = 'auto';
  }
  if (!cache.deviceId) {
    // รหัสเครื่องใช้แยกว่า "คำขอมาจากโปรแกรมนี้" (กันพิมพ์ซ้ำ) — สุ่มครั้งเดียวแล้วเก็บไว้
    cache.deviceId = crypto.randomUUID();
    save({});
  }
  return cache;
}

function save(patch) {
  cache = merge(cache || get(), patch || {});
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('⚠️ บันทึกไฟล์ตั้งค่าไม่ได้:', err.message);
  }
  return cache;
}

module.exports = { get, save, file, dir, DEFAULTS };

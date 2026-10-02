/**
 * slip-files.js — เก็บไฟล์สลิปโอนเงิน "นอก" โฟลเดอร์ public
 *
 * เหตุผล: สลิปมีข้อมูลส่วนบุคคล (เลขบัญชี/ชื่อ/ยอดเงิน) จึงห้ามเปิดผ่าน static
 * เปิดดูได้เฉพาะผ่านเส้นทางที่ตรวจสิทธิ์เท่านั้น (ของแพ็กเกจ = เจ้าของรายการ/แอดมิน · ของบิล = ร้านเจ้าของบิล)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SLIP_DIR = path.join(__dirname, '..', '..', 'private_uploads', 'slips');
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAX_SLIP_BYTES = 2 * 1024 * 1024;   // 2MB (base64 บวม ~33% ต้องไม่เกินเพดาน JSON 4mb)

/** แปลง data URL ของสลิป → { buf, ext } (โยน Error ข้อความไทยถ้าไม่ถูกต้อง) */
function parseSlip(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('ไฟล์สลิปไม่ถูกต้อง (รองรับ png/jpeg/webp)');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new Error('ไฟล์สลิปว่างเปล่า');
  if (buf.length > MAX_SLIP_BYTES) throw new Error('ไฟล์สลิปใหญ่เกิน 2MB');
  return { buf, ext: TYPES[m[1]] };
}

/** บันทึกไฟล์สลิป แล้วคืนพาธสำหรับเก็บในฐานข้อมูล (เส้นทางนี้เป็นแค่ "ชื่ออ้างอิง" ไม่ได้เสิร์ฟตรง) */
function saveSlipBuffer(buf, ext, prefix) {
  fs.mkdirSync(SLIP_DIR, { recursive: true });
  const name = String(prefix || 'slip') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) + '.' + ext;
  fs.writeFileSync(path.join(SLIP_DIR, name), buf);
  return name;
}

/** ชื่อไฟล์ที่ปลอดภัย (กัน path traversal) */
function safeName(name) {
  return /^[A-Za-z0-9._-]{1,120}$/.test(String(name || '')) ? String(name) : '';
}

/** พาธเต็มของไฟล์สลิป (null ถ้าชื่อไม่ปลอดภัย/ไม่มีไฟล์) */
function slipPath(name) {
  const n = safeName(name);
  if (!n) return null;
  const p = path.join(SLIP_DIR, n);
  return fs.existsSync(p) ? p : null;
}

module.exports = { SLIP_DIR, MAX_SLIP_BYTES, parseSlip, saveSlipBuffer, safeName, slipPath };

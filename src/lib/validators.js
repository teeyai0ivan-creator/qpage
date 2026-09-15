/**
 * validators.js — ตรวจ/แปลงข้อมูลนำเข้า (อีเมล เบอร์โทรศัพท์ไทย รหัสผ่าน)
 */
'use strict';

function maskPhone(phone) {
  const digits = phone.replace(/[^0-9]/g, '');
  if (digits.length < 7) return phone;
  return `${digits.slice(0, 3)}-***-${digits.slice(-4)}`;
}

/** ปิดบางส่วนของอีเมลสำหรับแสดงผล เช่น somchai@x.com → s***i@x.com */
function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return s;
  const name = s.slice(0, at);
  const head = name.slice(0, 1);
  const tail = name.length > 2 ? name.slice(-1) : '';
  return head + '***' + tail + s.slice(at);
}

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * ตรวจเบอร์โทรไทย — ยอมรับทั้งแบบมี/ไม่มี 0 นำหน้า และแบบมี 66/+66
 * เช่น 0812345678 | 812345678 | 912345678 | 66812345678 | +66812345678
 * (มือถือไทยขึ้นต้น 06 / 08 / 09 — เลข 9 หลักที่ขึ้นต้นด้วย 6/8/9 ถือว่าลืม 0)
 */
function isValidThaiPhone(value) {
  const d = String(value || '').replace(/[^0-9]/g, '');
  return /^0\d{9}$/.test(d) || /^[689]\d{8}$/.test(d) || /^66[689]\d{8}$/.test(d);
}

/** แปลงเบอร์ไทยทุกรูปแบบ → มาตรฐาน 0XXXXXXXXX (10 หลัก มี 0 นำหน้า) */
function normalizeThaiPhone(value) {
  let d = String(value || '').replace(/[^0-9]/g, '');
  if (/^66[689]\d{8}$/.test(d)) d = d.slice(2); // 66812345678 → 812345678 (ตัดรหัสประเทศ)
  if (/^[689]\d{8}$/.test(d)) d = '0' + d;      // 812345678 → 0812345678 (เติม 0 ที่ลืม)
  return d;
}

/**
 * จัดรูปแบบเบอร์สำหรับ "แสดงผล" — เติม 0 นำหน้าให้เบอร์มือถือไทยที่บันทึกไว้โดยไม่มี 0
 * ถ้าไม่ใช่รูปแบบที่รู้จัก (เช่น เบอร์ต่างประเทศ) คืนค่าเดิมไปตามที่เก็บไว้ ไม่ตัดทิ้ง
 */
function displayThaiPhone(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  return /^0\d{9}$/.test(normalizeThaiPhone(raw)) ? normalizeThaiPhone(raw) : raw;
}

/**
 * ให้คะแนนความแข็งแรงรหัสผ่าน (0-5) — ต้องตรงกับฝั่ง client (register.html)
 * เกณฑ์: 8 ตัวขึ้นไป, 12 ตัวขึ้นไป, มีพิมพ์ใหญ่, มีพิมพ์เล็ก, มีตัวเลข, มีสัญลักษณ์
 */
function passwordStrengthScore(pw) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[a-z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return score;
}

module.exports = { maskPhone, maskEmail, isValidEmail, isValidThaiPhone, normalizeThaiPhone, displayThaiPhone, passwordStrengthScore };

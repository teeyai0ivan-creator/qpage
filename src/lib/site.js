/**
 * site.js — ข้อมูลตั้งค่าหน้าเว็บไซต์สาธารณะ (ลิงก์โซเชียลที่ท้ายหน้าเว็บหลัก)
 *
 * ค่าที่เก็บใน settings (แก้ได้ที่หลังบ้าน → เมนู "ตั้งค่าหน้าเว็บไซต์" /admin/site.html):
 *   site_facebook_url, site_line_url
 *
 * ผู้ใช้กรอกได้หลายแบบ (ลิงก์เต็ม / ชื่อเพจ / ไอดีไลน์) ระบบจะแปลงเป็นลิงก์ที่ใช้ได้จริงให้
 * และ "ค่าที่บันทึกคือค่าที่แปลงแล้ว" เพื่อให้เห็นตรงกันทั้งหลังบ้านและหน้าเว็บ
 * ความปลอดภัย: ค่าที่จะถูกใส่ใน href ต้องเป็น http/https เท่านั้น (กัน javascript:/data:)
 */
'use strict';

const db = require('../db');

const MAX_LEN = 300;
const FB_BASE = 'https://www.facebook.com/';
const LINE_BASE = 'https://line.me/R/ti/p/';

const KEYS = { facebook: 'site_facebook_url', line: 'site_line_url' };

function stored(key) {
  try { return String(db.getSetting(key) || '').trim().slice(0, MAX_LEN); } catch (e) { return ''; }
}

/** ลิงก์ http/https ที่ปลอดภัยพอจะใส่ใน href (ค่าว่าง = ใช้ไม่ได้) */
function isHttpUrl(s) {
  return s.length <= MAX_LEN && /^https?:\/\/[^\s<>"'\\]+$/i.test(s);
}

/** "facebook.com/ร้าน" หรือ "fb.me/x" → ลิงก์เต็ม (อย่างอื่นที่ไม่ใช่ http/https → ค่าว่าง) */
function toHttpUrl(v) {
  const s = String(v || '').trim().slice(0, MAX_LEN);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return isHttpUrl(s) ? s : '';
  // ไม่มี scheme: ยอมรับเฉพาะรูปโดเมน/พาธ (ต้องมีสแลช) และห้ามมีอักขระที่ทำอันตรายใน href ได้
  // (ไทย/อักขระ Unicode ปล่อยผ่านได้ เพราะเบราว์เซอร์เข้ารหัสให้เอง — แต่ห้ามมีอักขระควบคุม/อัญประกาศ)
  if (s.includes('/') && !/[\s<>"'`\\\u0000-\u001f]/.test(s)) {
    const u = 'https://' + s;
    return isHttpUrl(u) ? u : '';
  }
  return '';
}

/** ชื่อโดเมนเปล่า ๆ ที่ผู้ใช้อาจพิมพ์มาโดยไม่มีพาธ (เช่น facebook.com) */
function hostOnly(s, hosts) {
  const host = String(s || '').replace(/\/+$/, '').toLowerCase();
  return hosts.includes(host.replace(/^(www|m|web)\./, ''));
}

/** ไอดีที่รับได้: ตัวอักษร/ตัวเลข/จุด/ขีด/ขีดล่าง เท่านั้น */
function idPart(s) {
  return String(s || '').replace(/^[@~]/, '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
}

/** ชื่อ/ไอดี ที่เป็นคำเดียวสะอาด ๆ (ไม่มี : / ช่องว่าง หรืออักขระอื่น) — ใช้ตัดสินว่าเป็น "ไอดี" ไม่ใช่ข้อความขยะ */
function looksLikeId(s) {
  return /^[A-Za-z0-9._@~-]+$/.test(s);
}

/**
 * Facebook: รับได้ทั้งลิงก์เต็ม, facebook.com/ชื่อเพจ, หรือชื่อเพจเปล่า ๆ
 * หลักการ: มี "/" = ลิงก์ · ที่เหลือถือเป็น "ชื่อเพจ" (ชื่อเพจจริงมักมีจุดได้ เช่น kfc.thailand)
 */
function facebookUrl(v) {
  const s = String(v || '').trim().slice(0, MAX_LEN);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return isHttpUrl(s) ? s : '';
  const asUrl = toHttpUrl(s);
  if (asUrl) return asUrl;
  if (hostOnly(s, ['facebook.com', 'fb.com', 'fb.me', 'fb.watch'])) return 'https://' + s.replace(/\/+$/, '');
  if (!looksLikeId(s)) return '';
  const id = idPart(s);
  return id ? FB_BASE + id : '';
}

/**
 * LINE: รับได้ทั้งลิงก์เต็ม, lin.ee/xxx, line.me/..., @ไอดีทางการ, ~ไอดีส่วนตัว, หรือไอดีเปล่า ๆ
 * หลักการเดียวกับ Facebook: มี "/" = ลิงก์ · ที่เหลือถือเป็นไอดี
 */
function lineUrl(v) {
  const s = String(v || '').trim().slice(0, MAX_LEN);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return isHttpUrl(s) ? s : '';
  const asUrl = toHttpUrl(s);
  if (asUrl) return asUrl;
  if (hostOnly(s, ['line.me', 'lin.ee', 'line.naver.jp'])) return 'https://' + s.replace(/\/+$/, '');
  if (/^[@~]/.test(s)) {
    const id = idPart(s);
    if (!id) return '';
    // ~ไอดี = รูปแบบไอดีส่วนตัว, @ไอดี = บัญชีทางการ (เข้ารหัส @ เป็น %40 ตามที่ LINE ใช้)
    return s[0] === '~' ? LINE_BASE + '~' + id : LINE_BASE + encodeURIComponent('@' + id);
  }
  if (!looksLikeId(s)) return '';
  const id = idPart(s);
  return id ? LINE_BASE + encodeURIComponent('@' + id) : '';
}

function socialLinks() {
  return { facebook: facebookUrl(stored(KEYS.facebook)), line: lineUrl(stored(KEYS.line)) };
}

/** ค่าดิบที่บันทึกไว้ (ใช้เติมในช่องกรอกของหลังบ้าน) */
function savedValues() {
  return { facebook: stored(KEYS.facebook), line: stored(KEYS.line) };
}

/** ข้อมูลสาธารณะสำหรับหน้าเว็บหลัก */
function publicInfo() {
  const s = socialLinks();
  return { social: { facebook: s.facebook, line: s.line } };
}

module.exports = { KEYS, MAX_LEN, facebookUrl, lineUrl, socialLinks, savedValues, publicInfo };

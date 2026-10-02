/**
 * qr-cache.js — สร้าง QR เป็น PNG แล้ว "แคชไว้ในหน่วยความจำ"
 *
 * ทำไม: การสร้าง QR (qrcode → PNG) กิน CPU และทำทีละคำขอ (คิวเดียว) หน้าสั่งอาหารของร้าน
 * วาด QR ของทุกโต๊ะพร้อมกัน (บวก QR เดลิเวอร์รี่) ทำให้แต่ละอันต้องรอคิวกัน — QR เดลิเวอร์รี่
 * จึงโหลดช้า/ค้างเป็นบางจังหวะ โดยเฉพาะเวลาเปิดหน้าแล้วกดรีเฟรชถี่ ๆ
 *
 * เนื้อ QR เปลี่ยนเฉพาะเมื่อ "ข้อความ" หรือ "ขนาด" เปลี่ยน (โทเคน/โดเมนเดิม = ได้ภาพเดิม)
 * จึงแคชได้ปลอดภัย + ส่ง ETag ให้เบราว์เซอร์ไม่ต้องโหลดซ้ำทุกครั้งที่เปิดหน้า
 */
'use strict';

const crypto = require('node:crypto');
const QRCode = require('qrcode');

const MAX_ENTRIES = 300;          // กันหน่วยความจำบาน (ร้านหนึ่งมีกี่โต๊ะก็ไม่เกินนี้)
const cache = new Map();          // key → { png, etag }

/** สร้าง/ดึง PNG ของ QR จากข้อความที่กำหนด (คืน { png, etag }) */
async function qrPng(text, { width = 320, margin = 1 } = {}) {
  const key = width + '|' + margin + '|' + text;
  const hit = cache.get(key);
  if (hit) return hit;
  const png = await QRCode.toBuffer(text, { type: 'png', width, margin });
  const etag = '"' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16) + '"';
  const entry = { png, etag };
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);   // ทิ้งของเก่าสุด
  cache.set(key, entry);
  return entry;
}

/**
 * ส่ง PNG ของ QR ให้คำขอหนึ่งรายการ พร้อม ETag/แคชฝั่งเบราว์เซอร์
 * - ถ้าเบราว์เซอร์มีภาพเดิมอยู่แล้ว (If-None-Match ตรง) → ตอบ 304 ไม่ต้องส่งไฟล์
 * บริการนี้ต้องล็อกอิน (requireShop) จึงใช้ private cache ได้
 */
async function sendQr(res, req, text, opts) {
  const { png, etag } = await qrPng(text, opts);
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'private, max-age=86400');
  res.set('ETag', etag);
  if (req && req.headers['if-none-match'] === etag) return res.status(304).end();
  res.send(png);
}

function cacheSize() { return cache.size; }

module.exports = { qrPng, sendQr, cacheSize };

/**
 * shop-page.js — ส่งหน้าเว็บของโซนร้านค้า โดย "ใส่ชื่อร้านตั้งแต่ฝั่งเซิร์ฟเวอร์"
 *
 * เดิมชื่อร้านในแถบหัวเป็นข้อความตายตัว ("ร้านของฉัน") แล้วรอ JS เรียก /api/shop/me มาเปลี่ยน
 * ทำให้เปิด/รีเฟรชหน้าแล้วเห็นคำว่า "ร้านของฉัน" ขึ้นแวบหนึ่งก่อนจะกลายเป็นชื่อจริง
 * ตัวช่วยนี้แทรกชื่อร้านลงใน HTML ก่อนส่ง เลยเห็นชื่อจริงตั้งแต่เฟรมแรก
 */
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const BRAND_NAME_RE = /(<span class="brand-name"[^>]*>)[^<]*(<\/span>)/;
// โลโก้มุมซ้ายบนในโซนร้านค้า = โลโก้ร้าน (ถ้าร้านยังไม่มีโลโก้ ใช้โลโก้ QPage เดิม)
const BRAND_LOGO_RE = /(<div class="brand-logo">)<img[^>]*>(<\/div>)/;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {import('express').Response} res
 * @param {string} file ชื่อไฟล์ใน public/shop เช่น 'menu.html'
 * @param {{name?:string,logo_url?:string}|null} shop ข้อมูลร้าน (ถ้าไม่มีจะใช้ข้อความเดิมในไฟล์)
 */
async function sendShopPage(res, file, shop) {
  const full = path.join(PUBLIC_DIR, 'shop', file);
  res.set('Cache-Control', 'no-store');
  try {
    let html = await fs.readFile(full, 'utf8');
    if (shop && shop.name) html = html.replace(BRAND_NAME_RE, `$1${esc(shop.name)}$2`);
    if (shop && shop.logo_url) {
      html = html.replace(BRAND_LOGO_RE, `$1<img src="${esc(shop.logo_url)}" alt="${esc(shop.name || 'ร้านของฉัน')}">$2`);
    }
    res.type('html').send(html);
  } catch (err) {
    // อ่านไฟล์ไม่ได้ก็ยังส่งหน้าเดิมได้ (แค่ชื่อร้าน/โลโก้จะเริ่มที่ค่าเดิมเหมือนก่อน)
    console.error(`⚠️ อ่านหน้าเว็บร้านค้าไม่สำเร็จ (${file}):`, err.message);
    res.sendFile(full);
  }
}

module.exports = { sendShopPage };

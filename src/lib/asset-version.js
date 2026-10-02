/**
 * asset-version.js — เวอร์ชันของไฟล์ static (/css, /js, /fonts) คำนวณครั้งเดียวตอนบูต
 *
 * ทำไมต้องมี: เดิมทุกไฟล์ .css/.js ถูกส่งด้วย Cache-Control: no-cache เบราว์เซอร์จึงต้อง
 * "ถามเซิร์ฟเวอร์ใหม่" ทุกไฟล์ในทุกครั้งที่เปิดหน้าใหม่ (สลับเมนูไปมาก็ถามใหม่หมด)
 * บนเน็ตจริงที่มี latency สูง ทำให้การสลับหน้าแต่ละครั้งช้า/ขึ้นตัวหมุนนาน
 *
 * วิธีแก้: ต่อท้าย URL ด้วย ?v=<เวอร์ชัน> (แทรกให้อัตโนมัติในหน้าเว็บของร้าน) แล้วให้ไฟล์นั้น
 * แคชได้ยาวแบบ immutable — พอ deploy ใหม่ เนื้อไฟล์เปลี่ยน เวอร์ชันเปลี่ยน URL เปลี่ยน
 * เบราว์เซอร์จึงดึงของใหม่ทันทีโดยไม่ต้องพึ่งการถามซ้ำ
 *
 * เวอร์ชันมาจากการแฮช "เนื้อไฟล์" จริง (ไม่ใช่เวลาแก้ไฟล์) จึงไม่พลาดแม้ deploy จะคง mtime ไว้
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const VERSIONED_DIRS = ['css', 'js', 'fonts'];

function computeVersion() {
  const h = crypto.createHash('sha1');
  for (const dir of VERSIONED_DIRS) {
    const full = path.join(PUBLIC_DIR, dir);
    let files = [];
    try { files = fs.readdirSync(full).sort(); } catch (e) { continue; }
    for (const name of files) {
      try {
        const buf = fs.readFileSync(path.join(full, name));
        h.update(dir + '/' + name + ':');
        h.update(crypto.createHash('sha1').update(buf).digest('hex'));
      } catch (e) { /* ข้ามไฟล์ที่อ่านไม่ได้ */ }
    }
  }
  return h.digest('hex').slice(0, 10);
}

const ASSET_VERSION = computeVersion();

/** เติม ?v=<เวอร์ชัน> ให้ลิงก์ /css และ /js ใน HTML (ไม่แตะลิงก์ที่มี query อยู่แล้ว/ลิงก์ภายนอก) */
function stampAssetUrls(html) {
  return String(html).replace(/(\s(?:href|src)=")(\/(?:css|js)\/[^"?#]+)"/g, `$1$2?v=${ASSET_VERSION}"`);
}

module.exports = { ASSET_VERSION, stampAssetUrls };

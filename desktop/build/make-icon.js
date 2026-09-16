/**
 * make-icon.js — สร้างไอคอนแอป (build/icon.ico) จากโลโก้เว็บ public/img/logo.svg
 *
 * รัน: npx electron build/make-icon.js      (จากโฟลเดอร์ desktop)
 * ทำอะไร: เรนเดอร์โลโก้บนพื้นสี่เหลี่ยมมุมมน → จับภาพเป็น PNG หลายขนาด → รวมเป็นไฟล์ .ico
 *         (Windows Vista ขึ้นไปรองรับ PNG ในไฟล์ .ico ได้)
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'icon.ico');
const LOGO = path.join(__dirname, '..', '..', 'public', 'img', 'logo.svg');
const SIZES = [256, 128, 64, 48, 32, 16];

/** รวม PNG หลายขนาดเป็นไฟล์ .ico */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type = icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const p = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, p);        // width (0 = 256)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, p + 1);    // height
    dir.writeUInt8(0, p + 2);                             // palette
    dir.writeUInt8(0, p + 3);                             // reserved
    dir.writeUInt16LE(1, p + 4);                          // color planes
    dir.writeUInt16LE(32, p + 6);                         // bits per pixel
    dir.writeUInt32LE(e.png.length, p + 8);               // size of image data
    dir.writeUInt32LE(offset, p + 12);                    // offset
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

app.whenReady().then(async () => {
  const logo = fs.readFileSync(LOGO, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;}
    .wrap{width:256px;height:256px;display:flex;align-items:center;justify-content:center;background:transparent;}
    .plate{width:232px;height:232px;border-radius:52px;background:#ffffff;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 24px rgba(16,24,40,.18);}
    svg.logo{width:170px;height:170px;}
  </style></head><body><div class="wrap"><div class="plate">${logo.replace('<svg ', '<svg class="logo" ')}</div></div></body></html>`;

  const win = new BrowserWindow({
    width: 256, height: 256, show: false, frame: false, transparent: true,
    webPreferences: { contextIsolation: true, offscreen: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 700));

  // จับภาพที่ 256 แล้วย่อลงแต่ละขนาด (การย่อหน้าต่างแล้วจับภาพจะได้แค่ส่วนมุมของเลย์เอาต์)
  const full = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  const entries = SIZES.map((size) => ({ size, png: (size === 256 ? full : full.resize({ width: size, height: size })).toPNG() }));
  fs.writeFileSync(OUT, buildIco(entries));
  console.log('ICON_RESULT ' + JSON.stringify({ file: OUT, bytes: fs.statSync(OUT).size, sizes: SIZES }));
  app.exit(0);
});

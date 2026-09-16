/**
 * shell.js — ควบคุมแถบเครื่องมือของโปรแกรม (แสดงผลอย่างเดียว + สั่งงานผ่าน main)
 */
'use strict';

const $ = (id) => document.getElementById(id);
const MATCH = (el) => String(el.dataset.match || el.dataset.nav || '').split(',').filter(Boolean);

function paintNav(path) {
  document.querySelectorAll('.nav button[data-nav]').forEach((btn) => {
    const hit = MATCH(btn).some((m) => path === m || path.startsWith(m));
    btn.classList.toggle('active', hit);
  });
}

function paintStatus(s) {
  if (!s) return;
  // สถานะร้าน/ผู้ใช้
  const shop = $('pillShop');
  const txtShop = $('txtShop');
  if (s.loggedIn) {
    shop.className = 'pill ok';
    txtShop.textContent = (s.shopName ? s.shopName : 'เข้าสู่ระบบแล้ว');
    shop.title = 'เข้าสู่ระบบ: ' + (s.email || '') + (s.shopName ? ' · ร้าน ' + s.shopName : '');
  } else {
    shop.className = 'pill warn';
    txtShop.textContent = 'ยังไม่เข้าสู่ระบบ';
    shop.title = 'เปิดหน้าล็อกอินเพื่อเข้าใช้งาน';
  }
  // เครื่องพิมพ์
  const pr = $('pillPrinter');
  const txtPr = $('txtPrinter');
  if (s.silent) {
    pr.className = 'pill ok';
    txtPr.textContent = 'พิมพ์เงียบ: ' + (s.printerName || 'เครื่องพิมพ์เริ่มต้น');
    pr.title = 'ใบสั่งครัว → ' + (s.printerName || 'เครื่องพิมพ์เริ่มต้นของ Windows');
  } else {
    pr.className = 'pill warn';
    txtPr.textContent = 'พิมพ์แบบมีกล่องยืนยัน';
    pr.title = 'ปิดโหมดพิมพ์เงียบอยู่ — เปิดได้ที่หน้าตั้งค่า';
  }
  // งานพิมพ์จากมือถือ/แท็บเล็ต
  const jb = $('pillJobs');
  const txtJb = $('txtJobs');
  if (!s.agentActive) {
    jb.className = 'pill';
    txtJb.textContent = 'ไม่รับงานจากมือถือ';
    jb.title = 'เปิดรับงานพิมพ์จากมือถือ/แท็บเล็ตได้ที่หน้าตั้งค่า';
  } else if (s.pendingJobs > 0) {
    jb.className = 'pill warn';
    txtJb.textContent = 'รอพิมพ์ ' + s.pendingJobs + ' งาน';
    jb.title = 'มีงานพิมพ์จากเครื่องอื่นรออยู่';
  } else {
    jb.className = 'pill ok';
    txtJb.textContent = 'รับงานจากมือถืออยู่';
    jb.title = 'พร้อมรับงานพิมพ์จากมือถือ/แท็บเล็ต';
  }
  $('brandSub').textContent = s.shopName ? 'ร้าน ' + s.shopName : 'โปรแกรมร้านค้า';
  paintNav(String(s.path || ''));
}

function clock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('clock').textContent = p(d.getHours()) + ':' + p(d.getMinutes());
}

document.querySelectorAll('.nav button[data-nav]').forEach((btn) => {
  btn.addEventListener('click', () => window.qpageShell.nav(btn.dataset.nav));
});
$('btnSettings').addEventListener('click', () => window.qpageShell.openSettings());
$('btnReload').addEventListener('click', () => window.qpageShell.reload());
$('btnZoomIn').addEventListener('click', () => window.qpageShell.zoom(1));
$('btnZoomOut').addEventListener('click', () => window.qpageShell.zoom(-1));
$('btnFull').addEventListener('click', () => window.qpageShell.fullscreen());
$('btnTheme').addEventListener('click', () => window.qpageShell.toggleTheme());
$('btnPrintTest').addEventListener('click', async () => {
  const btn = $('btnPrintTest');
  btn.disabled = true; const old = btn.innerHTML;
  btn.innerHTML = 'กำลังพิมพ์…';
  const r = await window.qpageShell.testPrint();
  btn.disabled = false; btn.innerHTML = old;
  btn.title = r && r.success ? 'พิมพ์ทดสอบสำเร็จ → ' + r.device : 'พิมพ์ทดสอบไม่สำเร็จ: ' + ((r && r.reason) || '');
  if (r && !r.success) alert('พิมพ์ทดสอบไม่สำเร็จ: ' + (r.reason || ''));
});

window.qpageShell.onStatus(paintStatus);
window.qpageShell.refreshStatus();
clock();
setInterval(clock, 20000);

/**
 * admin-pages.js — ส่งหน้า HTML ของหลังบ้านโดย "แทรกเมนูตามบทบาท" ฝั่งเซิร์ฟเวอร์
 *
 * เหตุผล: เมนูบางรายการเห็นเฉพาะเจ้าของระบบ (owner) แต่หน้าแอดมินทุกหน้าใช้ร่วมกับ admin
 * ถ้าใช้ JS ซ่อน/โชว์ทีหลัง เมนูจะกระพริบทุกครั้งที่เปลี่ยนหน้า — จึงเรนเดอร์ตั้งแต่ฝั่งเซิร์ฟเวอร์
 * ไฟล์ HTML มีจุดแทนที่ <!--MENU_ROLE--> ไว้ แล้วสคริปต์นี้จะแทนด้วยเมนูตามบทบาทของผู้ใช้
 * (เมนูที่ไม่เข้าเงื่อนไขจะไม่ถูกใส่ และถ้าไม่มีเมนูเลยก็จะลบจุดแทนที่ทิ้ง)
 *
 * ⚠️ เพิ่มหน้าแอดมินใหม่ = ใส่ชื่อไฟล์ใน PAGES และเพิ่มรายการใน ADMIN_MENUS ที่นี่
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const express = require('express');
const { getCurrentUser } = require('../middleware/auth');
const { isAdminRole, isOwner } = require('../lib/roles');

const router = express.Router();
const ADMIN_DIR = path.join(__dirname, '..', '..', 'public', 'admin');
const PAGES = ['index.html', 'otp.html', 'users.html', 'profile.html', 'packages.html', 'payments.html', 'purchase-history.html', 'legal.html', 'site.html'];

/**
 * เมนูที่ฝั่งเซิร์ฟเวอร์เป็นคนใส่ในแถบข้าง — เรียงตามลำดับที่แสดง
 * ownerOnly: true = เจ้าของระบบเท่านั้น · false/ไม่ระบุ = แอดมินและเจ้าของระบบเห็นเหมือนกัน
 */
const ADMIN_MENUS = [
  {
    file: 'packages.html',
    href: '/admin/packages.html',
    label: 'แพ็กเกจร้านค้า',
    ownerOnly: true,
    icon: '<path d="M21 16V8a2 2 0 00-1-1.7l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.7l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M3.3 7L12 12l8.7-5M12 22V12" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  },
  {
    file: 'payments.html',
    href: '/admin/payments.html',
    label: 'การชำระเงิน',
    ownerOnly: true,
    icon: '<rect x="2" y="5" width="20" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M2 10h20M6 15h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  },
  {
    file: 'purchase-history.html',
    href: '/admin/purchase-history.html',
    label: 'ประวัติการซื้อ',
    ownerOnly: true,
    icon: '<path d="M3 3v18h18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M7 15l3.5-4 3 2.5L19 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  {
    file: 'site.html',
    href: '/admin/site.html',
    label: 'ตั้งค่าหน้าเว็บไซต์',
    icon: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M3 12h18M12 3c2.5 2.4 3.8 5.4 3.8 9S14.5 18.6 12 21c-2.5-2.4-3.8-5.4-3.8-9S9.5 5.4 12 3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  },
  {
    file: 'legal.html',
    href: '/admin/legal.html',
    label: 'ข้อมูลทางกฎหมาย (PDPA)',
    ownerOnly: true,
    icon: '<path d="M12 3l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6l7-3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  },
];

function menuHtml(currentFile, owner) {
  return ADMIN_MENUS
    .filter((m) => !m.ownerOnly || owner)
    .map((m) => `      <a class="side-link${m.file === currentFile ? ' active' : ''}" href="${m.href}">
        <svg viewBox="0 0 24 24" fill="none">${m.icon}</svg>
        ${m.label}
      </a>`).join('\n');
}

router.get(['/admin/', '/admin/:file'], async (req, res, next) => {
  const file = req.params.file || 'index.html';
  if (!PAGES.includes(file)) return next(); // ไฟล์อื่น (css/js/รูป) ให้ express.static จัดการ

  const user = await getCurrentUser(req);
  if (!user || !isAdminRole(user.role)) return next(); // ไม่ผ่านสิทธิ์ = ให้ guard จัดการต่อ

  let html;
  try {
    html = await fs.readFile(path.join(ADMIN_DIR, file), 'utf8');
  } catch (err) {
    return next(); // ไม่มีไฟล์ → ปล่อยให้ static ตอบ 404
  }

  const menu = menuHtml(file, isOwner(user.role));
  html = html.replace(/^[ \t]*<!--MENU_ROLE-->[ \t]*\r?\n/m, menu ? menu + '\n' : '');

  res.set('Cache-Control', 'no-store'); // HTML ขึ้นกับบทบาทผู้ใช้ — ห้ามแคช
  res.type('html').send(html);
});

module.exports = router;

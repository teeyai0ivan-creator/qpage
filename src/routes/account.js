/**
 * account.js — หน้าบัญชี (/dashboard, /settings) และการยืนยันอีเมล
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const express = require('express');
const db = require('../db');
const { sha256 } = require('../lib/crypto');
const { isExpired } = require('../lib/time');
const { buildResultPage } = require('../lib/result-page');
const { getCurrentUser } = require('../middleware/auth');
const { isShop, isOwner, isAdminRole } = require('../lib/roles');
const bcrypt = require('bcryptjs');
const legal = require('../lib/legal');
const { COOKIE_NAME } = require('../config');

const router = express.Router();
const DASHBOARD_FILE = path.join(__dirname, '..', '..', 'public', 'dashboard', 'index.html');

// ---------------------------------------------------------------------------
// สิทธิของเจ้าของข้อมูลตาม PDPA — ขอดูสำเนาข้อมูลของตัวเอง (JSON) และลบบัญชีของตัวเอง
// ---------------------------------------------------------------------------
/** รวบรวมข้อมูลของผู้ใช้รายนี้ (ไม่รวมรหัสผ่าน/โทเคนความลับ) */
async function collectMyData(user) {
  const account = {
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    provider: user.provider,
    is_email_verified: Number(user.is_email_verified) === 1,
    created_at: user.created_at,
    terms_accepted_at: user.terms_accepted_at || null,
    terms_version: user.terms_version || null,
  };
  const out = {
    exported_at: new Date().toISOString(),
    policy_version: legal.PRIVACY_VERSION,
    account,
    purchases: await db.listPurchasesByUser(user.id).catch(() => []),
    shop: null,
  };
  const shop = await db.findShopByUserId(user.id);
  if (shop) {
    const [categories, menus, tables, orders] = await Promise.all([
      db.listCategories(shop.id),
      db.listMenus(shop.id),
      db.listTables(shop.id),
      db.listClosedOrders(shop.id, { limit: 200 }),
    ]);
    out.shop = {
      name: shop.name, phone: shop.phone, line_url: shop.line_url, maps_url: shop.maps_url,
      public_code: shop.public_code, created_at: shop.created_at,
      categories: categories.map((c) => ({ id: c.id, name: c.name, parent_id: c.parent_id })),
      menus: menus.map((m) => ({ id: m.id, category_id: m.category_id, name: m.name, price: Number(m.price), available: Number(m.available) === 1 })),
      tables: tables.map((t) => ({ id: t.id, code: t.code, zone: t.zone_name || null, created_at: t.created_at })),
      bills: orders.map((o) => ({ id: o.id, bill_no: o.bill_no, table_code: o.table_code, total: Number(o.total), opened_at: o.opened_at, closed_at: o.closed_at })),
    };
  }
  return out;
}

router.get('/api/me/export', async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบก่อน' });
  try {
    const data = await collectMyData(user);
    console.log(`📦 [PDPA] ผู้ใช้ ${user.email} ดาวน์โหลดสำเนาข้อมูลของตนเอง`);
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.set('Content-Disposition', `attachment; filename="my-data-${user.id}-${Date.now()}.json"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('export my data ไม่สำเร็จ:', err.message);
    res.status(500).json({ ok: false, message: 'สร้างไฟล์ข้อมูลไม่สำเร็จ กรุณาลองใหม่' });
  }
});

router.delete('/api/me', async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบก่อน' });
  if (isOwner(user.role) || isAdminRole(user.role)) {
    return res.status(403).json({ ok: false, message: 'บัญชีผู้ดูแลระบบลบเองไม่ได้ — กรุณาติดต่อผู้ให้บริการ' });
  }
  if (String(req.body?.confirm || '').trim() !== 'ลบบัญชี') {
    return res.status(400).json({ ok: false, field: 'confirm', message: 'พิมพ์คำว่า ลบบัญชี เพื่อยืนยัน' });
  }
  const full = await db.findUserById(user.id);
  if (!full) return res.status(404).json({ ok: false, message: 'ไม่พบบัญชีนี้' });
  const okPw = await bcrypt.compare(String(req.body?.password || ''), full.password_hash);
  if (!okPw) return res.status(400).json({ ok: false, field: 'password', message: 'รหัสผ่านไม่ถูกต้อง' });
  const email = full.email;
  await db.deleteUser(user.id); // ลบข้อมูลที่ผูกกับบัญชีทั้งหมด (ร้าน/เมนู/โต๊ะ/บิล) ตาม FK CASCADE
  await db.deleteUserSessions(user.id);
  try { res.clearCookie(COOKIE_NAME, { path: '/' }); } catch (e) { /* ข้าม */ }
  console.log(`🗑️ [PDPA] ลบบัญชีผู้ใช้ตามคำขอของเจ้าของข้อมูล: ${email}`);
  res.json({ ok: true, message: 'ลบบัญชีและข้อมูลของคุณแล้ว', redirect: '/' });
});

/**
 * เมนู "ร้านค้า" ในแถบข้าง ต่างกันตามบทบาท — เรนเดอร์จากเซิร์ฟเวอร์ตั้งแต่แรก
 * (เดิมใช้ JS สลับข้อความ/ซ่อน ทำให้เมนูกะพริบทุกครั้งที่เปลี่ยนหน้า)
 */
const SHOP_ICON = '<svg viewBox="0 0 24 24" fill="none"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4H6z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 6h18M16 10a4 4 0 01-8 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const item = (href, label) => `      <a class="menu-item" href="${href}">
        ${SHOP_ICON}
        <span>${label}</span>
      </a>`;

function shopMenuHtml(role) {
  if (!role || role === 'admin' || role === 'owner') return '';
  // เจ้าของร้านเห็น 2 เมนู: เข้าร้าน (เริ่มที่หน้าสั่งอาหาร) + ซื้อเพิ่ม/ต่ออายุแพ็กเกจ
  const links = isShop(role)
    ? item('/shop/orders.html', 'ร้านค้าของฉัน') + '\n' + item('/shop/purchase.html', 'ต่ออายุแพ็กเกจ')
    : item('/shop/purchase.html', 'ซื้อแพ็กเกจร้านค้า');
  return `      <div class="menu-title">ร้านค้า</div>\n${links}`;
}

// หน้าบัญชี — ใช้ไฟล์เดียว เลือก panel จาก URL (/settings/profile, /settings/security)
router.get(['/dashboard', '/dashboard/'], (req, res) => res.redirect('/settings/profile'));
router.get(['/settings', '/settings/'], (req, res) => res.redirect('/settings/profile'));
router.get(['/dashboard/:section', '/settings/:section'], async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    let html = await fs.readFile(DASHBOARD_FILE, 'utf8');
    const menu = shopMenuHtml(user && user.role);
    html = html.replace(/^[ \t]*<!--SHOP_MENU-->[ \t]*\r?\n/m, menu ? menu + '\n' : '');
    res.set('Cache-Control', 'no-store'); // HTML ขึ้นกับบทบาทผู้ใช้ — ห้ามแคช
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// ยืนยันอีเมล (เปิดจากลิงก์ในอีเมล)
// ---------------------------------------------------------------------------
router.get('/verify-email', async (req, res) => {
  const token = String(req.query.token || '');
  const record = await db.findEmailTokenByHash(sha256(token));
  // ถ้าล็อกอินอยู่แล้ว (และเป็นบัญชีเดียวกัน) ปุ่มบนหน้าผลลัพธ์จะพาเข้าใช้งานต่อ ไม่พาไปหน้าล็อกอิน
  const viewer = await getCurrentUser(req);
  const opts = { viewer, targetUserId: record ? record.user_id : null };

  if (!record || record.used === 1) {
    return res.status(400).send(buildResultPage(false, 'ลิงก์ยืนยันไม่ถูกต้องหรือถูกใช้ไปแล้ว', opts));
  }
  if (isExpired(record.expires_at)) {
    return res.status(400).send(buildResultPage(false, 'ลิงก์ยืนยันหมดอายุแล้ว กรุณาขอใหม่', opts));
  }

  await db.markEmailTokenUsed(record.id);
  await db.setEmailVerified(record.user_id, 1);
  console.log(`📧 ยืนยันอีเมลสำเร็จ: user_id=${record.user_id}`);

  res.send(buildResultPage(true, 'ยืนยันอีเมลสำเร็จ! คุณสามารถเข้าสู่ระบบได้เลย', opts));
});

module.exports = router;

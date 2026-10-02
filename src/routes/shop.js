/**
 * shop.js — พื้นที่เจ้าของร้าน (ซื้อแพ็กเกจ → ตั้งร้าน → จัดการเมนู) + หน้าร้านสาธารณะ
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const db = require('../db');
const { sendShopPage } = require('../lib/shop-page');
const { sendPublicShopPage } = require('../lib/shop-seo');
const { getCurrentUser, requireLogin, requireShop } = require('../middleware/auth');
const { isAdminRole, isShop } = require('../lib/roles');
const { randomToken } = require('../lib/crypto');
const shopHours = require('../lib/shop-hours');
const orderPay = require('../lib/order-pay');
const slipVerify = require('../lib/slip-verify');
const { addMonthsSql, toSql, nowSql } = require('../lib/time');
const { getPaymentSettings, hasAnyChannel, paymentInstructions, generateRef, emailPackagePurchased, entitlementEndFor } = require('../lib/payments');

const { makeRouter } = require('../lib/router');
const router = makeRouter();
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads', 'shops');
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

const clip = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// ---------------------------------------------------------------------------
// หน้าเว็บ (อยู่หลัง shopGuard ที่ mount ไว้ใน app.js)
// ---------------------------------------------------------------------------
async function requireShopPage(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl || '/shop'));
  if (user.status !== 'active') {
    return res.redirect(user.provider === 'google' ? '/google-setup.html' : '/otp.html');
  }
  if (!isShop(user.role)) return res.redirect('/shop');
  req.user = user;
  next();
}

// ประตู /shop — ใช้หน้ากลางที่ redirect ฝั่ง client (location.replace) เพื่อไม่ให้กดย้อนกลับแล้ววน
router.get('/shop', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'shop', 'entry.html'));
});

// หน้าซื้อแพ็กเกจ (ผู้ใช้ทั่วไป)
router.get('/shop/purchase.html', async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.redirect('/login.html?next=/shop/purchase.html');
  if (isAdminRole(user.role)) return res.redirect('/admin/');
  // เจ้าของร้านเข้าหน้านี้ได้ด้วย เพื่อ "ซื้อเพิ่ม/ต่ออายุ" (ไม่เริ่มนับใหม่)
  // ถ้าเป็นเจ้าของร้านอยู่แล้ว ให้ใช้ชื่อ/โลโก้ร้านในแถบหัวด้วย (ผู้ใช้ทั่วไปยังเห็นโลโก้ระบบ)
  const shop = await db.findShopByUserId(user.id);
  await sendShopPage(res, 'purchase.html', shop);
});

// หน้าตั้งข้อมูลร้าน (เจ้าของร้าน)
router.get('/shop/setup.html', requireShopPage, async (req, res) => {
  const shop = await db.findShopByUserId(req.user.id);
  await sendShopPage(res, 'setup.html', shop);
});

// หน้าจัดการเมนู (เจ้าของร้าน + ต้องมีข้อมูลร้านก่อน)
router.get('/shop/menu.html', requireShopPage, async (req, res) => {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) return res.redirect('/shop/setup.html');
  await sendShopPage(res, 'menu.html', shop);
});

// หน้า "เมนูทั้งหมด" — ตารางแบบเอ็กเซล (เปิดจากปุ่มในหน้าจัดการเมนู)
router.get('/shop/menus.html', requireShopPage, async (req, res) => {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) return res.redirect('/shop/setup.html');
  await sendShopPage(res, 'menus.html', shop);
});

// หน้าร้านสาธารณะ (ไม่ต้องล็อกอิน) — ใส่ชื่อ/คำอธิบาย/โลโก้ ลง <meta> ตั้งแต่ฝั่งเซิร์ฟเวอร์
// เพื่อให้การ์ดพรีวิวเวลาแชร์ลิงก์ (LINE/Facebook) และเสิร์ชเอนจินเห็นข้อมูลร้านได้ทันที
router.get('/s/:code', async (req, res) => {
  const shop = await db.findPublicShopByCode(String(req.params.code || ''));
  await sendPublicShopPage(req, res, shop);
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function myShop(req, res) {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) {
    res.status(400).json({ ok: false, message: 'กรุณาตั้งข้อมูลร้านก่อน' });
    return null;
  }
  return shop;
}

// รายการแพ็กเกจที่เปิดขาย (owner ตั้งไว้ที่ /admin/packages.html) — ใช้แสดงในหน้าซื้อแพ็กเกจ
router.get('/api/packages', async (req, res) => {
  res.json({ ok: true, packages: await db.listActivePackages() });
});

// ซื้อแพ็กเกจ (จำลองการชำระเงิน) — ผู้ใช้ที่ล็อกอินแล้วและยังไม่เป็นเจ้าของร้าน
// ราคา/ชื่อแพ็กเกจคิดจากฝั่งเซิร์ฟเวอร์เสมอ (ไม่เชื่อค่าที่ client ส่งมา)
router.post('/api/shop/purchase', requireLogin, async (req, res) => {
  const user = req.user;
  if (isAdminRole(user.role)) {
    return res.status(400).json({ ok: false, message: 'บัญชีผู้ดูแลระบบไม่ต้องซื้อแพ็กเกจ' });
  }

  // ต้องยืนยันเบอร์โทร + อีเมลให้ครบทั้งสองอย่างก่อน จึงจะซื้อแพ็กเกจได้
  const need = [];
  if (user.status !== 'active') need.push('phone');
  if (Number(user.is_email_verified) !== 1) need.push('email');
  if (need.length) {
    return res.status(403).json({
      ok: false,
      need,
      message: need.length === 2
        ? 'กรุณายืนยันเบอร์โทรศัพท์และอีเมลให้เสร็จทั้งสองอย่างก่อน จึงจะซื้อแพ็กเกจได้'
        : need[0] === 'phone'
          ? 'กรุณายืนยันเบอร์โทรศัพท์ให้เสร็จก่อน จึงจะซื้อแพ็กเกจได้'
          : 'กรุณายืนยันอีเมลให้เสร็จก่อน จึงจะซื้อแพ็กเกจได้',
    });
  }

  const packageId = Number(req.body?.packageId);
  if (!Number.isInteger(packageId) || packageId <= 0) {
    return res.status(400).json({ ok: false, message: 'กรุณาเลือกแพ็กเกจที่ต้องการซื้อ' });
  }
  const pkg = await db.findPackageById(packageId);
  if (!pkg || Number(pkg.active) !== 1) {
    return res.status(400).json({ ok: false, message: 'แพ็กเกจนี้ไม่พร้อมขายหรือถูกปิดไปแล้ว' });
  }

  const amount = Number(pkg.price) || 0;

  // เปิดรับชำระเงินจริง → สร้างรายการรอโอน แล้วให้เจ้าของระบบกดยืนยันยอด (ยังไม่ให้สิทธิ์ทันที)
  const pay = getPaymentSettings();
  if (pay.enabled && hasAnyChannel(pay)) {
    await db.expireStalePayments(); // ล้างรายการที่หมดเวลา ให้ลูกค้าสร้างใหม่ได้
    const existing = await db.findPendingPackagePaymentByUser(user.id);
    if (existing) {
      return res.json({ ok: true, pending: true, message: 'คุณมีรายการที่รอตรวจสอบยอดอยู่แล้ว', payment: paymentInstructions(existing) });
    }
    let paymentId = null;
    for (let i = 0; i < 5 && !paymentId; i++) {
      try {
        paymentId = await db.createPackagePayment({
          userId: user.id,
          packageId: pkg.id,
          packageName: pkg.name,
          durationMonths: pkg.duration_months,
          amount,
          method: pay.promptpayId ? 'promptpay' : 'bank',
          ref: generateRef(),
        });
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') throw err; // รหัสอ้างอิงชนกัน → สุ่มใหม่
      }
    }
    if (!paymentId) return res.status(500).json({ ok: false, message: 'สร้างรายการชำระเงินไม่สำเร็จ กรุณาลองใหม่' });
    const rec = await db.findPackagePaymentById(paymentId);
    console.log(`💳 เปิดรายการชำระเงิน #${rec.id} (${rec.ref}) ${user.email} · ${pkg.name} · ฿${amount}`);
    return res.json({ ok: true, pending: true, message: 'สร้างรายการชำระเงินแล้ว (รหัส ' + rec.ref + ')', payment: paymentInstructions(rec) });
  }

  // โหมดที่ยังไม่เปิดรับชำระเงิน → ให้สิทธิ์ทันที
  // ถ้ายังมีสิทธิ์เหลืออยู่ ให้นับต่อจากวันหมดอายุเดิม (เหมือนเส้นทางที่ชำระเงินจริง)
  const current = await entitlementEndFor(user);
  const stillActive = current && current.getTime() > Date.now();
  const startAt = stillActive ? toSql(current) : nowSql();
  const expiresAt = addMonthsSql(startAt, pkg.duration_months);
  await db.setUserRole(user.id, 'shop');
  await db.setUserShopExpiry(user.id, expiresAt);
  await db.createShopPurchase({
    userId: user.id, packageId: pkg.id, packageName: clip(pkg.name, 30), amount, startAt, expiresAt,
  });
  console.log(`🛒 ซื้อแพ็กเกจร้านค้า: ${user.email} (${pkg.name} · ${pkg.duration_months} เดือน · ฿${amount} · ถึง ${expiresAt}${stillActive ? ' · ต่อจากเดิม' : ''})`);
  // แจ้งลูกค้าทางอีเมล พร้อมรายละเอียดแพ็กเกจที่แอดมินตั้งไว้
  await emailPackagePurchased({
    user,
    packageId: pkg.id,
    packageName: pkg.name,
    durationMonths: pkg.duration_months,
    amount,
    startAt,
    expiresAt,
    ref: '',
    extended: Boolean(stillActive),
    baseUrl: `${req.protocol}://${req.get('host')}`,
  });
  res.json({
    ok: true,
    message: `ซื้อแพ็กเกจ "${pkg.name}" สำเร็จ ตอนนี้คุณเป็นเจ้าของร้านแล้ว`,
    role: 'shop',
    expiresAt,
    redirect: '/settings/profile?purchased=1',
  });
});

// ข้อมูลร้านของฉัน + ข้อมูลเมนูทั้งหมด (ใช้ในหน้าจัดการ)
// แนบ "สิทธิ์ใช้งาน" (วันหมดอายุแพ็กเกจ) มาด้วย — โปรแกรม Windows ใช้ตัดสินว่าให้เข้าใช้หรือไม่
router.get('/api/shop/me', requireShop, async (req, res) => {
  const shop = await db.findShopByUserId(req.user.id);
  const entitlementEnd = await entitlementEndFor(req.user);
  const entitlement = {
    role: req.user.role,
    entitlement_end: entitlementEnd ? entitlementEnd.toISOString() : null,
    // มีสิทธิ์ใช้ระบบร้าน = มีวันหมดอายุที่ยังไม่ผ่าน (ของขวัญจากแอดมิน หรือแพ็กเกจที่ซื้อไว้)
    entitled: !!entitlementEnd && entitlementEnd.getTime() > Date.now(),
  };
  if (!shop) {
    return res.json({
      ok: true, shop: null, categories: [], menus: [], optionGroups: [], optionItems: [], menuGroups: [],
      purchase: await db.findLatestShopPurchase(req.user.id),
      ...entitlement,
    });
  }
  const [categories, menus, optionGroups, optionItems, menuGroups] = await Promise.all([
    db.listCategories(shop.id),
    db.listMenus(shop.id),
    db.listOptionGroups(shop.id),
    db.listOptionItems(shop.id),
    db.listMenuOptionGroups(shop.id),
  ]);
  res.json({
    ok: true, shop, categories, menus, optionGroups, optionItems, menuGroups,
    publicUrl: '/s/' + shop.public_code,
    purchase: await db.findLatestShopPurchase(req.user.id),
    // สถานะร้านตอนนี้ (เปิด/ปิด + เหตุผล) ให้หน้าจอตั้งค่าแสดงได้ทันที
    hours: shopHours.openState(shop),
    ...entitlement,
  });
});

// สร้างร้าน (1 บัญชี = 1 ร้าน)
router.post('/api/shop', requireShop, async (req, res) => {
  const existing = await db.findShopByUserId(req.user.id);
  if (existing) return res.status(409).json({ ok: false, message: 'คุณมีร้านแล้ว (1 บัญชี = 1 ร้าน)' });

  const name = clip(req.body?.name, 120);
  const phone = clip(req.body?.phone, 30);
  if (name.length < 2) return res.status(400).json({ ok: false, field: 'name', message: 'กรุณากรอกชื่อร้าน (อย่างน้อย 2 ตัวอักษร)' });
  if (phone.length < 6) return res.status(400).json({ ok: false, field: 'phone', message: 'กรุณากรอกเบอร์ติดต่อร้าน' });

  const shop = await db.createShop({
    userId: req.user.id,
    publicCode: randomToken().slice(0, 10),
    name,
    phone,
    lineUrl: clip(req.body?.lineUrl, 255),
    logoUrl: clip(req.body?.logoUrl, 255),
    mapsUrl: clip(req.body?.mapsUrl, 500),
    seoTitle: clip(req.body?.seoTitle, 160),
    seoDescription: clip(req.body?.seoDescription, 400),
  });
  console.log(`🏪 สร้างร้าน: ${name} (${req.user.email})`);
  res.json({ ok: true, message: 'สร้างร้านสำเร็จ', shop });
});

// แก้ไขข้อมูลร้าน
router.put('/api/shop', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;

  const fields = {};
  if (req.body?.name !== undefined) {
    const name = clip(req.body.name, 120);
    if (name.length < 2) return res.status(400).json({ ok: false, field: 'name', message: 'กรุณากรอกชื่อร้าน (อย่างน้อย 2 ตัวอักษร)' });
    fields.name = name;
  }
  if (req.body?.phone !== undefined) fields.phone = clip(req.body.phone, 30);
  if (req.body?.lineUrl !== undefined) fields.lineUrl = clip(req.body.lineUrl, 255);
  if (req.body?.logoUrl !== undefined) fields.logoUrl = clip(req.body.logoUrl, 255);
  if (req.body?.mapsUrl !== undefined) fields.mapsUrl = clip(req.body.mapsUrl, 500);
  // เนื้อหา SEO ที่แสดงบน Google และในการ์ดพรีวิวเวลาแชร์ลิงก์ร้าน
  if (req.body?.seoTitle !== undefined) fields.seoTitle = clip(req.body.seoTitle, 160);
  if (req.body?.seoDescription !== undefined) fields.seoDescription = clip(req.body.seoDescription, 400);

  await db.updateShop(shop.id, fields);
  const updated = await db.findShopByUserId(req.user.id);
  res.json({ ok: true, message: 'บันทึกข้อมูลร้านแล้ว', shop: updated });
});

// ---------- หมวดหมู่ / หมวดหมู่ย่อย ----------
router.post('/api/shop/categories', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const name = clip(req.body?.name, 120);
  if (!name) return res.status(400).json({ ok: false, message: 'กรุณากรอกชื่อหมวดหมู่' });

  let parentId = req.body?.parentId ? Number(req.body.parentId) : null;
  if (parentId) {
    const parent = await db.findCategoryById(parentId, shop.id);
    if (!parent) return res.status(400).json({ ok: false, message: 'ไม่พบหมวดหมู่หลักที่เลือก' });
    if (parent.parent_id) return res.status(400).json({ ok: false, message: 'ซ้อนหมวดหมู่ย่อยได้ไม่เกิน 1 ชั้น' });
  }
  const id = await db.createCategory({
    shopId: shop.id,
    parentId,
    name,
    sortOrder: Number(req.body?.sortOrder) || 0,
    // เส้นทางแสดงผลของหมวดนี้: ส่งรายการไปครัว หรือแคชเชียร์
    station: req.body?.station === 'cashier' ? 'cashier' : 'kitchen',
  });
  res.json({ ok: true, message: 'เพิ่มหมวดหมู่แล้ว', id });
});

router.put('/api/shop/categories/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  if (!await db.findCategoryById(id, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบหมวดหมู่' });

  const fields = {};
  if (req.body?.name !== undefined) {
    const name = clip(req.body.name, 120);
    if (!name) return res.status(400).json({ ok: false, message: 'กรุณากรอกชื่อหมวดหมู่' });
    fields.name = name;
  }
  if (req.body?.sortOrder !== undefined) fields.sortOrder = Number(req.body.sortOrder) || 0;
  // เส้นทางแสดงผลของหมวดนี้: ส่งรายการไปครัว หรือแคชเชียร์
  if (req.body?.station !== undefined) fields.station = req.body.station === 'cashier' ? 'cashier' : 'kitchen';
  await db.updateCategory(id, shop.id, fields);
  res.json({ ok: true, message: 'บันทึกหมวดหมู่แล้ว' });
});

router.delete('/api/shop/categories/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  if (!await db.findCategoryById(id, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบหมวดหมู่' });
  await db.deleteCategory(id, shop.id);
  res.json({ ok: true, message: 'ลบหมวดหมู่แล้ว' });
});

// ---------- เมนูสินค้า ----------
async function readMenuFields(req, shop, res) {
  const fields = {};
  if (req.body?.name !== undefined) {
    const name = clip(req.body.name, 150);
    if (!name) { res.status(400).json({ ok: false, field: 'name', message: 'กรุณากรอกชื่อเมนู' }); return null; }
    fields.name = name;
  }
  if (req.body?.description !== undefined) fields.description = clip(req.body.description, 500);
  if (req.body?.price !== undefined) {
    const price = Number(req.body.price);
    if (!Number.isFinite(price) || price < 0) { res.status(400).json({ ok: false, field: 'price', message: 'ราคาไม่ถูกต้อง' }); return null; }
    fields.price = Math.round(price * 100) / 100;
  }
  if (req.body?.imageUrl !== undefined) fields.imageUrl = clip(req.body.imageUrl, 255);
  if (req.body?.available !== undefined) fields.available = req.body.available ? 1 : 0;
  if (req.body?.sortOrder !== undefined) fields.sortOrder = Number(req.body.sortOrder) || 0;
  if (req.body?.categoryId !== undefined) {
    if (req.body.categoryId === null || req.body.categoryId === '') {
      fields.categoryId = null;
    } else {
      const cid = Number(req.body.categoryId);
      if (!await db.findCategoryById(cid, shop.id)) { res.status(400).json({ ok: false, field: 'categoryId', message: 'ไม่พบหมวดหมู่ที่เลือก' }); return null; }
      fields.categoryId = cid;
    }
  }
  return fields;
}

router.post('/api/shop/menus', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  if (!clip(req.body?.name, 150)) return res.status(400).json({ ok: false, field: 'name', message: 'กรุณากรอกชื่อเมนู' });
  const fields = await readMenuFields(req, shop, res);
  if (!fields) return;
  const id = await db.createMenu({ shopId: shop.id, ...fields });
  res.json({ ok: true, message: 'เพิ่มเมนูแล้ว', id });
});

router.put('/api/shop/menus/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  if (!await db.findMenuById(id, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบเมนู' });
  const fields = await readMenuFields(req, shop, res);
  if (!fields) return;
  await db.updateMenu(id, shop.id, fields);
  res.json({ ok: true, message: 'บันทึกเมนูแล้ว' });
});

router.delete('/api/shop/menus/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  if (!await db.findMenuById(id, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบเมนู' });
  await db.deleteMenu(id, shop.id);
  res.json({ ok: true, message: 'ลบเมนูแล้ว' });
});

// ผูกกลุ่มตัวเลือกกับเมนู
router.put('/api/shop/menus/:id/groups', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  if (!await db.findMenuById(id, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบเมนู' });

  const raw = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
  const groupIds = [];
  for (const g of raw) {
    const gid = Number(g);
    if (gid && await db.findOptionGroupById(gid, shop.id)) groupIds.push(gid);
  }
  await db.setMenuOptionGroups(id, groupIds);
  res.json({ ok: true, message: 'บันทึกตัวเลือกของเมนูแล้ว' });
});

// ---------- กลุ่มตัวเลือก / ตัวเลือก ----------
router.post('/api/shop/option-groups', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const name = clip(req.body?.name, 120);
  if (!name) return res.status(400).json({ ok: false, message: 'กรุณากรอกชื่อกลุ่มตัวเลือก (เช่น ระดับความเผ็ด)' });
  const id = await db.createOptionGroup({
    shopId: shop.id, name,
    required: req.body?.required ? 1 : 0,
    multi: req.body?.multi ? 1 : 0,
    sortOrder: Number(req.body?.sortOrder) || 0,
  });
  res.json({ ok: true, message: 'เพิ่มกลุ่มตัวเลือกแล้ว', id });
});

router.put('/api/shop/option-groups/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  if (!await db.findOptionGroupById(id, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบกลุ่มตัวเลือก' });
  const fields = {};
  if (req.body?.name !== undefined) {
    const name = clip(req.body.name, 120);
    if (!name) return res.status(400).json({ ok: false, message: 'กรุณากรอกชื่อกลุ่มตัวเลือก' });
    fields.name = name;
  }
  if (req.body?.required !== undefined) fields.required = req.body.required ? 1 : 0;
  if (req.body?.multi !== undefined) fields.multi = req.body.multi ? 1 : 0;
  if (req.body?.sortOrder !== undefined) fields.sortOrder = Number(req.body.sortOrder) || 0;
  await db.updateOptionGroup(id, shop.id, fields);
  res.json({ ok: true, message: 'บันทึกกลุ่มตัวเลือกแล้ว' });
});

router.delete('/api/shop/option-groups/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  if (!await db.findOptionGroupById(id, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบกลุ่มตัวเลือก' });
  await db.deleteOptionGroup(id, shop.id);
  res.json({ ok: true, message: 'ลบกลุ่มตัวเลือกแล้ว' });
});

router.post('/api/shop/option-groups/:id/items', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const gid = Number(req.params.id);
  if (!await db.findOptionGroupById(gid, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบกลุ่มตัวเลือก' });
  const name = clip(req.body?.name, 120);
  if (!name) return res.status(400).json({ ok: false, message: 'กรุณากรอกชื่อตัวเลือก' });
  const priceDelta = Number(req.body?.priceDelta) || 0;
  const id = await db.createOptionItem({ groupId: gid, name, priceDelta, sortOrder: Number(req.body?.sortOrder) || 0, isDefault: req.body?.isDefault ? 1 : 0 });
  // ถ้าตั้งเป็นค่าเริ่มต้นตั้งแต่สร้าง ให้จัดการ "ค่าเริ่มต้นได้ทีละตัว" ของกลุ่มเลือกอย่างเดียวให้ด้วย
  if (req.body?.isDefault) await db.setOptionItemDefault(id, shop.id, true);
  res.json({ ok: true, message: 'เพิ่มตัวเลือกแล้ว', id });
});

router.put('/api/shop/option-items/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  if (!await db.findOptionItemOwned(id, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบตัวเลือก' });
  const fields = {};
  if (req.body?.name !== undefined) {
    const name = clip(req.body.name, 120);
    if (!name) return res.status(400).json({ ok: false, message: 'กรุณากรอกชื่อตัวเลือก' });
    fields.name = name;
  }
  if (req.body?.priceDelta !== undefined) fields.priceDelta = Number(req.body.priceDelta) || 0;
  if (req.body?.sortOrder !== undefined) fields.sortOrder = Number(req.body.sortOrder) || 0;
  await db.updateOptionItem(id, shop.id, fields);
  // มาร์ค/ยกเลิก "ค่าเริ่มต้น" — ตัวเลือกที่มาร์คไว้จะถูกติ๊กให้อัตโนมัติเมื่อลูกค้าเลือกเมนูที่ใช้กลุ่มนี้
  if (req.body?.isDefault !== undefined) {
    await db.setOptionItemDefault(id, shop.id, !!req.body.isDefault);
  }
  res.json({ ok: true, message: req.body?.isDefault === undefined ? 'บันทึกตัวเลือกแล้ว' : (req.body.isDefault ? 'ตั้งเป็นค่าเริ่มต้นแล้ว' : 'ยกเลิกค่าเริ่มต้นแล้ว') });
});

router.delete('/api/shop/option-items/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  if (!await db.findOptionItemOwned(id, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบตัวเลือก' });
  await db.deleteOptionItem(id, shop.id);
  res.json({ ok: true, message: 'ลบตัวเลือกแล้ว' });
});

// ---------- อัปโหลดรูป (base64 JSON → ไฟล์ใน public/uploads/shops) ----------
router.post('/api/shop/upload', requireShop, (req, res) => {
  const dataUrl = String(req.body?.dataUrl || '');
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return res.status(400).json({ ok: false, message: 'ไฟล์รูปไม่ถูกต้อง (รองรับ png/jpeg/webp/gif)' });

  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_UPLOAD_BYTES) return res.status(400).json({ ok: false, message: 'ไฟล์ใหญ่เกิน 3MB' });

  try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch { /* มีอยู่แล้ว */ }
  const name = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + '.' + IMAGE_TYPES[m[1]];
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  res.json({ ok: true, url: '/uploads/shops/' + name });
});

// ---------------------------------------------------------------------------
// การชำระเงินของร้าน (เจ้าของร้านตั้งเองได้ทั้งหมด รวมคีย์ EasySlip)
// ---------------------------------------------------------------------------

const digitsOnly = (v) => String(v == null ? '' : v).replace(/\D/g, '');
/** มาสก์คีย์ให้เห็นแค่บางส่วน (ไม่ส่งคีย์จริงกลับไปให้หน้าจอ) */
const maskKey = (key) => {
  const k = String(key || '');
  if (!k) return '';
  return k.length <= 8 ? '••••' : k.slice(0, 4) + '••••' + k.slice(-4);
};
const shopPayInfo = (shop) => ({
  settings: {
    enabled: Number(shop.pay_enabled) === 1,
    promptpayId: shop.pay_promptpay_id || '',
    bankName: shop.pay_bank_name || '',
    bankAccount: shop.pay_bank_account || '',
    bankHolder: shop.pay_bank_holder || '',
    note: shop.pay_note || '',
    expireMinutes: Number(shop.pay_expire_minutes) || 10,
  },
  slip: {
    configured: Boolean(String(shop.slip_api_key || '').trim()),
    keyMasked: maskKey(shop.slip_api_key),
    autoApprove: Number(shop.slip_auto_approve) === 1,
  },
  // รับเงินโอนได้จริงไหม = เปิดรับ + มีช่องทางรับเงิน + ต่อคีย์ EasySlip แล้ว
  transferReady: orderPay.canTransfer(shop),
});

router.get('/api/shop/payment-settings', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  res.json(Object.assign({ ok: true }, shopPayInfo(shop)));
});

router.put('/api/shop/payment-settings', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const body = req.body || {};
  const fields = {};

  if (body.enabled !== undefined) fields.payEnabled = !!body.enabled;
  if (body.promptpayId !== undefined) {
    const pp = digitsOnly(body.promptpayId).slice(0, 30);
    // เบอร์โทร 10 หลัก · เลขบัตรประชาชน 13 หลัก · e-Wallet 15 หลัก
    if (pp && ![10, 13, 15].includes(pp.length)) {
      return res.status(400).json({ ok: false, field: 'promptpayId', message: 'หมายเลขพร้อมเพย์ต้องเป็นเบอร์โทร 10 หลัก หรือเลขบัตรประชาชน 13 หลัก' });
    }
    fields.payPromptpayId = pp;
  }
  if (body.bankName !== undefined) fields.payBankName = clip(body.bankName, 120);
  if (body.bankAccount !== undefined) fields.payBankAccount = digitsOnly(body.bankAccount).slice(0, 40);
  if (body.bankHolder !== undefined) fields.payBankHolder = clip(body.bankHolder, 120);
  if (body.note !== undefined) fields.payNote = clip(body.note, 255);
  if (body.expireMinutes !== undefined) {
    const m = Number(body.expireMinutes);
    fields.payExpireMinutes = Number.isFinite(m) ? Math.min(Math.max(Math.round(m), 1), 60) : 10;
  }
  if (body.slipApiKey !== undefined && String(body.slipApiKey).trim()) {
    fields.slipApiKey = clip(body.slipApiKey, 255);      // ว่าง = เก็บคีย์เดิมไว้
  }
  if (body.slipAutoApprove !== undefined) fields.slipAutoApprove = !!body.slipAutoApprove;

  // ตรวจความครบถ้วนจากค่าที่จะกลายเป็นหลังบันทึก
  const merged = Object.assign({}, shop, {
    pay_enabled: fields.payEnabled === undefined ? Number(shop.pay_enabled) : (fields.payEnabled ? 1 : 0),
    pay_promptpay_id: fields.payPromptpayId === undefined ? shop.pay_promptpay_id : fields.payPromptpayId,
    pay_bank_name: fields.payBankName === undefined ? shop.pay_bank_name : fields.payBankName,
    pay_bank_account: fields.payBankAccount === undefined ? shop.pay_bank_account : fields.payBankAccount,
    slip_api_key: fields.slipApiKey === undefined ? shop.slip_api_key : fields.slipApiKey,
    slip_auto_approve: fields.slipAutoApprove === undefined ? Number(shop.slip_auto_approve) : (fields.slipAutoApprove ? 1 : 0),
  });
  if (Number(merged.pay_enabled) === 1) {
    if (!merged.pay_promptpay_id && !merged.pay_bank_account) {
      return res.status(400).json({ ok: false, field: 'promptpayId', message: 'เปิดรับชำระเงินแล้ว ต้องกรอกพร้อมเพย์หรือเลขบัญชีธนาคารอย่างน้อยหนึ่งอย่าง' });
    }
    if (merged.pay_bank_account && !merged.pay_bank_name) {
      return res.status(400).json({ ok: false, field: 'bankName', message: 'กรอกเลขบัญชีแล้ว ต้องระบุชื่อธนาคารด้วย' });
    }
    if (Number(merged.slip_auto_approve) === 1 && !merged.slip_api_key) {
      return res.status(400).json({ ok: false, field: 'slipApiKey', message: 'เปิดตรวจสลิปอัตโนมัติแล้ว ต้องใส่คีย์ EasySlip ด้วย' });
    }
  }

  await db.updateShop(shop.id, fields);
  const updated = await db.findShopByUserId(req.user.id);
  console.log(`💳 บันทึกการชำระเงินของร้าน "${updated.name}" (โอน: ${orderPay.canTransfer(updated) ? 'พร้อม' : 'ยังไม่พร้อม'})`);
  res.json(Object.assign({ ok: true, message: 'บันทึกการชำระเงินแล้ว' }, shopPayInfo(updated)));
});

// ---------------------------------------------------------------------------
// เวลาเปิด–ปิดร้าน · วันเปิดทำการ · ปิดร้านวันนี้
// ---------------------------------------------------------------------------
router.put('/api/shop/hours', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const body = req.body || {};
  const fields = {};
  const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (body.openTime !== undefined) {
    const v = String(body.openTime || '').trim();
    if (v && !timeRe.test(v)) return res.status(400).json({ ok: false, field: 'openTime', message: 'เวลาเปิดไม่ถูกต้อง (รูปแบบ HH:MM)' });
    fields.openTime = v || null;
  }
  if (body.closeTime !== undefined) {
    const v = String(body.closeTime || '').trim();
    if (v && !timeRe.test(v)) return res.status(400).json({ ok: false, field: 'closeTime', message: 'เวลาปิดไม่ถูกต้อง (รูปแบบ HH:MM)' });
    fields.closeTime = v || null;
  }
  if (body.openDays !== undefined) {
    // ตรวจจากค่าที่ส่งมาจริง (ไม่ใช้ค่าเริ่มต้นของ parseOpenDays) — ส่งมาแล้วว่าง = ปฏิเสธ ไม่ใช่เปิดทุกวัน
    const rawDays = Array.isArray(body.openDays) ? body.openDays : String(body.openDays || '').split(',');
    const picked = [...new Set(rawDays.map((x) => Number(String(x).trim())).filter((n) => n >= 1 && n <= 7))].sort((a, b) => a - b);
    if (!picked.length) return res.status(400).json({ ok: false, field: 'openDays', message: 'เลือกวันเปิดทำการอย่างน้อย 1 วัน' });
    fields.openDays = picked.join(',');
  }
  const mergedTimes = {
    open_time: fields.openTime === undefined ? shop.open_time : fields.openTime,
    close_time: fields.closeTime === undefined ? shop.close_time : fields.closeTime,
  };
  const from = mergedTimes.open_time ? shopHours.toMinutes(String(mergedTimes.open_time).slice(0, 5)) : null;
  const to = mergedTimes.close_time ? shopHours.toMinutes(String(mergedTimes.close_time).slice(0, 5)) : null;
  if ((from == null) !== (to == null)) {
    return res.status(400).json({ ok: false, field: 'openTime', message: 'กรอกเวลาเปิดและเวลาปิดให้ครบคู่ (หรือเว้นว่างทั้งคู่ = เปิดตลอด)' });
  }

  await db.updateShop(shop.id, fields);
  const updated = await db.findShopByUserId(req.user.id);
  console.log(`🕒 ตั้งเวลาเปิด–ปิดร้าน "${updated.name}": ${updated.open_time ? String(updated.open_time).slice(0, 5) + '–' + String(updated.close_time).slice(0, 5) : 'เปิดตลอด'} · วันที่เปิด ${updated.open_days}`);
  res.json({ ok: true, message: 'บันทึกเวลาเปิด–ปิดร้านแล้ว', hours: shopHours.openState(updated), delete: null });
});

/** ปิดร้านวันนี้ (กดแล้วปิดทั้งวัน หมดอายุเองเมื่อขึ้นวันใหม่) */
router.put('/api/shop/close-today', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const closed = !!req.body?.closed;
  const today = shopHours.shopDate();
  await db.updateShop(shop.id, { closedDate: closed ? today : null });
  const updated = await db.findShopByUserId(req.user.id);
  console.log(`🚪 ร้าน "${updated.name}": ${closed ? 'ปิดร้านวันนี้ (' + today + ')' : 'เปิดร้านตามปกติ'}`);
  res.json({
    ok: true,
    closed,
    message: closed ? 'ปิดร้านวันนี้แล้ว — ลูกค้าจะสั่งอาหารไม่ได้จนถึงเที่ยงคืน (เปิดใหม่ได้ทุกเมื่อ)' : 'เปิดร้านตามปกติแล้ว',
    hours: shopHours.openState(updated),
  });
});


// ทดสอบการเชื่อมต่อ EasySlip ด้วยคีย์ของร้าน (ส่งรูปจิ๋วที่ตั้งใจให้อ่านไม่ได้ → ไม่กินเครดิตในกรณีปกติ)
// ใช้ดูว่าคีย์/แพ็กเกจยังใช้ได้ไหม โดยไม่ต้องรอลูกค้าอัปสลิปจริง
router.post('/api/shop/payment-settings/test-slip', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const slipSettings = slipVerify.getSlipSettings(shop);
  if (!slipSettings.configured) {
    return res.status(400).json({ ok: false, message: 'ยังไม่ได้ใส่คีย์ EasySlip — ใส่คีย์ก่อนแล้วบันทึก' });
  }
  // PNG 1x1 พิกเซล (โปร่งใส) — ผู้ให้บริการจะตอบว่า 'อ่านรูปไม่ได้' ซึ่งแปลว่าคีย์ยังใช้งานได้
  const dummy = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
  const r = await slipVerify.verifySlip(dummy, 0, slipSettings);
  const shopProblem = slipVerify.isShopConfigCode(r.code);
  const okConnect = r.code === 'invalid_image' || r.code === 'slip_not_found' || r.code === 'verified';
  res.json({
    ok: true,
    connected: okConnect,
    code: r.code || '',
    provider_code: r.providerCode || '',
    message: okConnect
      ? 'เชื่อมต่อ EasySlip ได้ปกติ — คีย์ใช้งานได้ (ผู้ให้บริการตอบว่า: ' + (r.providerCode || r.code) + ')'
      : (r.message || 'เชื่อมต่อไม่สำเร็จ'),
  });
});
module.exports = router;

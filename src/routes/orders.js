/**
 * orders.js — โต๊ะ + QR + บิล/ออเดอร์ (ฝั่งเจ้าของร้าน) และหน้าร้านสำหรับลูกค้า (/order/:token)
 */
'use strict';

const path = require('node:path');
const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const { sendShopPage } = require('../lib/shop-page');
const { getCurrentUser, requireShop } = require('../middleware/auth');
const { isShop } = require('../lib/roles');
const { randomToken } = require('../lib/crypto');
const realtime = require('../lib/realtime');
const { buildOrderItems } = require('../lib/order-builder');
const notify = require('../lib/notify');

const router = express.Router();
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const clip = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const MAX_QR_URL = 200;

// ตรวจ origin สำหรับลิงก์ใน QR (กันค่าที่ไม่ใช่ http/https)
function safeOrigin(req) {
  const raw = String(req.query.origin || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^\s"'<>]{1,180}$/i.test(raw)) return raw;
  return `${req.protocol}://${req.get('host')}`;
}

async function requireShopPage(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl || '/shop'));
  if (user.status !== 'active') return res.redirect(user.provider === 'google' ? '/google-setup.html' : '/otp.html');
  if (!isShop(user.role)) return res.redirect('/shop');
  req.user = user;
  next();
}

async function myShop(req, res) {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) {
    res.status(400).json({ ok: false, message: 'กรุณาตั้งข้อมูลร้านก่อน' });
    return null;
  }
  res.locals.shopId = shop.id; // ให้ middleware เรียลไทม์รู้ว่ากำลังแก้ข้อมูลของร้านไหน
  return shop;
}

// ---------------------------------------------------------------------------
// หน้าเว็บ
// แจ้งเตือนเรียลไทม์อัตโนมัติเมื่อมีการแก้ "โต๊ะ/โซน/รายชื่อโต๊ะ" สำเร็จ
// (เส้นทางที่เปลี่ยนข้อมูลบิล/รายการ มีการแจ้งเตือนเฉพาะเจาะจงอยู่แล้วด้านล่าง)
router.use('/api/shop', (req, res, next) => {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') return next();
  const url = String(req.originalUrl || req.url).split('?')[0];
  const isTableMeta = /^\/api\/shop\/(table-names|zones|qr-auto-delete)(\/|$)/.test(url)
    || /^\/api\/shop\/tables(\/\d+)?$/.test(url);
  if (!isTableMeta) return next();
  res.on('finish', () => {
    if (res.statusCode < 400 && res.locals.shopId) realtime.publish(res.locals.shopId, 'tables_changed', {});
  });
  next();
});

// ---------------------------------------------------------------------------
// อัปเดตเรียลไทม์ (SSE) — ครัว/แคชเชียร์/หน้าสั่งอาหาร เปิดค้างไว้ที่เส้นทางนี้
// เซิร์ฟเวอร์จะผลักเหตุการณ์ทันทีที่ข้อมูลของร้านเปลี่ยน (ลูกค้าสั่ง / เปลี่ยนสถานะ / เช็คบิล / แก้โต๊ะ)
// ---------------------------------------------------------------------------
router.get('/api/shop/events', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  realtime.sseHandler(shop.id, req, res);
});

// ---------------------------------------------------------------------------
// หน้าสั่งอาหาร (เจ้าของร้าน) — จัดการโต๊ะ/QR + บิลที่เปิดอยู่
router.get('/shop/orders.html', requireShopPage, async (req, res) => {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) return res.redirect('/shop/setup.html');
  await sendShopPage(res, 'orders.html', shop);
});

// หน้าตั้งค่าระบบของร้าน (เจ้าของร้าน) — เช่น สวิตช์ปิดใช้งาน QR อัตโนมัติเมื่อเช็คบิล
router.get('/shop/settings.html', requireShopPage, async (req, res) => {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) return res.redirect('/shop/setup.html');
  await sendShopPage(res, 'settings.html', shop);
});

// หน้าสั่งอาหารของลูกค้า (สาธารณะ) — ใช้ token ของโต๊ะ
router.get('/order/:token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'order', 'index.html'));
});

// หน้ารายละเอียดโต๊ะ (เจ้าของร้าน) — เปิดจากการกดช่องโต๊ะในหน้าสั่งอาหาร
router.get('/shop/table.html', requireShopPage, async (req, res) => {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) return res.redirect('/shop/setup.html');
  await sendShopPage(res, 'table.html', shop);
});

// ---------------------------------------------------------------------------
// API ฝั่งร้าน: โต๊ะ + QR
// สร้างโทเคน QR ใหม่ที่ไม่ซ้ำกับโต๊ะที่ใช้งานอยู่ และไม่เคยถูกยกเลิกไปแล้ว
// (รับประกันว่า QR ที่ลบไปแล้วจะไม่ถูกนำกลับมาใช้ใหม่)
async function freshTableToken() {
  for (let i = 0; i < 10; i++) {
    const token = randomToken().slice(0, 16);
    if (!await db.isTableTokenTaken(token)) return token;
  }
  // แทบไม่เกิดขึ้น (สุ่ม 64 บิต) — กันเหนียวด้วยการต่อเวลาเข้าไป
  return randomToken().slice(0, 8) + Date.now().toString(36).slice(-8);
}

// ---------------------------------------------------------------------------
// รายชื่อโต๊ะ (แคตตาล็อก) — สร้าง/ลบชื่อไว้ล่วงหน้า แล้วค่อยเลือกตอนสร้าง QR
// ---------------------------------------------------------------------------
router.get('/api/shop/table-names', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const [names, zones] = await Promise.all([db.listTableNamesWithQr(shop.id), db.listZones(shop.id)]);
  res.json({
    ok: true,
    zones: zones.map((z) => ({ id: z.id, name: z.name, table_count: z.table_count })),
    names: names.map((n) => ({
      id: n.id, name: n.name, has_qr: Boolean(n.table_id), table_id: n.table_id || null,
      zone_id: n.zone_id || null, zone_name: n.zone_name || null,
    })),
  });
});

// จัดลำดับการแสดงของชื่อโต๊ะ (ต้องประกาศก่อน /:id เพื่อไม่ให้ทับกัน)
router.post('/api/shop/table-names/reorder', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const order = Array.isArray(req.body?.order) ? req.body.order : [];
  if (!order.length) return res.status(400).json({ ok: false, message: 'ไม่มีลำดับที่ส่งมา' });
  await db.reorderTableNames(shop.id, order);
  res.json({ ok: true, message: 'บันทึกลำดับโต๊ะแล้ว' });
});

router.post('/api/shop/table-names', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const name = clip(req.body?.name, 30);
  if (!name) return res.status(400).json({ ok: false, field: 'name', message: 'กรุณากรอกชื่อโต๊ะ (เช่น 1, A2, โต๊ะริมหน้าต่าง)' });
  if (await db.findTableNameByName(shop.id, name)) {
    return res.status(409).json({ ok: false, field: 'name', message: `มีชื่อ "${name}" อยู่ในรายชื่อแล้ว` });
  }
  await db.ensureTableName({ shopId: shop.id, name });
  // กำหนดโซนให้ตั้งแต่ตอนเพิ่มได้เลย (ถ้าเลือกไว้)
  const zoneId = Number(req.body?.zoneId) || 0;
  if (zoneId && await db.findZoneById(zoneId, shop.id)) {
    const added = await db.findTableNameByName(shop.id, name);
    if (added) await db.setTableNameZone(added.id, shop.id, zoneId);
  }
  res.json({ ok: true, message: `เพิ่ม "${name}" เข้ารายชื่อโต๊ะแล้ว` });
});

// ย้ายชื่อโต๊ะเข้าโซน (zoneId = 0/null คือไม่ระบุโซน)
router.put('/api/shop/table-names/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  const name = await db.findTableNameById(id, shop.id);
  if (!name) return res.status(404).json({ ok: false, message: 'ไม่พบชื่อโต๊ะนี้' });
  if (req.body?.zoneId !== undefined) {
    const zoneId = Number(req.body.zoneId) || 0;
    if (zoneId && !await db.findZoneById(zoneId, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบโซนที่เลือก' });
    await db.setTableNameZone(id, shop.id, zoneId || null);
  }
  res.json({ ok: true, message: 'บันทึกแล้ว' });
});

router.delete('/api/shop/table-names/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  const name = await db.findTableNameById(id, shop.id);
  if (!name) return res.status(404).json({ ok: false, message: 'ไม่พบชื่อโต๊ะนี้' });
  // ถ้ายังมี QR (โต๊ะ) ที่ใช้งานชื่อนี้อยู่ ห้ามลบจากรายชื่อ
  if (await db.findTableByCode(shop.id, name.name)) {
    return res.status(409).json({ ok: false, message: `ลบไม่ได้ — ยังมี QR ของโต๊ะ "${name.name}" ใช้งานอยู่ (ลบ QR ก่อน)` });
  }
  await db.deleteTableName(id, shop.id);
  res.json({ ok: true, message: `ลบ "${name.name}" ออกจากรายชื่อแล้ว` });
});

// ---------------------------------------------------------------------------
// โซน (จัดกลุ่มโต๊ะ) — สร้าง/เปลี่ยนชื่อ/ลบ/จัดลำดับ
// ---------------------------------------------------------------------------
router.get('/api/shop/zones', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  res.json({ ok: true, zones: await db.listZones(shop.id) });
});

router.post('/api/shop/zones', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const name = clip(req.body?.name, 60);
  if (!name) return res.status(400).json({ ok: false, field: 'name', message: 'กรุณากรอกชื่อโซน (เช่น ในร้าน, ริมระเบียง, ชั้น 2)' });
  if (await db.findZoneByName(shop.id, name)) {
    return res.status(409).json({ ok: false, field: 'name', message: `มีโซน "${name}" อยู่แล้ว` });
  }
  const id = await db.createZone({ shopId: shop.id, name });
  res.json({ ok: true, message: `เพิ่มโซน "${name}" แล้ว`, id });
});

router.put('/api/shop/zones/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  const zone = await db.findZoneById(id, shop.id);
  if (!zone) return res.status(404).json({ ok: false, message: 'ไม่พบโซนนี้' });
  const name = clip(req.body?.name, 60);
  if (!name) return res.status(400).json({ ok: false, field: 'name', message: 'กรุณากรอกชื่อโซน' });
  const dup = await db.findZoneByName(shop.id, name);
  if (dup && dup.id !== id) return res.status(409).json({ ok: false, field: 'name', message: `มีโซน "${name}" อยู่แล้ว` });
  await db.renameZone(id, shop.id, name);
  res.json({ ok: true, message: 'เปลี่ยนชื่อโซนแล้ว' });
});

router.delete('/api/shop/zones/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  const zone = await db.findZoneById(id, shop.id);
  if (!zone) return res.status(404).json({ ok: false, message: 'ไม่พบโซนนี้' });
  await db.deleteZone(id, shop.id);
  res.json({ ok: true, message: `ลบโซน "${zone.name}" แล้ว (โต๊ะในโซนนี้กลายเป็นไม่ระบุโซน)` });
});

router.post('/api/shop/zones/reorder', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const order = Array.isArray(req.body?.order) ? req.body.order : [];
  if (!order.length) return res.status(400).json({ ok: false, message: 'ไม่มีลำดับที่ส่งมา' });
  await db.reorderZones(shop.id, order);
  res.json({ ok: true, message: 'บันทึกลำดับโซนแล้ว' });
});

router.get('/api/shop/tables', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const [tables, openOrders, catalog] = await Promise.all([
    db.listTables(shop.id),
    db.listOpenOrders(shop.id),
    db.listTableNamesWithQr(shop.id),
  ]);
  const byTable = {};
  openOrders.forEach((o) => { if (o.table_id) byTable[o.table_id] = o; });
  const zoneByName = {};
  catalog.forEach((n) => { zoneByName[n.name] = n.zone_name || null; });
  res.json({
    ok: true,
    delete_qr_on_checkout: Number(shop.delete_qr_on_checkout) === 1,
    tables: tables.map((t) => ({
      id: t.id, code: t.code, token: t.token,
      zone_name: zoneByName[t.code] || null,
      open_order: byTable[t.id] || null,
    })),
  });
});

// เปิด/ปิด "ลบ QR ทันทีเมื่อเช็คบิล"
router.put('/api/shop/qr-auto-delete', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const enabled = !!req.body?.enabled;
  await db.updateShop(shop.id, { deleteQrOnCheckout: enabled ? 1 : 0 });
  console.log(`🧾 ตั้งค่า "${shop.name}": ปิดใช้งาน QR อัตโนมัติเมื่อเช็คบิล = ${enabled ? 'เปิด' : 'ปิด'}`);
  res.json({
    ok: true,
    enabled,
    message: enabled
      ? 'เปิดแล้ว — เมื่อเช็คบิล QR ของโต๊ะนั้นจะถูกปิดใช้งานทันที (ต้องสร้าง QR ใหม่ก่อนให้ลูกค้าสั่งครั้งถัดไป)'
      : 'ปิดแล้ว — เมื่อเช็คบิล โต๊ะและ QR จะยังใช้งานต่อ และเปิดบิลใหม่ให้อัตโนมัติ',
  });
});

router.post('/api/shop/tables', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  // เลือกจากรายชื่อโต๊ะ (nameId) หรือพิมพ์ชื่อใหม่ (code)
  const nameId = Number(req.body?.nameId) || 0;
  let code = '';
  if (nameId) {
    const picked = await db.findTableNameById(nameId, shop.id);
    if (!picked) return res.status(404).json({ ok: false, message: 'ไม่พบชื่อโต๊ะที่เลือก' });
    code = picked.name;
  } else {
    code = clip(req.body?.code, 30);
  }
  if (!code) return res.status(400).json({ ok: false, field: 'code', message: 'กรุณาเลือกหรือกรอกเลขโต๊ะ (เช่น 1, A2, โต๊ะริมหน้าต่าง)' });
  if (await db.findTableByCode(shop.id, code)) {
    return res.status(409).json({ ok: false, field: 'code', message: `โต๊ะ "${code}" มี QR ที่ใช้งานอยู่แล้ว` });
  }
  await db.ensureTableName({ shopId: shop.id, name: code }); // พิมพ์ชื่อใหม่ → เข้ารายชื่อให้ด้วย
  // ถ้าเลือกโซนไว้ตอนสร้าง ก็จัดชื่อเข้าโซนนั้นให้เลย
  const newZoneId = Number(req.body?.zoneId) || 0;
  if (newZoneId && await db.findZoneById(newZoneId, shop.id)) {
    const added = await db.findTableNameByName(shop.id, code);
    if (added) await db.setTableNameZone(added.id, shop.id, newZoneId);
  }
  const id = await db.createTable({ shopId: shop.id, code, token: await freshTableToken() });
  // เปิดบิลตั้งต้นให้โต๊ะทันที (มีเลขที่บิล) — ลูกค้าสแกนแล้วเห็นเลขบิลได้เลย
  await db.createOrder({ shopId: shop.id, tableId: id });
  console.log(`🧾 สร้าง QR โต๊ะ "${code}" (${shop.name})`);
  res.json({ ok: true, message: `สร้าง QR โต๊ะ "${code}" แล้ว`, id });
});

router.put('/api/shop/tables/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  const table = await db.findTableById(id, shop.id);
  if (!table) return res.status(404).json({ ok: false, message: 'ไม่พบโต๊ะ' });
  const code = clip(req.body?.code, 30);
  if (!code) return res.status(400).json({ ok: false, field: 'code', message: 'กรุณากรอกชื่อโต๊ะ' });
  const dup = await db.findTableByCode(shop.id, code);
  if (dup && dup.id !== id) return res.status(409).json({ ok: false, field: 'code', message: `มีโต๊ะชื่อ "${code}" อยู่แล้ว` });
  await db.updateTableCode(id, shop.id, code);
  // เปลี่ยนชื่อโต๊ะแล้วให้รายชื่อโต๊ะตรงกันด้วย: ชื่อใหม่เข้ารายชื่อ / ชื่อเดิมออกจากรายชื่อ (ถ้าไม่มีใครใช้แล้ว)
  if (table.code !== code) {
    await db.ensureTableName({ shopId: shop.id, name: code });
    const oldName = await db.findTableNameByName(shop.id, table.code);
    if (oldName && !await db.findTableByCode(shop.id, table.code)) await db.deleteTableName(oldName.id, shop.id);
  }
  res.json({ ok: true, message: `เปลี่ยนชื่อโต๊ะเป็น "${code}" แล้ว` });
});

router.delete('/api/shop/tables/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  const table = await db.findTableById(id, shop.id);
  if (!table) return res.status(404).json({ ok: false, message: 'ไม่พบโต๊ะ' });

  // ห้ามปิดใช้งานถ้าบิลปัจจุบันยังไม่ถูกเช็คบิล (มีรายการค้างอยู่)
  const open = await db.findOpenOrder(shop.id, id);
  if (open) {
    const items = await db.listOrderItems(open.id);
    if (items.length) {
      return res.status(409).json({
        ok: false,
        message: `ปิดใช้งานไม่ได้ เพราะโต๊ะ "${table.code}" ยังมีบิลที่ยังไม่เช็คบิล — กรุณากดเช็คบิลก่อน`,
      });
    }
  }

  // ยกเลิกโทเคน QR ของโต๊ะนี้ถาวร — สแกน QR เก่าแล้วจะใช้ไม่ได้อีกและจะไม่ถูกนำกลับมาใช้ใหม่
  await db.retireTableToken(table.token, shop.id);
  // ปิดใช้งาน (ไม่ลบแถวทิ้ง) — โต๊ะและรูป QR ยังดูย้อนหลังได้ใน "ประวัติ QR" เพื่อเป็นหลักฐาน
  await db.retireTable(id, shop.id);
  // บิลที่ยังเปิดอยู่แต่ยังไม่มีรายการ (ตั๋วเปล่า) เช็คบิลไม่ได้อีกเพราะโต๊ะถูกปิด — ลบทิ้งไม่ให้ค้าง
  if (open) await db.deleteOrder(open.id, shop.id);
  console.log(`🧾 ปิดใช้งาน QR โต๊ะ "${table.code}" (${shop.name}) — ยกเลิกโทเคนถาวรแล้ว`);
  res.json({ ok: true, message: `ปิดใช้งาน QR ของโต๊ะ "${table.code}" แล้ว (QR เดิมใช้ไม่ได้อีก · ดูย้อนหลังได้ใน "ประวัติ QR")` });
});

// ประวัติ QR โต๊ะที่ถูกปิดใช้งานแล้ว (เก็บไว้เป็นหลักฐาน)
router.get('/api/shop/tables/retired', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const tables = await db.listRetiredTables(shop.id);
  res.json({ ok: true, tables });
});

// รูป QR ของโต๊ะ (PNG) — ชี้ไป /order/<token>
// ใช้ได้ทั้งโต๊ะที่ยังใช้งานและที่ปิดใช้งานแล้ว (เพื่อดู/ดาวน์โหลด QR เดิมเป็นหลักฐาน)
router.get('/api/shop/tables/:id/qr', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const table = await db.findTableByIdAny(Number(req.params.id), shop.id);
  if (!table) return res.status(404).json({ ok: false, message: 'ไม่พบโต๊ะ' });

  const url = `${safeOrigin(req)}/order/${table.token}`.slice(0, MAX_QR_URL);
  try {
    const png = await QRCode.toBuffer(url, { type: 'png', width: 320, margin: 1 });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(png);
  } catch (err) {
    res.status(500).json({ ok: false, message: 'สร้าง QR ไม่สำเร็จ' });
  }
});

// ---------------------------------------------------------------------------
// API ฝั่งร้าน: บิลที่เปิดอยู่ + เช็คบิล
// ---------------------------------------------------------------------------
router.get('/api/shop/orders/open', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const orders = await db.listOpenOrders(shop.id);
  const withItems = [];
  for (const o of orders) {
    withItems.push({ ...o, items: await db.listOrderItems(o.id) });
  }
  res.json({ ok: true, orders: withItems });
});

router.post('/api/shop/tables/:id/checkout', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const table = await db.findTableById(Number(req.params.id), shop.id);
  if (!table) return res.status(404).json({ ok: false, message: 'ไม่พบโต๊ะ' });

  const open = await db.findOpenOrder(shop.id, table.id);
  let closed = null;
  let closedItems = [];
  if (open) {
    const items = await db.listOrderItems(open.id);
    // นับ "รายการ" เป็นจำนวนจาน (ผลรวม quantity) ให้ตรงกับที่แสดงบนหน้าจอและในแจ้งเตือน
    const platesOf = (list) => list.reduce((n, i) => n + (Number(i.quantity) || 0), 0);
    // ห้ามเช็คบิลถ้ายังมีรายการรอทำ/กำลังทำ (ทุกจุด: ครัว + แคชเชียร์)
    const uncleared = platesOf(items.filter((i) => i.status === 'pending' || i.status === 'cooking'));
    if (uncleared) {
      return res.status(409).json({
        ok: false,
        message: `ยังเช็คบิลไม่ได้ — ยังมีรายการไม่เคลียร์ ${uncleared} รายการ (รอทำ/กำลังทำ ทั้งครัวและแคชเชียร์)`,
      });
    }
    await db.closeOrder(open.id);
    closed = {
      order_id: open.id, table_code: table.code, bill_no: open.bill_no || null,
      total: Number(open.total),
      item_count: platesOf(items.filter((i) => i.status !== 'cancelled')),
    };
    closedItems = items;
  }
  // ถ้าเปิด "ปิดใช้งาน QR อัตโนมัติเมื่อเช็คบิล" → ปิดใช้งานโต๊ะ (เก็บไว้ในประวัติ) + ยกเลิกโทเคนถาวร ไม่เปิดบิลใหม่
  // ถ้าปิด → เปิดบิลใหม่ว่างให้โต๊ะเดิมทันที
  const autoDeleteQr = Number(shop.delete_qr_on_checkout) === 1;
  let qrDeleted = false;
  if (autoDeleteQr) {
    await db.retireTableToken(table.token, shop.id);
    await db.retireTable(table.id, shop.id);
    qrDeleted = true;
  } else {
    await db.createOrder({ shopId: shop.id, tableId: table.id });
  }
  console.log(`🧾 เช็คบิลโต๊ะ ${table.code} (${shop.name})${closed ? ' ยอด ' + closed.total : ' (ไม่มีรายการ)'}${qrDeleted ? ' · ปิดใช้งาน QR ทันที (เก็บไว้ในประวัติ)' : ''}`);

  if (closed) {
    void notify.notifyShop(shop.id, 'checkout', notify.buildCheckoutText({
      shopName: shop.name,
      tableCode: closed.table_code,
      billNo: closed.bill_no,
      total: closed.total,
      items: closedItems,
    }));
  }
  realtime.publish(shop.id, 'checkout', { table_code: table.code });
  res.json({
    ok: true,
    message: qrDeleted
      ? `เช็คบิลโต๊ะ "${table.code}" แล้ว และปิดใช้งาน QR ของโต๊ะนี้ทันที — ต้องสร้าง QR ใหม่ก่อนให้ลูกค้าสั่งครั้งถัดไป (QR เดิมยังดูย้อนหลังได้ที่ "ประวัติ QR")`
      : `เช็คบิลโต๊ะ "${table.code}" แล้ว`,
    closed,
    qr_deleted: qrDeleted,
  });
});

// ---------------------------------------------------------------------------
// แคชเชียร์: เพิ่มอาหารเข้าบิล / ลบรายการออกจากบิล
// ---------------------------------------------------------------------------
router.post('/api/shop/tables/:id/items', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const table = await db.findTableById(Number(req.params.id), shop.id);
  if (!table) return res.status(404).json({ ok: false, message: 'ไม่พบโต๊ะ' });
  const open = await db.findOpenOrder(shop.id, table.id);
  if (!open) return res.status(400).json({ ok: false, message: 'ไม่มีบิลที่เปิดอยู่' });

  let prepared;
  try { prepared = await buildOrderItems(shop.id, req.body?.items); }
  catch (err) { return res.status(err.status || 400).json({ ok: false, message: err.message }); }

  await db.addOrderItems(open.id, prepared);
  const fresh = await db.findOpenOrder(shop.id, table.id);
  const items = await db.listOrderItems(open.id);
  console.log(`🧾 [แคชเชียร์] เพิ่มอาหาร โต๊ะ ${table.code} ${prepared.length} รายการ`);

  void notify.notifyShop(shop.id, 'order_new', notify.buildOrderNewText({
    shopName: shop.name,
    tableCode: table.code,
    billNo: fresh.bill_no,
    items: items.slice(-prepared.length),
    total: Number(fresh.total),
    source: 'แคชเชียร์เพิ่มเอง',
  }));

  realtime.publish(shop.id, 'order_new', { table_code: table.code, bill_no: fresh.bill_no });
  res.json({
    ok: true,
    message: 'เพิ่มอาหารเข้าบิลแล้ว',
    bill: { order_id: open.id, bill_no: fresh.bill_no, total: Number(fresh.total), items },
  });
});

router.delete('/api/shop/order-items/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const item = await db.findOrderItemOwned(Number(req.params.id), shop.id);
  if (!item) return res.status(404).json({ ok: false, message: 'ไม่พบรายการ' });
  if (item.order_status !== 'open') return res.status(400).json({ ok: false, message: 'บิลนี้ปิดแล้ว' });
  await db.deleteOrderItem(item.id, item.order_id);
  console.log(`🧾 [แคชเชียร์] ลบรายการ #${item.id} (${item.menu_name})`);
  realtime.publish(shop.id, 'bill_changed', { table_code: item.table_code });
  res.json({ ok: true, message: 'ลบรายการแล้ว' });
});

// ---------------------------------------------------------------------------
// หน้าครัว + หน้าแคชเชียร์ (ใช้หน้าจอเดียวกัน ต่างกันที่ "จุดแสดงผล") + สถานะรายจาน
// ---------------------------------------------------------------------------
router.get(['/shop/kitchen.html', '/shop/cashier.html'], requireShopPage, async (req, res) => {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) return res.redirect('/shop/setup.html');
  await sendShopPage(res, 'kitchen.html', shop);
});

router.get('/api/shop/kitchen', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const station = req.query.station === 'cashier' ? 'cashier' : 'kitchen';
  const items = await db.listKitchenItems(shop.id, station);
  res.json({ ok: true, station, items });
});

// เปลี่ยนสถานะรายจาน: pending (รอทำ) | cooking (กำลังทำ) | done (เคลียร์/เสร็จ) | cancelled (ยกเลิก + ต้องระบุสาเหตุ)
router.post('/api/shop/order-items/:id/status', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  const status = String(req.body?.status || '');
  if (!['pending', 'cooking', 'done', 'cancelled'].includes(status)) {
    return res.status(400).json({ ok: false, message: 'สถานะไม่ถูกต้อง' });
  }
  const item = await db.findOrderItemOwned(id, shop.id);
  if (!item) return res.status(404).json({ ok: false, message: 'ไม่พบรายการ' });
  if (item.order_status !== 'open') return res.status(400).json({ ok: false, message: 'บิลนี้ปิดแล้ว' });
  realtime.publish(shop.id, 'item_status', { table_code: item.table_code, item_id: item.id });

  if (status === 'cancelled') {
    const reason = String(req.body?.reason || '').trim().slice(0, 200);
    if (!reason) return res.status(400).json({ ok: false, field: 'reason', message: 'กรุณาระบุสาเหตุการยกเลิก' });
    await db.cancelOrderItem(id, item.order_id, reason);
    console.log(`❌ [ครัว] ยกเลิกรายการ #${id} (${item.menu_name}) — ${reason}`);
    void notify.notifyShop(shop.id, 'item_cancel', notify.buildItemCancelText({
      shopName: shop.name, tableCode: item.table_code, item, reason,
    }));
    return res.json({ ok: true, message: `ยกเลิกรายการแล้ว (${reason})` });
  }

  await db.setOrderItemStatus(id, shop.id, status);
  const msg = status === 'cooking' ? 'เริ่มทำแล้ว' : status === 'done' ? 'เคลียร์อาหารแล้ว' : 'อัปเดตแล้ว';
  if (status === 'done') {
    void notify.notifyShop(shop.id, 'item_done', notify.buildItemDoneText({
      shopName: shop.name, tableCode: item.table_code, item,
    }));
  }
  res.json({ ok: true, message: msg });
});

// ---------------------------------------------------------------------------
// ประวัติออเดอร์ (บิลที่ปิดแล้ว) — ดูย้อนหลังเป็นบิล ๆ ต่อโต๊ะ
// ---------------------------------------------------------------------------
router.get('/shop/history.html', requireShopPage, async (req, res) => {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) return res.redirect('/shop/setup.html');
  await sendShopPage(res, 'history.html', shop);
});

router.get('/api/shop/orders/history', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const tableId = req.query.tableId ? Number(req.query.tableId) : null;
  const orders = await db.listClosedOrders(shop.id, { tableId, limit: req.query.limit });
  const items = await db.listItemsForOrders(orders.map((o) => o.id));
  const byOrder = {};
  items.forEach((i) => { (byOrder[i.order_id] || (byOrder[i.order_id] = [])).push(i); });
  res.json({ ok: true, orders: orders.map((o) => ({ ...o, items: byOrder[o.id] || [] })) });
});

// หน้าใบเสร็จ (พิมพ์) — เปิดจากปุ่มเช็คบิล
router.get('/shop/receipt.html', requireShopPage, async (req, res) => {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) return res.redirect('/shop/setup.html');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'shop', 'receipt.html'));
});

// หน้าป้ายโต๊ะ (พิมพ์) — เปิดจากปุ่ม "พิมพ์ป้าย (มีเลขบิล)" ใช้รูปแบบเดียวกับใบเสร็จ
router.get('/shop/label.html', requireShopPage, async (req, res) => {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) return res.redirect('/shop/setup.html');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'shop', 'label.html'));
});

// บิลเดียว + รายการ (ใช้แสดงใบเสร็จ) — ต้องเป็นบิลของร้านตัวเอง
// หมายเหตุ: ต้องประกาศหลัง /api/shop/orders/open และ /orders/history เพื่อไม่ให้ทับเส้นทางนั้น
router.get('/api/shop/orders/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, message: 'รหัสบิลไม่ถูกต้อง' });
  const order = await db.findOrderById(id, shop.id);
  if (!order) return res.status(404).json({ ok: false, message: 'ไม่พบบิลนี้' });
  const items = await db.listOrderItems(id);
  // ใช้ชื่อโต๊ะที่เก็บไว้ในบิลก่อน — บิลที่เช็คบิลแล้วอาจไม่มีโต๊ะอยู่แล้ว ถ้าเปิดสวิตช์ "ลบ QR ทันทีเมื่อเช็คบิล"
  const table = order.table_id ? await db.findTableById(order.table_id, shop.id) : null;
  const tableCode = order.table_code || (table ? table.code : '');
  res.json({ ok: true, order: { ...order, table_code: tableCode }, items });
});

module.exports = router;

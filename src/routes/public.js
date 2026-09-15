/**
 * public.js — API สาธารณะ (ไม่ต้องล็อกอิน) สำหรับหน้าร้านลูกค้า
 */
'use strict';

const express = require('express');
const db = require('../db');
const { buildOrderItems } = require('../lib/order-builder');
const notify = require('../lib/notify');
const realtime = require('../lib/realtime');
const legal = require('../lib/legal');
const site = require('../lib/site');

const router = express.Router();

// ข้อมูลทางกฎหมาย (ชื่อผู้ให้บริการ/อีเมลติดต่อ/เวอร์ชันนโยบาย) — ใช้เติมในหน้าถ้อยแถลง
router.get('/api/public/legal', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(Object.assign({ ok: true }, legal.publicInfo()));
});

// ลิงก์โซเชียลที่ตั้งไว้หลังบ้าน (เฉพาะช่องที่กรอกจริง) — ใช้แสดงท้ายหน้าเว็บหลัก
router.get('/api/public/site', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(Object.assign({ ok: true }, site.publicInfo()));
});

// ข้อมูลร้าน + เมนูทั้งหมด สำหรับหน้าร้านสาธารณะ /s/:code
router.get('/api/public/shops/:code', async (req, res) => {
  const shop = await db.findPublicShopByCode(String(req.params.code || ''));
  if (!shop) {
    return res.status(404).json({ ok: false, message: 'ไม่พบร้านนี้ หรือร้านปิดให้บริการชั่วคราว' });
  }

  const [categories, menus, optionGroups, optionItems, menuGroups] = await Promise.all([
    db.listCategories(shop.id),
    db.listMenus(shop.id),
    db.listOptionGroups(shop.id),
    db.listOptionItems(shop.id),
    db.listMenuOptionGroups(shop.id),
  ]);

  res.json({
    ok: true,
    shop: {
      name: shop.name,
      phone: shop.phone,
      line_url: shop.line_url,
      logo_url: shop.logo_url,
      maps_url: shop.maps_url,
    },
    categories,
    menus,
    optionGroups,
    optionItems,
    menuGroups,
  });
});

// ข้อมูลโต๊ะ + เมนู + บิลที่เปิดอยู่ สำหรับหน้าร้านลูกค้า (/order/:token)
router.get('/api/public/order/:token', async (req, res) => {
  const table = await db.findOrderableTableByToken(String(req.params.token || ''));
  if (!table) {
    return res.status(404).json({ ok: false, message: 'ไม่พบโต๊ะนี้ หรือร้านปิดให้บริการชั่วคราว' });
  }

  const [categories, menus, optionGroups, optionItems, menuGroups] = await Promise.all([
    db.listCategories(table.shop_id),
    db.listMenus(table.shop_id),
    db.listOptionGroups(table.shop_id),
    db.listOptionItems(table.shop_id),
    db.listMenuOptionGroups(table.shop_id),
  ]);

  // เปิดบิลให้อัตโนมัติถ้ายังไม่มี (รองรับโต๊ะที่สร้างไว้ก่อนมีระบบบิล) — เพื่อให้มีเลขที่บิลเสมอ
  let open = await db.findOpenOrder(table.shop_id, table.id);
  if (!open) {
    await db.createOrder({ shopId: table.shop_id, tableId: table.id });
    open = await db.findOpenOrder(table.shop_id, table.id);
  }
  const bill = {
    order_id: open ? open.id : null,
    bill_no: open ? (open.bill_no || null) : null,
    total: open ? Number(open.total) : 0,
    opened_at: open ? open.opened_at : null,   // ใช้บอกว่า "บิลนี้เพิ่งเปิด" (หลังร้านเช็คบิล) หรือเปิดมานานแล้ว
    items: open ? await db.listOrderItems(open.id) : [],
  };

  res.json({
    ok: true,
    shop: {
      name: table.shop_name, public_code: table.public_code, logo_url: table.logo_url, phone: table.phone,
      line_url: table.line_url, maps_url: table.maps_url,
    },
    table: { code: table.code },
    categories, menus, optionGroups, optionItems, menuGroups,
    bill,
  });
});

// เบา ๆ: ตรวจว่าบิลที่เปิดอยู่ของโต๊ะนี้คือใบไหน (หน้าลูกค้าใช้ตรวจว่าถูกเช็คบิลไปหรือยัง)
router.get('/api/public/order/:token/bill', async (req, res) => {
  const table = await db.findOrderableTableByToken(String(req.params.token || ''));
  if (!table) return res.status(404).json({ ok: false, message: 'ไม่พบโต๊ะนี้ หรือร้านปิดให้บริการชั่วคราว' });
  const open = await db.findOpenOrder(table.shop_id, table.id);
  res.json({
    ok: true,
    order_id: open ? open.id : null,
    bill_no: open ? (open.bill_no || null) : null,
    total: open ? Number(open.total) : 0,
    opened_at: open ? open.opened_at : null,
  });
});

// ส่งรายการที่สั่งเข้ามาในบิลของโต๊ะ (ต่อเข้าบิลที่เปิดอยู่)
router.post('/api/public/order/:token/items', async (req, res) => {
  const table = await db.findOrderableTableByToken(String(req.params.token || ''));
  if (!table) {
    return res.status(404).json({ ok: false, message: 'ไม่พบโต๊ะนี้ หรือร้านปิดให้บริการชั่วคราว' });
  }

  let prepared;
  try {
    prepared = await buildOrderItems(table.shop_id, req.body?.items);
  } catch (err) {
    return res.status(err.status || 400).json({ ok: false, message: err.message });
  }

  let order = await db.findOpenOrder(table.shop_id, table.id);
  if (!order) order = { id: await db.createOrder({ shopId: table.shop_id, tableId: table.id }) };

  // หน้าที่ลูกค้าเปิดค้างไว้ผูกกับ "บิล" ใบหนึ่ง — ต้องส่งเลขบิลที่หน้านั้นกำลังดูอยู่มาด้วยเสมอ
  // ถ้าไม่ส่งมา (หน้าเก่าที่เปิดค้าง) หรือเลขบิลไม่ตรงกับบิลที่เปิดอยู่ (ร้านเพิ่งเช็คบิลไป) → ปฏิเสธ
  // ลูกค้าต้องรีเฟรชหน้า/สแกน QR ที่โต๊ะใหม่ เพื่อเริ่มผูกกับบิลใบใหม่
  const sentBillId = Number(req.body?.billId) || null;
  if (!sentBillId || sentBillId !== Number(order.id)) {
    return res.status(409).json({
      ok: false,
      closed: true,
      stale: !sentBillId,
      message: !sentBillId
        ? 'หน้าสั่งอาหารนี้เปิดค้างไว้นานเกินไป — กรุณารีเฟรชหน้า หรือสแกน QR ที่โต๊ะอีกครั้งเพื่อสั่งใหม่'
        : 'บิลก่อนหน้าถูกเช็คบิลแล้ว — กรุณาสแกน QR ที่โต๊ะอีกครั้งเพื่อสั่งใหม่',
    });
  }

  await db.addOrderItems(order.id, prepared);
  const fresh = await db.findOpenOrder(table.shop_id, table.id);
  const billItems = await db.listOrderItems(order.id);
  console.log(`🍽️ ออเดอร์ใหม่ โต๊ะ ${table.code} (${table.shop_name}) ${prepared.length} รายการ`);

  // แจ้งเตือนเจ้าของร้าน (best-effort — ไม่หน่วงการตอบกลับของลูกค้า)
  void notify.notifyShop(table.shop_id, 'order_new', notify.buildOrderNewText({
    shopName: table.shop_name,
    tableCode: table.code,
    billNo: fresh.bill_no,
    items: billItems.slice(-prepared.length),
    total: Number(fresh.total),
  }));

  // ให้หน้าครัว/แคชเชียร์/หน้าสั่งอาหารของร้านอัปเดตทันที (เรียลไทม์)
  realtime.publish(table.shop_id, 'order_new', { table_code: table.code, bill_no: fresh.bill_no });

  res.json({
    ok: true,
    message: 'ส่งออเดอร์แล้ว',
    bill: { order_id: order.id, bill_no: fresh.bill_no || null, total: Number(fresh.total), items: billItems },
  });
});

// ลูกค้ายกเลิกรายการ — ทำได้เฉพาะที่ครัวยังไม่เริ่มทำ (status = pending)
router.post('/api/public/order/:token/items/:itemId/cancel', async (req, res) => {
  const table = await db.findOrderableTableByToken(String(req.params.token || ''));
  if (!table) return res.status(404).json({ ok: false, message: 'ไม่พบโต๊ะนี้ หรือร้านปิดให้บริการชั่วคราว' });

  const open = await db.findOpenOrder(table.shop_id, table.id);
  if (!open) return res.status(400).json({ ok: false, message: 'ไม่มีบิลที่เปิดอยู่' });

  const item = await db.findOrderItemOwned(Number(req.params.itemId), table.shop_id);
  if (!item || item.order_id !== open.id) {
    return res.status(404).json({ ok: false, message: 'ไม่พบรายการในบิลนี้' });
  }
  if (item.status !== 'pending') {
    return res.status(400).json({ ok: false, message: item.status === 'cooking' ? 'ยกเลิกไม่ได้ ครัวเริ่มทำแล้ว' : 'ยกเลิกไม่ได้ อาหารเสร็จแล้ว' });
  }

  await db.cancelOrderItem(item.id, open.id, 'ลูกค้ายกเลิก');
  const fresh = await db.findOpenOrder(table.shop_id, table.id);
  const billItems = await db.listOrderItems(open.id);
  console.log(`❌ ยกเลิกรายการ โต๊ะ ${table.code} (${table.shop_name}): ${item.menu_name}`);

  void notify.notifyShop(table.shop_id, 'item_cancel', notify.buildItemCancelText({
    shopName: table.shop_name,
    tableCode: table.code,
    item,
    reason: 'ลูกค้ายกเลิกเอง',
  }));

  res.json({
    ok: true,
    message: 'ยกเลิกรายการแล้ว',
    bill: { order_id: open.id, bill_no: fresh.bill_no || null, total: Number(fresh.total), items: billItems },
  });
});

module.exports = router;

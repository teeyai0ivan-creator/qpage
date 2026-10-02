/**
 * public.js — API สาธารณะ (ไม่ต้องล็อกอิน) สำหรับหน้าร้านลูกค้า
 */
'use strict';

const express = require('express');
const crypto = require('node:crypto');
const qrCache = require('../lib/qr-cache');
const generatePromptPayPayload = require('promptpay-qr');
const db = require('../db');
const { buildOrderItems } = require('../lib/order-builder');
const notify = require('../lib/notify');
const realtime = require('../lib/realtime');
const legal = require('../lib/legal');
const site = require('../lib/site');
const hours = require('../lib/shop-hours');
const orderPay = require('../lib/order-pay');
const slipVerify = require('../lib/slip-verify');
const slipFiles = require('../lib/slip-files');
const time = require('../lib/time');

const { makeRouter } = require('../lib/router');
const router = makeRouter();

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
    // สถานะร้านตอนนี้ (เปิด/ปิด) — ถ้าปิด ลูกค้าสั่งไม่ได้ หน้าจอจะแจ้งเหตุผลให้
    hours: hours.openState(table),
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

  // ร้านปิดอยู่ (ปิดวันนี้/นอกเวลา/วันไม่เปิดทำการ) → ไม่รับออเดอร์ พร้อมบอกเหตุผลให้ลูกค้า
  const hoursNow = hours.openState(table);
  if (!hoursNow.open) {
    return res.status(409).json({ ok: false, closed: true, reason: hoursNow.reason, message: hoursNow.message + ' — กรุณาสั่งใหม่ในเวลาเปิดร้าน' });
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

// ---------------------------------------------------------------------------
// เดลิเวอร์รี่ / รับที่ร้าน (สแกน QR เดลิเวอร์รี่ของร้าน — ไม่มีโต๊ะ)
// ---------------------------------------------------------------------------
/** ข้อมูลร้าน + เมนู + สถานะร้าน + วิธีชำระที่ใช้ได้ สำหรับหน้าเลือกเมนูของลูกค้า */
router.get('/api/public/delivery/:token', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const shop = await db.findDeliveryShopByToken(String(req.params.token || ''));
  if (!shop) return res.status(404).json({ ok: false, message: 'ไม่พบร้านนี้ หรือร้านปิดให้บริการชั่วคราว' });
  const [categories, menus, optionGroups, optionItems, menuGroups] = await Promise.all([
    db.listCategories(shop.id),
    db.listMenus(shop.id),
    db.listOptionGroups(shop.id),
    db.listOptionItems(shop.id),
    db.listMenuOptionGroups(shop.id),
  ]);
  // กลุ่มตัวเลือกที่ร้านปิดไว้สำหรับเดลิเวอร์รี่ (เช่น "วิธีการทาน") → ไม่ส่งไปให้ลูกค้าเห็นเลย
  const offIds = new Set(optionGroups.filter((g) => Number(g.delivery_enabled) === 0).map((g) => Number(g.id)));
  const dlvGroups = optionGroups.filter((g) => !offIds.has(Number(g.id)));
  const dlvItems = optionItems.filter((i) => !offIds.has(Number(i.group_id)));
  const dlvMenuGroups = menuGroups.filter((mg) => !offIds.has(Number(mg.group_id)));
  res.json({
    ok: true,
    mode: 'delivery',
    shop: {
      name: shop.name, public_code: shop.public_code, logo_url: shop.logo_url,
      phone: shop.phone, line_url: shop.line_url, maps_url: shop.maps_url,
    },
    hours: hours.openState(shop),
    payment: {
      // โอนใช้ได้เฉพาะเมื่อร้านตั้งช่องทางรับเงิน + ต่อคีย์ EasySlip แล้ว (ยังไม่ต่อ = จ่ายเงินสดได้เท่านั้น)
      transfer: orderPay.canTransfer(shop),
      cash: true,
      note: shop.pay_note || '',
      expire_minutes: Number(shop.pay_expire_minutes) || 10,
    },
    categories, menus,
    optionGroups: dlvGroups, optionItems: dlvItems, menuGroups: dlvMenuGroups,
  });
});

/** สร้างบิลเดลิเวอร์รี่/รับที่ร้าน + เลือกวิธีชำระเงิน (เงินสด = เข้าครัวทันที · โอน = รอสลิป) */
router.post('/api/public/delivery/:token/order', async (req, res) => {
  const shop = await db.findDeliveryShopByToken(String(req.params.token || ''));
  if (!shop) return res.status(404).json({ ok: false, message: 'ไม่พบร้านนี้ หรือร้านปิดให้บริการชั่วคราว' });

  // ร้านปิดอยู่ → รับออเดอร์ไม่ได้ (บอกเหตุผลให้ลูกค้า)
  const state = hours.openState(shop);
  if (!state.open) return res.status(409).json({ ok: false, closed: true, reason: state.reason, message: state.message });

  const orderType = req.body?.orderType === 'delivery' ? 'delivery' : 'pickup';
  const customer = req.body?.customer || {};
  const name = String(customer.name || '').trim();
  const phone = String(customer.phone || '').trim();
  const address = String(customer.address || '').trim();
  if (name.length < 2) return res.status(400).json({ ok: false, field: 'name', message: 'กรุณากรอกชื่อผู้รับ' });
  if (phone.replace(/\D/g, '').length < 9) return res.status(400).json({ ok: false, field: 'phone', message: 'กรุณากรอกเบอร์โทรให้ครบ' });
  if (orderType === 'delivery' && address.length < 5) {
    return res.status(400).json({ ok: false, field: 'address', message: 'กรุณากรอกรายละเอียดสถานที่จัดส่ง' });
  }

  const method = req.body?.payment?.method === 'transfer' ? 'transfer' : 'cash';
  if (method === 'transfer' && !orderPay.canTransfer(shop)) {
    return res.status(400).json({ ok: false, field: 'payment', message: 'ร้านนี้ยังไม่เปิดรับชำระเงินโอน — กรุณาเลือกชำระเงินสด' });
  }

  let prepared;
  try {
    prepared = await buildOrderItems(shop.id, req.body?.items, { forDelivery: true });   // ข้ามกลุ่มตัวเลือกที่ปิดสำหรับเดลิเวอร์รี่
  } catch (err) {
    return res.status(err.status || 400).json({ ok: false, message: err.message });
  }

  const payRef = method === 'transfer' ? orderPay.newRef() : null;
  const minutes = Math.min(Math.max(Number(shop.pay_expire_minutes) || 10, 1), 60);
  const expiresAt = method === 'transfer' ? time.futureSql(minutes * 60000) : null;

  const created = await db.createRemoteOrder({
    shopId: shop.id,
    orderType,
    customer: {
      name, phone, address,
      note: String(customer.note || '').trim().slice(0, 500),
      lat: customer.lat, lng: customer.lng,
    },
    paymentMethod: method,
    payRef,
    payExpiresAt: expiresAt,
  });
  await db.addOrderItems(created.id, prepared);

  const label = orderType === 'delivery' ? 'เดลิเวอร์รี่' : 'รับที่ร้าน';
  console.log(`🛵 ออเดอร์${label} (${shop.name}) บิล #${created.billNo} · ${prepared.length} รายการ · ${method === 'transfer' ? 'โอนเงิน' : 'เงินสด'}`);

  // เงินสด = รับออเดอร์ทันที → แจ้งเตือนเจ้าของร้าน + เข้าครัว
  if (method === 'cash') {
    // แจ้งเตือนกลุ่มของร้าน (เหตุการณ์ "ออเดอร์เดลิเวอร์รี่/รับที่ร้าน") — วันเวลา/ชื่อ/เบอร์/แผนที่/รายการ/ยอดเงิน
    const items = await db.listOrderItems(created.id);
    const full = await db.findOrderById(created.id, shop.id);
    void notify.notifyShop(shop.id, 'order_delivery', notify.buildDeliveryOrderText({
      shopName: shop.name,
      order: Object.assign({}, full || created, {
        bill_no: created.billNo,
        total: items.reduce((s, i) => s + Number(i.line_total || 0), 0),
      }),
      items,
      paid: false,
    }));
    realtime.publish(shop.id, 'order_new', { order_type: orderType, bill_no: created.billNo });
  }

  // ข้อมูลสำหรับ "ใบเสร็จ" ที่หน้าจอลูกค้า (ใช้กับออเดอร์เงินสด — โอนจะไปแสดงที่หน้าจ่ายเงิน)
  const receiptItems = await db.listOrderItems(created.id);
  const receipt = {
    shop: { name: shop.name, phone: shop.phone || '', logo_url: shop.logo_url || '' },
    bill_no: created.billNo,
    date: new Date().toISOString(),
    order_type: orderType,
    customer_name: name,
    customer_phone: phone,
    address: orderType === 'delivery' ? address : '',
    items: receiptItems.filter((i) => i.status !== 'cancelled').map((i) => ({ menu_name: i.menu_name, quantity: Number(i.quantity) || 0, line_total: Number(i.line_total) || 0 })),
    total: receiptItems.filter((i) => i.status !== 'cancelled').reduce((s, i) => s + Number(i.line_total || 0), 0),
    payment_method: method,
    payment_status: 'unpaid',
    trans_ref: '',
  };
  res.json({
    ok: true,
    order_id: created.id,
    bill_no: created.billNo,
    order_type: orderType,
    payment_method: method,
    pay_ref: payRef,
    expires_at: expiresAt,
    minutes,
    receipt,
    message: method === 'cash' ? 'รับออเดอร์แล้ว — กำลังส่งเข้าครัว' : 'สร้างบิลแล้ว กรุณาโอนเงินภายใน ' + minutes + ' นาที',
  });
});

/** ข้อมูลการชำระเงินของบิล (ใช้ที่หน้าจ่ายเงิน) */
router.get('/api/public/pay/:ref', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  await db.expireStaleOrderPayments();
  const order = await db.findOrderByPayRef(String(req.params.ref || ''));
  if (!order) return res.status(404).json({ ok: false, message: 'ไม่พบรายการชำระเงินนี้' });
  const shop = await db.findShopById(order.shop_id);
  if (!shop) return res.status(404).json({ ok: false, message: 'ไม่พบร้านนี้' });
  const items = await db.listOrderItems(order.id);
  res.json(Object.assign({ ok: true }, orderPay.publicInfo(order, shop, items)));
});

/** อัปสลิปโอนเงิน → EasySlip ตรวจอัตโนมัติ → ได้เงินจริงจึงส่งออเดอร์เข้าครัวทันที */
router.post('/api/public/pay/:ref/slip', async (req, res) => {
  await db.expireStaleOrderPayments();
  const order = await db.findOrderByPayRef(String(req.params.ref || ''));
  if (!order) return res.status(404).json({ ok: false, message: 'ไม่พบรายการชำระเงินนี้' });
  if (order.status !== 'awaiting_payment') {
    const paid = order.payment_status === 'paid';
    return res.status(409).json({ ok: false, done: paid, message: paid ? 'บิลนี้ชำระเงินแล้ว' : 'รายการนี้ถูกยกเลิกแล้ว' });
  }
  const shop = await db.findShopById(order.shop_id);
  if (!shop) return res.status(404).json({ ok: false, message: 'ไม่พบร้านนี้' });

  const slipSettings = slipVerify.getSlipSettings(shop);
  if (!slipSettings.configured) {
    return res.status(400).json({ ok: false, message: 'ร้านนี้ยังไม่ได้ตั้งค่าตรวจสลิปอัตโนมัติ — กรุณาชำระเงินสดที่ร้าน' });
  }

  let parsed;
  try { parsed = slipFiles.parseSlip(req.body?.slip); }
  catch (err) { return res.status(400).json({ ok: false, field: 'slip', message: err.message }); }

  // กันสลิปใบเดียวใช้ซ้ำกับหลายบิล
  const hash = crypto.createHash('sha256').update(parsed.buf).digest('hex');
  const dup = await db.findOrderBySlipHash(shop.id, hash);
  if (dup && Number(dup.id) !== Number(order.id)) {
    return res.status(400).json({ ok: false, field: 'slip', message: 'สลิปนี้ถูกใช้กับบิลอื่นแล้ว' });
  }

  const verify = await slipVerify.verifySlip(parsed.buf, Number(order.total), slipSettings);
  // ⚠️ decideAutoApprove อ่านยอดจาก record.amount — บิลอาหารเก็บยอดใน total จึงต้องแปลงก่อนส่ง
  const decision = slipVerify.decideAutoApprove({ settings: slipSettings, record: { amount: Number(order.total) || 0 }, result: verify });
  const fileName = slipFiles.saveSlipBuffer(parsed.buf, parsed.ext, 'order-' + order.pay_ref);
  const slipUrl = '/api/shop/order-slips/' + fileName;
  await db.setOrderSlip(order.id, { slipUrl, slipStatus: decision.status, slipDetail: decision.detail, slipHash: hash });

  if (!decision.approve) {
    const customerMsg = verify && verify.customerMessage ? verify.customerMessage : '';
    const shopProblem = slipVerify.isShopConfigCode(verify && verify.code);
    console.warn(`⚠️ ตรวจสลิปไม่ผ่าน บิล #${order.bill_no} (${shop.name}) รหัส ${(verify && verify.code) || '-'}${verify && verify.providerCode ? ' / ผู้ให้บริการ ' + verify.providerCode : ''}`);
    if (shopProblem) {
      // ปัญหาอยู่ที่การตั้งค่า/บัญชีของร้าน (เช่น EasySlip หมดอายุ) — ลูกค้าแก้เองไม่ได้
      // ปิดบิลนี้แล้วให้ลูกค้าสั่งใหม่แบบชำระเงินสด จะได้ไม่ต้องรอจนหมดเวลา
      await db.expireOrderPayment(order.id);
      return res.status(400).json({
        ok: false, field: 'slip', status: decision.status, shop_config_error: true, retry_cash: true,
        provider_code: (verify && verify.providerCode) || null,
        message: customerMsg || 'ร้านยังไม่พร้อมรับชำระเงินโอนในขณะนี้ — ออเดอร์นี้ถูกยกเลิกแล้ว กรุณาสั่งใหม่และเลือก “ชำระเงินสด”',
      });
    }
    return res.status(400).json({
      ok: false, field: 'slip', status: decision.status,
      provider_code: (verify && verify.providerCode) || null,
      message: customerMsg || decision.detail || 'ตรวจสลิปไม่ผ่าน กรุณาตรวจสอบสลิปแล้วลองใหม่',
    });
  }

  // ผ่าน → ได้เงินจริง → ส่งออเดอร์เข้าครัวทันที + ติดป้าย "โอนแล้ว"
  await db.markOrderPaid(order.id, { transRef: verify.transRef, slipDetail: decision.detail });
  const items = await db.listOrderItems(order.id);
  // แจ้งกลุ่มของร้านว่า "ชำระเงินแล้ว" พร้อมรายละเอียดออเดอร์ครบ (เหตุการณ์ออเดอร์เดลิเวอร์รี่/รับที่ร้าน)
  const paidOrder = await db.findOrderById(order.id, shop.id);
  void notify.notifyShop(shop.id, 'order_delivery', notify.buildDeliveryOrderText({
    shopName: shop.name,
    order: Object.assign({}, paidOrder || order, { payment_status: 'paid', trans_ref: verify.transRef || null }),
    items,
    paid: true,
  }));
  realtime.publish(shop.id, 'order_new', { order_type: order.order_type, bill_no: order.bill_no, paid: true });
  console.log(`💰 รับชำระเงินโอนแล้ว บิล #${order.bill_no} (${shop.name}) ยอด ${order.total} → ส่งเข้าครัว`);

  res.json({ ok: true, paid: true, message: 'ชำระเงินสำเร็จ — กำลังส่งออเดอร์เข้าครัว', bill_no: order.bill_no });
});

/** รูป QR พร้อมเพย์ของบิลนี้ (ยอดเงินระบุไว้แล้ว) — ให้ลูกค้าสแกนจ่าย */
router.get('/api/public/pay/:ref/qr.png', async (req, res) => {
  await db.expireStaleOrderPayments();
  const order = await db.findOrderByPayRef(String(req.params.ref || ''));
  if (!order) return res.status(404).json({ ok: false, message: 'ไม่พบรายการชำระเงินนี้' });
  const shop = await db.findShopById(order.shop_id);
  const promptpayId = shop ? String(shop.pay_promptpay_id || '').trim() : '';
  if (!promptpayId) return res.status(404).json({ ok: false, message: 'ร้านนี้ยังไม่ได้ตั้งค่าพร้อมเพย์' });
  let payload;
  try { payload = generatePromptPayPayload(promptpayId, { amount: Math.round(Number(order.total) * 100) / 100 }); }
  catch (err) { return res.status(400).json({ ok: false, message: 'หมายเลขพร้อมเพย์ของร้านไม่ถูกต้อง' }); }
  await qrCache.sendQr(res, req, payload, { width: 420, margin: 1 });
});

/** ลูกค้าปิดหน้า/หมดเวลา → ยกเลิกบิลที่ยังไม่ชำระ */
router.post('/api/public/pay/:ref/expire', async (req, res) => {
  const order = await db.findOrderByPayRef(String(req.params.ref || ''));
  if (!order) return res.status(404).json({ ok: false, message: 'ไม่พบรายการชำระเงินนี้' });
  if (order.status === 'awaiting_payment') {
    await db.expireOrderPayment(order.id);
    console.log(`⌛ ยกเลิกบิลรอโอน #${order.bill_no} (หมดเวลา/ลูกค้าออก)`);
  }
  res.json({ ok: true, cancelled: true });
});

module.exports = router;

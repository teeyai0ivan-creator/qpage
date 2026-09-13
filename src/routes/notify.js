/**
 * notify.js — หน้าตั้งค่าการแจ้งเตือน + API กลุ่มแจ้งเตือน (Telegram)
 *
 * 1 ร้านมีได้หลาย "กลุ่มแจ้งเตือน" แต่ละกลุ่มตั้งปลายทาง (Bot token + Chat ID) และ
 * เลือกเหตุการณ์ที่รับเอง (เหตุการณ์ที่มีให้เลือกอยู่ใน src/lib/notify.js — EVENTS)
 */
'use strict';

const path = require('node:path');
const express = require('express');
const db = require('../db');
const notify = require('../lib/notify');
const { getCurrentUser, requireShop } = require('../middleware/auth');
const { isShop } = require('../lib/roles');

const router = express.Router();
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clip = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const MAX_GROUPS = 20; // กันตั้งกลุ่มเยอะจนยิงถล่ม

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

async function myShop(req, res) {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) {
    res.status(400).json({ ok: false, message: 'กรุณาตั้งข้อมูลร้านก่อน' });
    return null;
  }
  return shop;
}

/** แปลงค่าจากฟอร์มเป็น field ที่จะบันทึก */
function readGroupFields(body, res, { partial = false } = {}) {
  const fields = {};

  if (body?.name !== undefined || !partial) {
    const name = clip(body?.name, 120);
    if (!name) { res.status(400).json({ ok: false, field: 'name', message: 'กรุณาตั้งชื่อกลุ่มแจ้งเตือน (เช่น กลุ่มครัว, กลุ่มผู้จัดการ)' }); return null; }
    fields.name = name;
  }
  if (body?.active !== undefined) fields.active = body.active ? 1 : 0;

  if (body?.tgToken !== undefined) fields.tgToken = clip(body.tgToken, 255);
  if (body?.tgChat !== undefined) fields.tgChat = clip(body.tgChat, 120);
  if (body?.tgThread !== undefined) fields.tgThread = clip(body.tgThread, 40);

  if (body?.events !== undefined || !partial) {
    const events = notify.normalizeEvents(body?.events);
    if (!events.length) {
      res.status(400).json({ ok: false, field: 'events', message: 'เลือกอย่างน้อย 1 เหตุการณ์ที่ต้องการให้แจ้งเตือน' });
      return null;
    }
    fields.eventsJson = JSON.stringify(events);
  }
  return fields;
}

/** ดึงค่า config ของกลุ่มออกมาเป็น camelCase — รับได้ทั้งแถวจาก DB และค่าจากฟอร์ม */
function cfgOf(g) {
  return {
    tgToken: g.tgToken !== undefined ? g.tgToken : (g.tg_token || ''),
    tgChat: g.tgChat !== undefined ? g.tgChat : (g.tg_chat || ''),
  };
}

/** ต้องมี Bot token + Chat ID ก่อนจึงจะเปิดใช้งานได้ */
function configError(c) {
  if (!c.tgToken || !c.tgChat) return 'กรุณากรอก Bot token และ Chat ID ของ Telegram';
  return null;
}

// ---------------------------------------------------------------------------
// หน้าเว็บ
// ---------------------------------------------------------------------------
router.get('/shop/notify.html', requireShopPage, async (req, res) => {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) return res.redirect('/shop/setup.html');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'shop', 'notify.html'));
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
// รายการกลุ่ม + รายการเหตุการณ์ที่เลือกรับได้ (หน้าเว็บใช้สร้าง UI ทั้งหน้า)
router.get('/api/shop/notify-groups', requireShop, wrap(async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const groups = await db.listNotifyGroups(shop.id);
  res.json({
    ok: true,
    events: notify.EVENTS,
    groups: groups.map((g) => ({ ...g, events: notify.parseEvents(g.events_json) })),
  });
}));

router.post('/api/shop/notify-groups', requireShop, wrap(async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const existing = await db.listNotifyGroups(shop.id);
  if (existing.length >= MAX_GROUPS) {
    return res.status(400).json({ ok: false, message: `ตั้งได้ไม่เกิน ${MAX_GROUPS} กลุ่ม` });
  }
  const fields = readGroupFields(req.body, res);
  if (!fields) return;
  const active = fields.active === undefined ? 1 : fields.active;

  const cfgErr = active ? configError(cfgOf(fields)) : null;
  if (cfgErr) return res.status(400).json({ ok: false, message: cfgErr });

  const id = await db.createNotifyGroup({ shopId: shop.id, active, ...fields });
  console.log(`🔔 เพิ่มกลุ่มแจ้งเตือน "${fields.name}" (Telegram) — ${shop.name}`);
  res.json({ ok: true, message: `เพิ่มกลุ่มแจ้งเตือน "${fields.name}" แล้ว`, id });
}));

router.put('/api/shop/notify-groups/:id', requireShop, wrap(async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  const current = await db.findNotifyGroupById(id, shop.id);
  if (!current) return res.status(404).json({ ok: false, message: 'ไม่พบกลุ่มแจ้งเตือน' });

  const fields = readGroupFields(req.body, res, { partial: true });
  if (!fields) return;

  // ตรวจความครบถ้วนจากค่าที่จะกลายเป็นหลังบันทึก (ค่าที่ส่งมาใหม่ทับของเดิม)
  const merged = { ...current, ...fields };
  if (merged.active) {
    const cfgErr = configError(cfgOf(merged));
    if (cfgErr) return res.status(400).json({ ok: false, message: cfgErr });
  }

  await db.updateNotifyGroup(id, shop.id, fields);
  res.json({ ok: true, message: 'บันทึกกลุ่มแจ้งเตือนแล้ว' });
}));

router.delete('/api/shop/notify-groups/:id', requireShop, wrap(async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  const group = await db.findNotifyGroupById(id, shop.id);
  if (!group) return res.status(404).json({ ok: false, message: 'ไม่พบกลุ่มแจ้งเตือน' });
  await db.deleteNotifyGroup(id, shop.id);
  res.json({ ok: true, message: `ลบกลุ่ม "${group.name}" แล้ว` });
}));

// ทดสอบส่ง: ใช้ค่าที่กรอกในฟอร์มก่อนได้ (ยังไม่ต้องบันทึก) หรือค่าที่บันทึกไว้แล้ว
router.post('/api/shop/notify-test', requireShop, wrap(async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;

  const groupId = req.body?.id ? Number(req.body.id) : null;
  let source = null;
  if (groupId) {
    source = await db.findNotifyGroupById(groupId, shop.id);
    if (!source) return res.status(404).json({ ok: false, message: 'ไม่พบกลุ่มแจ้งเตือน' });
  }

  const cfg = {
    tgToken: req.body?.tgToken !== undefined ? clip(req.body.tgToken, 255) : (source?.tg_token || ''),
    tgChat: req.body?.tgChat !== undefined ? clip(req.body.tgChat, 120) : (source?.tg_chat || ''),
    tgThread: req.body?.tgThread !== undefined ? clip(req.body.tgThread, 40) : (source?.tg_thread || ''),
  };

  const cfgErr = configError(cfg);
  if (cfgErr) return res.status(400).json({ ok: false, message: cfgErr });

  const text = notify.buildTestText({
    shopName: shop.name,
    groupName: req.body?.name !== undefined ? clip(req.body.name, 120) : (source?.name || ''),
  });
  const result = await notify.sendMessage(cfg, text);
  if (source) {
    try { await db.setNotifyGroupResult(source.id, result.ok, result.ok ? 'ส่งสำเร็จ' : result.error); } catch { /* ข้าม */ }
  }
  if (!result.ok) return res.status(400).json({ ok: false, message: `ส่งทดสอบไม่สำเร็จ: ${result.error}` });
  console.log(`🔔 ทดสอบแจ้งเตือน Telegram สำเร็จ — ${shop.name}`);
  res.json({ ok: true, message: 'ส่งข้อความทดสอบไปทาง Telegram แล้ว — ตรวจสอบในแอปได้เลย' });
}));

module.exports = router;

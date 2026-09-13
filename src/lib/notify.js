/**
 * notify.js — แจ้งเตือนเจ้าของร้านผ่าน Telegram (Bot API)
 *
 * ปลายทาง/โทเคนเป็นของร้านเอง เก็บในตาราง notify_groups (1 ร้านมีได้หลายกลุ่ม)
 * แต่ละกลุ่มเลือกเองว่าจะรับเหตุการณ์อะไรบ้าง — ดูรายการที่ EVENTS ด้านล่าง
 *
 * การส่งเป็นแบบ "พยายามให้ดีที่สุด" (best-effort): ล้มเหลวแล้วต้องไม่ทำให้การสั่งอาหาร/เช็คบิลพัง
 * notifyShop() จึงกลืน error ทั้งหมดและคืนสรุปผลแทนการ throw
 *
 * หมายเหตุ: รองรับเฉพาะ Telegram — LINE ไม่มีช่องทางส่งเข้าบัญชี LINE ส่วนตัวโดยตรงแล้ว
 * (LINE Notify ปิดบริการ 31 มี.ค. 2025) และการส่งผ่าน LINE ต้องมี Official Account ซึ่งเลิกใช้ในระบบนี้
 */
'use strict';

const db = require('../db');

// ---------------------------------------------------------------------------
// เหตุการณ์ที่รองรับ — เพิ่มใหม่ได้ที่นี่ที่เดียว หน้าเว็บอ่านรายการนี้ผ่าน API
// ---------------------------------------------------------------------------
const EVENTS = [
  { key: 'order_new', label: 'มีออเดอร์ใหม่', desc: 'ลูกค้าสแกนสั่งอาหาร หรือแคชเชียร์เพิ่มอาหารเข้าบิล' },
  { key: 'item_done', label: 'อาหารทำเสร็จ', desc: 'ครัว/แคชเชียร์กดเคลียร์รายการว่าพร้อมเสิร์ฟ' },
  { key: 'item_cancel', label: 'ยกเลิกรายการ', desc: 'ครัว/แคชเชียร์ยกเลิกรายการ พร้อมเหตุผล' },
  { key: 'checkout', label: 'เช็คบิล (ปิดบิล)', desc: 'ปิดบิลของโต๊ะและเปิดบิลใหม่ให้โต๊ะเดิม' },
];
const EVENT_KEYS = EVENTS.map((e) => e.key);

// เปลี่ยน base URL ได้ผ่าน env (ใช้ตอนทดสอบกับ mock server — แนวเดียวกับ SLIP_API_BASE)
const TELEGRAM_BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
const TIMEOUT_MS = 8000;
const MAX_TG_CHARS = 4000;

/** กรองให้เหลือเฉพาะคีย์เหตุการณ์ที่รู้จัก และไม่ซ้ำ */
function normalizeEvents(raw) {
  const out = [];
  for (const item of (Array.isArray(raw) ? raw : [])) {
    const key = String(item || '').trim();
    if (EVENT_KEYS.includes(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

function parseEvents(json) {
  try { return normalizeEvents(JSON.parse(json || '[]')); } catch { return []; }
}

const eventsToJson = (raw) => JSON.stringify(normalizeEvents(raw));

/** กลุ่มนี้พร้อมส่งหรือยัง (ต้องมี Bot token + Chat ID) */
function isConfigured(g) {
  return Boolean(g && g.tg_token && g.tg_chat);
}

// ---------------------------------------------------------------------------
// ตัวช่วยยิง HTTP
// ---------------------------------------------------------------------------
async function postJson(url, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* Telegram อาจไม่ตอบ JSON เมื่อโดนบล็อค */ }
    if (!res.ok) {
      const detail = (data && (data.description || data.message)) || text.slice(0, 200) || `HTTP ${res.status}`;
      return { ok: false, error: String(detail).slice(0, 250) };
    }
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: err.name === 'AbortError' ? `หมดเวลาเชื่อมต่อ (${TIMEOUT_MS / 1000} วินาที)` : (err.message || 'เชื่อมต่อไม่สำเร็จ'),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// ส่งข้อความออก Telegram
// ---------------------------------------------------------------------------
async function sendTelegram({ token, chatId, threadId, text }) {
  if (!token || !chatId) return { ok: false, error: 'ยังไม่ได้กรอก Bot token หรือ Chat ID' };
  const payload = { chat_id: chatId, text: String(text).slice(0, MAX_TG_CHARS), disable_web_page_preview: true };
  const thread = String(threadId || '').trim();
  if (thread) payload.message_thread_id = Number(thread) || thread;

  const r = await postJson(`${TELEGRAM_BASE}/bot${token}/sendMessage`, payload);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.data && r.data.ok === false) {
    return { ok: false, error: String(r.data.description || 'Telegram ปฏิเสธข้อความ').slice(0, 250) };
  }
  return { ok: true };
}

/** ส่งข้อความตามการตั้งค่าของ "กลุ่ม" หนึ่ง ๆ (ใช้ทั้งตอนทดสอบและตอนยิงจริง) */
async function sendMessage(group, text) {
  return sendTelegram({
    token: group.tg_token || group.tgToken,
    chatId: group.tg_chat || group.tgChat,
    threadId: group.tg_thread || group.tgThread,
    text,
  });
}

// ---------------------------------------------------------------------------
// ข้อความแจ้งเตือน
// ---------------------------------------------------------------------------
const money = (n) => '฿' + Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const billFmt = (n) => (n ? '#' + String(n).padStart(4, '0') : '—');

function optionsOf(json) {
  try {
    const arr = JSON.parse(json || '[]');
    return Array.isArray(arr) && arr.length ? ` (${arr.join(', ')})` : '';
  } catch { return ''; }
}

/** สรุปเฉพาะรายการที่เพิ่งเข้ามา (จำกัด 20 บรรทัดแรก กันข้อความยาวเกิน) */
function itemLines(items = [], limit = 20) {
  const rows = items.slice(0, limit).map((it) => `• ${it.quantity} × ${it.menu_name}${optionsOf(it.options_json)} = ${money(it.line_total)}`);
  if (items.length > limit) rows.push(`… และอีก ${items.length - limit} รายการ`);
  return rows.join('\n');
}

/** รายการทั้งบิล (รวมรายการที่ถูกยกเลิก โดยกำกับไว้และไม่คิดเงิน) */
function billLines(items = [], limit = 30) {
  const rows = items.slice(0, limit).map((it) => {
    const opts = optionsOf(it.options_json);
    return it.status === 'cancelled'
      ? `• ${it.quantity} × ${it.menu_name}${opts} (ยกเลิก)`
      : `• ${it.quantity} × ${it.menu_name}${opts} = ${money(it.line_total)}`;
  });
  if (items.length > limit) rows.push(`… และอีก ${items.length - limit} รายการ`);
  return rows.join('\n');
}

/** เวลาไทย (UTC+7) แบบ วัน/เดือน/ปี ชั่วโมง:นาที — ไทยไม่มีเวลา Daylight saving จึงบวกคงที่ได้ */
function bangkokTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const t = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(t.getUTCDate())}/${p(t.getUTCMonth() + 1)}/${t.getUTCFullYear()} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

function buildOrderNewText({ shopName, tableCode, billNo, items, total, source }) {
  return [
    `🔔 ออเดอร์ใหม่ — ${shopName}`,
    `โต๊ะ ${tableCode} · บิล ${billFmt(billNo)}${source ? ` · ${source}` : ''}`,
    '',
    itemLines(items),
    '',
    `รวมทั้งบิล ${money(total)}`,
  ].join('\n');
}

function buildItemDoneText({ shopName, tableCode, item }) {
  return [
    `✅ อาหารเสร็จแล้ว — ${shopName}`,
    `โต๊ะ ${tableCode}`,
    '',
    `• ${item.quantity} × ${item.menu_name}${optionsOf(item.options_json)}`,
    '',
    'พร้อมเสิร์ฟให้ลูกค้าได้เลย',
  ].join('\n');
}

function buildItemCancelText({ shopName, tableCode, item, reason }) {
  return [
    `❌ ยกเลิกรายการ — ${shopName}`,
    `โต๊ะ ${tableCode}`,
    '',
    `• ${item.quantity} × ${item.menu_name}${optionsOf(item.options_json)}`,
    `เหตุผล: ${reason || 'ไม่ระบุ'}`,
  ].join('\n');
}

function buildCheckoutText({ shopName, tableCode, billNo, total, items = [], at }) {
  // นับ "รายการ" เป็นจำนวนจาน (ผลรวม quantity) ไม่ใช่จำนวนบรรทัดเมนู
  const sumQty = (list) => list.reduce((n, it) => n + (Number(it.quantity) || 0), 0);
  const cancelled = items.filter((i) => i.status === 'cancelled');
  const plates = sumQty(items.filter((i) => i.status !== 'cancelled'));
  return [
    `🧾 เช็คบิลแล้ว — ${shopName}`,
    `โต๊ะ ${tableCode} · บิล ${billFmt(billNo)}`,
    `🕒 ${bangkokTime(at)}`,
    '',
    items.length ? billLines(items) : '(ไม่มีรายการ)',
    '',
    `รวม ${plates} รายการ${cancelled.length ? ` (ยกเลิก ${sumQty(cancelled)})` : ''} · ยอดรวม ${money(total)}`,
  ].join('\n');
}

function buildTestText({ shopName, groupName }) {
  return [
    `✅ ทดสอบการแจ้งเตือนสำเร็จ — ${shopName}`,
    '',
    `กลุ่ม: ${groupName || '(ไม่มีชื่อ)'}`,
    '',
    'ถ้าเห็นข้อความนี้ แปลว่าตั้งค่าถูกต้องแล้ว 🎉',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// ยิงแจ้งเตือนจริง
// ---------------------------------------------------------------------------
/**
 * ส่งข้อความไปยังทุกกลุ่มที่เปิดใช้ ตั้งค่าแล้ว และสมัครรับเหตุการณ์นั้น
 * ไม่ throw — คืน { ok, sent, total } เพื่อให้ผู้เรียกตัดสินใจได้
 */
async function notifyShop(shopId, event, text) {
  try {
    const groups = await db.listActiveNotifyGroups(shopId);
    // กลุ่มที่ยังไม่ได้กรอกโทเคน/Chat ID ถือว่ายังตั้งค่าไม่เสร็จ — ข้ามไปเงียบ ๆ ไม่นับเป็นความล้มเหลว
    const targets = groups.filter((g) => isConfigured(g) && parseEvents(g.events_json).includes(event));
    if (!targets.length) return { ok: true, sent: 0, total: 0 };

    const results = await Promise.all(targets.map(async (g) => {
      const r = await sendMessage(g, text);
      try { await db.setNotifyGroupResult(g.id, r.ok, r.ok ? 'ส่งสำเร็จ' : r.error); } catch { /* บันทึกผลไม่ได้ก็ไม่เป็นไร */ }
      if (r.ok) console.log(`🔔 แจ้งเตือน "${event}" → ${g.name} (Telegram)`);
      else console.warn(`⚠️ แจ้งเตือน "${event}" → ${g.name} ล้มเหลว: ${r.error}`);
      return r.ok;
    }));

    const sent = results.filter(Boolean).length;
    return { ok: sent === targets.length, sent, total: targets.length };
  } catch (err) {
    console.error('⚠️ ส่งแจ้งเตือนไม่สำเร็จ:', err.message);
    return { ok: false, sent: 0, total: 0 };
  }
}

module.exports = {
  EVENTS,
  EVENT_KEYS,
  normalizeEvents,
  parseEvents,
  eventsToJson,
  isConfigured,
  sendTelegram,
  sendMessage,
  notifyShop,
  bangkokTime,
  buildTestText,
  buildOrderNewText,
  buildItemDoneText,
  buildItemCancelText,
  buildCheckoutText,
};

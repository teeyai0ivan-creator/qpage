/**
 * api.js — ตัวเรียก API ของเซิร์ฟเวอร์ จากฝั่ง "โปรแกรม" (main process)
 *
 * ทำไมต้องเรียกจาก main: หน้าจอของโปรแกรมเป็นไฟล์ในเครื่อง (file://) จึงเรียก API ข้ามโดเมนพร้อมคุกกี้ไม่ได้
 * main process ถือ session ของร้านอยู่แล้ว จึงเป็นคนเรียกให้ แล้วส่งข้อมูลให้หน้าจอผ่าน IPC
 */
'use strict';

const { session } = require('electron');
const settings = require('./settings');

const PARTITION = 'persist:qpage';

function sess() {
  return session.fromPartition(PARTITION);
}

function base() {
  return String(settings.get().serverUrl || '').replace(/\/+$/, '');
}

function headers(extra) {
  return Object.assign({ 'X-QPage-Device': settings.get().deviceId }, extra || {});
}

/** เรียก API แล้วคืน JSON (โยน error พร้อมข้อความไทยถ้าไม่สำเร็จ) */
async function call(path, opts = {}) {
  const res = await sess().fetch(base() + path, {
    method: opts.method || 'GET',
    headers: headers(opts.body ? { 'Content-Type': 'application/json' } : null),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok || !data || data.ok === false) {
    const err = new Error((data && data.message) || ('เซิร์ฟเวอร์ตอบกลับผิดพลาด (HTTP ' + res.status + ')'));
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------
// งานของหน้าจอครัว / แคชเชียร์
// ---------------------------------------------------------------------------
/** รายการอาหารของจุดหนึ่ง ๆ (kitchen | cashier) */
async function kitchenItems(station) {
  const st = station === 'cashier' ? 'cashier' : 'kitchen';
  const data = await call('/api/shop/kitchen?station=' + st);
  return { station: data.station || st, items: data.items || [] };
}

/** เริ่มทำหลายรายการ (คืน { started, rounds }) — rounds ใช้เปิดพิมพ์ใบสั่งครัว */
async function startItems(ids) {
  const data = await call('/api/shop/order-items/start', { method: 'POST', body: { ids } });
  return { started: data.started || [], rounds: data.rounds || [] };
}

/** เปลี่ยนสถานะรายการ (cooking | done) */
async function setItemStatus(id, status) {
  return call('/api/shop/order-items/' + Number(id) + '/status', { method: 'POST', body: { status } });
}

/** ยกเลิกรายการ (ต้องระบุสาเหตุ) */
async function cancelItem(id, reason) {
  return call('/api/shop/order-items/' + Number(id) + '/status', { method: 'POST', body: { status: 'cancelled', reason } });
}

/** ข้อมูลร้าน + เมนู/หมวด (ใช้แสดงหัวหน้าจอ) */
async function shopInfo() {
  const data = await call('/api/shop/me');
  return { shop: data.shop || null };
}

// ---------------------------------------------------------------------------
// งานของหน้าจอ "สั่งอาหาร" (ผังโต๊ะ + บิล)
// ---------------------------------------------------------------------------
/** โต๊ะทั้งหมด (พร้อมบิลที่เปิดอยู่ + ชื่อโซน) + ค่าตั้งปิด QR อัตโนมัติ */
async function tables() {
  return call('/api/shop/tables');
}

/**
 * รายชื่อโต๊ะ + โซน (แหล่งหลักของ "ผังโต๊ะ")
 * ⚠️ /api/shop/tables ให้เฉพาะโต๊ะที่ "ออก QR แล้ว" — โต๊ะที่ตั้งชื่อ/จัดโซนไว้แต่ยังไม่ออก QR
 *    อยู่ในรายการนี้เท่านั้น ผังจึงต้องสร้างจากรายการนี้แล้วค่อยผูกกับข้อมูล QR/บิล
 */
async function tableNames() {
  const data = await call('/api/shop/table-names');
  return { names: data.names || [], zones: data.zones || [] };
}

/** ออก QR ให้ชื่อโต๊ะที่ยังไม่มี (สร้างโต๊ะ+โทเคนจากชื่อนั้น) */
async function createQrForName(code, zoneId) {
  return call('/api/shop/tables', { method: 'POST', body: { code, zoneId: Number(zoneId) || 0 } });
}

/** โซนทั้งหมด */
async function zones() {
  const data = await call('/api/shop/zones');
  return data.zones || [];
}

/** บิลที่เปิดอยู่ทั้งหมด (มีรายการอาหารในบิล) */
async function openBills() {
  const data = await call('/api/shop/orders/open');
  return data.orders || [];
}

/** เมนู + กลุ่มตัวเลือก (สำหรับหน้าต่างเลือกอาหาร) */
async function catalog() {
  const data = await call('/api/shop/me');
  return {
    menus: data.menus || [],
    categories: data.categories || [],
    optionGroups: data.optionGroups || [],
    optionItems: data.optionItems || [],
    menuGroups: data.menuGroups || [],
  };
}

/** เพิ่มอาหารเข้าบิลของโต๊ะ */
async function addItems(tableId, items) {
  return call('/api/shop/tables/' + Number(tableId) + '/items', { method: 'POST', body: { items } });
}

/** ลบรายการอาหารออกจากบิล */
async function deleteItem(itemId) {
  return call('/api/shop/order-items/' + Number(itemId), { method: 'DELETE' });
}

/** เช็คบิลโต๊ะ (คืน { closed, qr_deleted }) */
async function checkout(tableId) {
  const data = await call('/api/shop/tables/' + Number(tableId) + '/checkout', { method: 'POST', body: {} });
  return { closed: data.closed || null, qrDeleted: !!data.qr_deleted, message: data.message || '' };
}

/** เพิ่มโต๊ะใหม่ (ชื่อ + โซนถ้าเลือก) */
async function addTable(code, zoneId) {
  return call('/api/shop/tables', { method: 'POST', body: { code, zoneId: Number(zoneId) || 0 } });
}

/** เพิ่มโซนใหม่ */
async function addZone(name) {
  return call('/api/shop/zones', { method: 'POST', body: { name } });
}

// ---------------------------------------------------------------------------
// เหตุการณ์เรียลไทม์ (SSE) — ให้หน้าจอครัวอัปเดตเองเมื่อมีออเดอร์ใหม่
// ---------------------------------------------------------------------------
/**
 * เปิดสายเหตุการณ์ค้างไว้ แล้วเรียก onEvent ทุกครั้งที่มีอีเวนต์
 * @returns {{abort:Function}} ใช้ยกเลิกได้
 */
function openEvents(onEvent, onState) {
  const ctrl = new AbortController();
  let closed = false;
  (async () => {
    for (;;) {
      if (closed) return;
      try {
        if (onState) onState('connecting');
        const res = await sess().fetch(base() + '/api/shop/events', {
          headers: headers({ Accept: 'text/event-stream' }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
        if (onState) onState('open');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done || closed) break;
          buf += decoder.decode(value, { stream: true });
          const blocks = buf.split('\n\n');
          buf = blocks.pop() || '';
          for (const block of blocks) {
            const line = block.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            let evt = null;
            try { evt = JSON.parse(line.slice(6)); } catch (e) { evt = null; }
            if (evt && evt.type !== 'hello' && onEvent) onEvent(evt);
          }
        }
      } catch (err) {
        if (closed) return;
      }
      if (onState) onState('error');
      await new Promise((r) => setTimeout(r, 4000));   // ลองใหม่เองอัตโนมัติ
    }
  })();
  return { abort: () => { closed = true; try { ctrl.abort(); } catch (e) { /* ข้าม */ } } };
}

module.exports = {
  call, openEvents, shopInfo,
  kitchenItems, startItems, setItemStatus, cancelItem,
  tables, tableNames, createQrForName, zones, openBills, catalog, addItems, deleteItem, checkout, addTable, addZone,
};

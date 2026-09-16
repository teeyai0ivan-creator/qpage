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

module.exports = { call, kitchenItems, startItems, setItemStatus, cancelItem, shopInfo, openEvents };

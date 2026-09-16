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

/** ประวัติบิลที่ปิดแล้ว (ใหม่สุดก่อน) — ใช้ที่หน้าจอประวัติ */
async function history(opts) {
  const q = new URLSearchParams();
  if (opts && opts.tableId) q.set('tableId', String(opts.tableId));
  if (opts && opts.limit) q.set('limit', String(opts.limit));
  const data = await call('/api/shop/orders/history' + (q.toString() ? '?' + q.toString() : ''));
  return data.orders || [];
}

/** ประวัติการพิมพ์ใบสั่งครัว แยกรอบ (มีสำเนารายการที่พิมพ์ไปจริงในแต่ละรอบ) */
async function kitchenPrints(limit) {
  const data = await call('/api/shop/kitchen-prints?limit=' + (Number(limit) || 100));
  return data.prints || [];
}

/** โต๊ะที่ปิดใช้งานแล้ว (QR ที่เลิกใช้) — เก็บไว้เป็นหลักฐาน */
async function retiredTables() {
  const data = await call('/api/shop/tables/retired');
  return data.tables || [];
}

/**
 * รูป QR ของโต๊ะ (คืนเป็น data URL)
 * หน้าจอเป็นไฟล์ในเครื่อง (file://) จึงโหลดรูปจากเซิร์ฟเวอร์ตรง ๆ ไม่ได้ (ไม่มีคุกกี้) → ให้ main โหลดมาให้
 */
async function qrImage(tableId) {
  const url = base() + '/api/shop/tables/' + Number(tableId) + '/qr?origin=' + encodeURIComponent(base());
  const res = await sess().fetch(url, { headers: headers() });
  if (!res.ok) throw new Error('โหลดรูป QR ไม่สำเร็จ (HTTP ' + res.status + ')');
  const buf = Buffer.from(await res.arrayBuffer());
  return { dataUrl: 'data:image/png;base64,' + buf.toString('base64'), bytes: buf.length };
}

// ---------------------------------------------------------------------------
// งานของหน้าจอจัดการร้าน: ข้อมูลร้าน · หมวดหมู่ · เมนู · กลุ่มตัวเลือก · แจ้งเตือน · ตั้งค่าระบบ
// ---------------------------------------------------------------------------
/** ข้อมูลร้าน + หมวดหมู่ + เมนู + กลุ่มตัวเลือกทั้งหมด (ใช้ร่วมกันหลายหน้าจอ) */
async function shopAll() {
  const data = await call('/api/shop/me');
  return {
    shop: data.shop || null,
    publicUrl: data.publicUrl ? base() + data.publicUrl : '',
    categories: data.categories || [],
    menus: data.menus || [],
    optionGroups: data.optionGroups || [],
    optionItems: data.optionItems || [],
    menuGroups: data.menuGroups || [],
  };
}

/**
 * รูปที่เก็บไว้บนเซิร์ฟเวอร์ (เช่น /uploads/shops/x.png) → data URL
 * หน้าจอเป็นไฟล์ในเครื่อง (file://) จึงโหลดรูปจากเซิร์ฟเวอร์ตรง ๆ ไม่ได้ (ไม่มีคุกกี้)
 */
async function imageDataUrl(urlPath) {
  const p = String(urlPath || '');
  if (!p) return '';
  if (/^data:/.test(p)) return p;
  if (!/^\/[A-Za-z0-9_\-./]+$/.test(p)) return '';
  const res = await sess().fetch(base() + p, { headers: headers() });
  if (!res.ok) throw new Error('โหลดรูปไม่สำเร็จ (HTTP ' + res.status + ')');
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') || 'image/png';
  return 'data:' + type + ';base64,' + buf.toString('base64');
}

/** บันทึกข้อมูลร้าน (ส่งเฉพาะฟิลด์ที่แก้) */
async function saveShop(fields) {
  const data = await call('/api/shop', { method: 'PUT', body: fields });
  return { shop: data.shop || null, message: data.message || '' };
}

/** อัปโหลดรูป (รับ data URL) → คืนพาธรูปที่เก็บบนเซิร์ฟเวอร์ */
async function uploadImage(dataUrl) {
  const data = await call('/api/shop/upload', { method: 'POST', body: { dataUrl } });
  return data.url || '';
}

/** เพิ่ม/แก้/ลบ หมวดหมู่ (station = 'kitchen' | 'cashier') */
async function addCategory(fields) {
  return call('/api/shop/categories', { method: 'POST', body: fields });
}
async function updateCategory(id, fields) {
  return call('/api/shop/categories/' + Number(id), { method: 'PUT', body: fields });
}
async function deleteCategory(id) {
  return call('/api/shop/categories/' + Number(id), { method: 'DELETE' });
}

/** เพิ่ม/แก้/ลบ เมนู */
async function addMenu(fields) {
  return call('/api/shop/menus', { method: 'POST', body: fields });
}
async function updateMenu(id, fields) {
  return call('/api/shop/menus/' + Number(id), { method: 'PUT', body: fields });
}
async function deleteMenu(id) {
  return call('/api/shop/menus/' + Number(id), { method: 'DELETE' });
}
/** ผูกกลุ่มตัวเลือกกับเมนู (ส่งรายการ groupIds ทั้งชุด) */
async function setMenuGroups(id, groupIds) {
  return call('/api/shop/menus/' + Number(id) + '/groups', { method: 'PUT', body: { groupIds } });
}

/** กลุ่มตัวเลือก + ตัวเลือกในกลุ่ม */
async function addOptionGroup(fields) {
  return call('/api/shop/option-groups', { method: 'POST', body: fields });
}
async function updateOptionGroup(id, fields) {
  return call('/api/shop/option-groups/' + Number(id), { method: 'PUT', body: fields });
}
async function deleteOptionGroup(id) {
  return call('/api/shop/option-groups/' + Number(id), { method: 'DELETE' });
}
async function addOptionItem(groupId, fields) {
  return call('/api/shop/option-groups/' + Number(groupId) + '/items', { method: 'POST', body: fields });
}
async function updateOptionItem(id, fields) {
  return call('/api/shop/option-items/' + Number(id), { method: 'PUT', body: fields });
}
async function deleteOptionItem(id) {
  return call('/api/shop/option-items/' + Number(id), { method: 'DELETE' });
}

/** กลุ่มแจ้งเตือน (Telegram) + รายการเหตุการณ์ที่เลือกได้ */
async function notifyGroups() {
  const data = await call('/api/shop/notify-groups');
  return { events: data.events || [], groups: data.groups || [] };
}
async function addNotifyGroup(fields) {
  return call('/api/shop/notify-groups', { method: 'POST', body: fields });
}
async function updateNotifyGroup(id, fields) {
  return call('/api/shop/notify-groups/' + Number(id), { method: 'PUT', body: fields });
}
async function deleteNotifyGroup(id) {
  return call('/api/shop/notify-groups/' + Number(id), { method: 'DELETE' });
}

/** เปิด/ปิด "ปิดใช้งาน QR ของโต๊ะทันทีเมื่อเช็คบิล" */
async function setQrAutoDelete(enabled) {
  const data = await call('/api/shop/qr-auto-delete', { method: 'PUT', body: { enabled: !!enabled } });
  return { enabled: !!data.enabled, message: data.message || '' };
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
  history, kitchenPrints, retiredTables, qrImage,
  shopAll, saveShop, uploadImage, imageDataUrl,
  addCategory, updateCategory, deleteCategory,
  addMenu, updateMenu, deleteMenu, setMenuGroups,
  addOptionGroup, updateOptionGroup, deleteOptionGroup, addOptionItem, updateOptionItem, deleteOptionItem,
  notifyGroups, addNotifyGroup, updateNotifyGroup, deleteNotifyGroup, setQrAutoDelete,
};

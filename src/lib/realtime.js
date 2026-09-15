/**
 * realtime.js — อัปเดตข้อมูลแบบเรียลไทม์ด้วย Server-Sent Events (SSE)
 *
 * หลักการ: เบราว์เซอร์เปิดคอนเนกชันค้างไว้ที่ /api/shop/events แล้วเซิร์ฟเวอร์ "ผลัก" เหตุการณ์
 * ไปให้ทันทีที่ข้อมูลของร้านนั้นเปลี่ยน (ลูกค้าสั่งอาหาร / ครัวเปลี่ยนสถานะ / เช็คบิล / แก้โต๊ะ)
 * - แยกกลุ่มตามร้าน (shopId) เห็นเฉพาะเหตุการณ์ของร้านตัวเอง
 * - ใช้ EventSource ฝั่งเบราว์เซอร์ จึงต่อใหม่ให้อัตโนมัติเมื่อหลุด
 * - ตั้ง X-Accel-Buffering: no เพื่อไม่ให้ Nginx บัฟเฟอร์คำตอบ (SSE ส่งถึงทันทีโดยไม่ต้องแก้ config)
 */
'use strict';

const MAX_PER_SHOP = 40; // กันเปิดค้างเยอะผิดปกติ
const HEARTBEAT_MS = 25000; // ส่ง comment เป็นระยะ กัน proxy ตัดการเชื่อมต่อที่เงียบ

const clients = new Map(); // shopId -> Set<res>

function subscribe(shopId, res) {
  const id = Number(shopId);
  if (!Number.isInteger(id) || id <= 0) return null;
  let set = clients.get(id);
  if (!set) { set = new Set(); clients.set(id, set); }
  if (set.size >= MAX_PER_SHOP) return null;
  set.add(res);
  return () => {
    const s = clients.get(id);
    if (!s) return;
    s.delete(res);
    if (!s.size) clients.delete(id);
  };
}

/** แจ้งเตือนทุกหน้าที่เปิดอยู่ของร้านนั้น — type: order_new | item_status | bill_changed | tables_changed */
function publish(shopId, type, data) {
  const set = clients.get(Number(shopId));
  if (!set || !set.size) return 0;
  const payload = 'data: ' + JSON.stringify(Object.assign({ type, at: Date.now() }, data || {})) + '\n\n';
  let sent = 0;
  for (const res of Array.from(set)) {
    try { res.write(payload); sent++; } catch (e) { set.delete(res); }
  }
  return sent;
}

/** ต่อ SSE ให้คำขอหนึ่งรายการ — คืนฟังก์ชันปิด (หรือ null ถ้าเปิดค้างเกินกำหนด) */
function sseHandler(shopId, req, res) {
  const off = subscribe(shopId, res);
  if (!off) { res.status(503).end(); return null; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write('data: ' + JSON.stringify({ type: 'hello', at: Date.now() }) + '\n\n');
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* ข้าม */ } }, HEARTBEAT_MS);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    off();
    try { res.end(); } catch (e) { /* ข้าม */ }
  };
  req.on('close', stop);
  req.on('error', stop);
  res.on('error', stop);
  return stop;
}

function countClients() { let n = 0; for (const set of clients.values()) n += set.size; return n; }

module.exports = { publish, sseHandler, subscribe, countClients };

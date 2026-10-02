/**
 * sys.js — หน้าจอ "ตั้งค่าระบบ" ของ "โปรแกรม" (ไม่ใช่หน้าเว็บ)
 * ตอนนี้มีตัวเลือกเดียวตามหน้าเว็บ: ปิดใช้งาน QR ของโต๊ะทันทีเมื่อเช็คบิล (ต้องยืนยันก่อนทุกครั้ง)
 */
'use strict';

const API = window.qpageShop;
const NAV = window.qpageNav;
const $ = (id) => document.getElementById(id);
let enabled = false;
let printOnStart = true;
let deliveryOnStations = true;
let busy = false;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 3200);
}

function paint() {
  $('swQrAutoDelete').checked = enabled;
  const b = $('stateBadge');
  b.textContent = enabled ? 'เปิดอยู่' : 'ปิดอยู่';
  b.className = 'badge ' + (enabled ? 'ok' : 'wait');
  $('hint').textContent = enabled
    ? 'เปิดอยู่ — เช็คบิลแล้ว QR ของโต๊ะนั้นจะถูกปิดใช้งานทันที (ต้องออก QR ใหม่ก่อนให้ลูกค้าสั่งครั้งถัดไป) โดยโต๊ะและ QR เดิมยังดูย้อนหลังได้ในหน้าจอ “ประวัติ”'
    : 'ปิดอยู่ — เช็คบิลแล้วโต๊ะและ QR ยังใช้งานต่อ และระบบเปิดบิลใหม่ให้อัตโนมัติ';
}

/** กล่องยืนยันของโปรแกรม (หน้าตาชุดเดียวกับหน้าจออื่น — ไม่ใช้กล่อง confirm ของเบราว์เซอร์) */
function ask(title, message, okText) {
  return new Promise((resolve) => {
    $('askTitle').textContent = title;
    $('askMsg').textContent = message;
    $('askOk').textContent = okText;
    $('askOverlay').classList.add('show');
    const done = (v) => { $('askOverlay').classList.remove('show'); $('askOk').onclick = null; $('askCancel').onclick = null; resolve(v); };
    $('askOk').onclick = () => done(true);
    $('askCancel').onclick = () => done(false);
  });
}

async function load() {
  try {
    const data = await API.all();
    $('stShop').textContent = 'ร้าน ' + ((data.shop && data.shop.name) || '—');
    enabled = data.shop ? Number(data.shop.delete_qr_on_checkout) === 1 : false;
    printOnStart = data.shop ? Number(data.shop.print_on_start) !== 0 : true;   // ค่าเริ่มต้น = เปิด
    deliveryOnStations = data.shop ? Number(data.shop.delivery_on_stations) !== 0 : true;   // ค่าเริ่มต้น = เปิด
    paintShopState(data.hours);
    $('err').textContent = '';
    paint();
    $('printErr').textContent = '';
    paintPrint();
    $('dlvErr').textContent = '';
    paintDlv();
  } catch (err) {
    $('err').textContent = 'โหลดค่าตั้งไม่สำเร็จ: ' + err.message;
  }
}

// สวิตช์ "พิมพ์ใบสั่งครัวเมื่อกดเริ่มทำ"
function paintPrint() {
  $('swPrintOnStart').checked = printOnStart;
  const b = $('printBadge');
  b.textContent = printOnStart ? 'เปิดอยู่' : 'ปิดอยู่';
  b.className = 'badge ' + (printOnStart ? 'ok' : 'wait');
  $('printHint').textContent = printOnStart
    ? 'เปิดอยู่ — กด “เริ่มทำ” ที่ครัว/แคชเชียร์ แล้วระบบพิมพ์ใบสั่งครัวให้ทันที'
    : 'ปิดอยู่ — กด “เริ่มทำ” จะไม่พิมพ์ออกมา (เริ่มทำอย่างเดียว ไม่มีกระดาษรบกวน)';
}

// สวิตช์ "แสดงเมนูที่ลูกค้าเดลิเวอร์รี่สั่งในครัว/แคชเชียร์"
function paintDlv() {
  $('swDeliveryOnStations').checked = deliveryOnStations;
  const b = $('dlvBadge');
  b.textContent = deliveryOnStations ? 'เปิดอยู่' : 'ปิดอยู่';
  b.className = 'badge ' + (deliveryOnStations ? 'ok' : 'wait');
  $('dlvHint').textContent = deliveryOnStations
    ? 'เปิดอยู่ — ออเดอร์เดลิเวอร์รี่ขึ้นในครัว/แคชเชียร์ให้กดเริ่มทำตามปกติ'
    : 'ปิดอยู่ — ออเดอร์เดลิเวอร์รี่ไม่แสดงในครัว/แคชเชียร์ (ดูและกด "นำส่ง" ที่หน้าสั่งอาหารเท่านั้น)';
}

$('swDeliveryOnStations').addEventListener('change', async (e) => {
  if (busy) return;
  const el = e.currentTarget;
  const on = el.checked;
  const okToggle = await ask(
    (on ? 'เปิด' : 'ปิด') + ' “แสดงเมนูที่ลูกค้าเดลิเวอร์รี่สั่งในครัว/แคชเชียร์” ?',
    on
      ? 'ออเดอร์เดลิเวอร์รี่จะกลับมาแสดงในครัวและแคชเชียร์ให้กดเริ่มทำ และต้องเคลียร์รายการครบก่อนจึงกด "นำส่ง" ได้'
      : 'ออเดอร์เดลิเวอร์รี่จะไม่แสดงในครัวและแคชเชียร์เลย — เห็นและกด "นำส่ง" ได้ที่หน้าสั่งอาหารเท่านั้น (กดได้ทันที ไม่ต้องเคลียร์รายการ)',
    on ? 'เปิดใช้งาน' : 'ปิดใช้งาน'
  );
  if (!okToggle) { el.checked = !on; return; }
  busy = true;
  el.disabled = true;
  try {
    const r = await API.setDeliveryOnStations(on);
    deliveryOnStations = r.enabled;
    paintDlv();
    toast(r.message || 'บันทึกแล้ว');
  } catch (err) {
    el.checked = !on;
    $('dlvErr').textContent = err.message;
  } finally {
    busy = false;
    el.disabled = false;
  }
});

$('swPrintOnStart').addEventListener('change', async (e) => {
  if (busy) return;
  const el = e.currentTarget;
  const on = el.checked;
  const okToggle = await ask(
    (on ? 'เปิด' : 'ปิด') + ' “พิมพ์ใบสั่งครัวเมื่อกดเริ่มทำ” ?',
    on
      ? 'เมื่อกด “เริ่มทำ” ที่หน้าจอครัว/แคชเชียร์ ระบบจะพิมพ์ใบสั่งครัวออกเครื่องพิมพ์ทันที'
      : 'เมื่อกด “เริ่มทำ” ระบบจะไม่พิมพ์ใบสั่งครัว (ไม่มีกระดาษออกมารบกวน) — ยังกดพิมพ์ซ้ำเองได้จากหน้าจอ “ประวัติสั่งครัว”',
    on ? 'เปิดใช้งาน' : 'ปิดใช้งาน'
  );
  if (!okToggle) { el.checked = !on; return; }
  busy = true;
  el.disabled = true;
  try {
    const r = await API.setPrintOnStart(on);
    printOnStart = r.enabled;
    paintPrint();
    toast(r.message || 'บันทึกแล้ว');
  } catch (err) {
    el.checked = !on;
    $('printErr').textContent = err.message;
  } finally {
    busy = false;
    el.disabled = false;
  }
});

$('swQrAutoDelete').addEventListener('change', async (e) => {
  if (busy) return;
  const el = e.currentTarget;
  const on = el.checked;
  const okToggle = await ask(
    (on ? 'เปิด' : 'ปิด') + ' “ปิดใช้งาน QR ของโต๊ะทันทีเมื่อเช็คบิล” ?',
    on
      ? 'เมื่อกดเช็คบิล QR ของโต๊ะนั้นจะถูกปิดใช้งานทันที (สแกนไม่ได้อีก) และต้องออก QR ใหม่ก่อนให้ลูกค้าสั่งครั้งถัดไป — ตัว QR และประวัติยังดูย้อนหลังได้ในหน้าจอ "ประวัติ"'
      : 'เมื่อกดเช็คบิล โต๊ะและ QR จะยังใช้งานต่อ และระบบจะเปิดบิลใหม่ให้อัตโนมัติ',
    on ? 'เปิดใช้งาน' : 'ปิดใช้งาน'
  );
  if (!okToggle) { el.checked = !on; return; }
  busy = true;
  el.disabled = true;
  try {
    const r = await API.setQrAutoDelete(on);
    enabled = r.enabled;
    paint();
    toast(r.message || 'บันทึกแล้ว');
  } catch (err) {
    el.checked = !on;
    $('err').textContent = err.message;
  } finally {
    busy = false;
    el.disabled = false;
  }
});

let closedToday = false;
function paintShopState(hours) {
  if (!hours) return;
  closedToday = hours.reason === 'closed_today';
  const b = $('shopStateBadge');
  b.textContent = hours.open ? 'เปิดอยู่' : 'ปิดอยู่';
  b.className = 'badge ' + (hours.open ? 'ok' : 'wait');
  $('shopStateHint').textContent = hours.open
    ? ('ลูกค้าสั่งอาหารได้ตามปกติ' + (hours.open_time ? ' (เปิด ' + hours.open_time + '–' + hours.close_time + ' · ' + hours.open_days_text + ')' : ''))
    : ((hours.message || 'ร้านปิดอยู่') + ' — ลูกค้าจะสั่งอาหารไม่ได้');
  $('btnCloseToday').textContent = closedToday ? '🔓 เปิดร้านวันนี้' : '🚪 ปิดร้านวันนี้';
}
$('btnCloseToday').addEventListener('click', async () => {
  const btn = $('btnCloseToday');
  const want = !closedToday;
  const ok = await ask(
    want ? 'ปิดร้านวันนี้?' : 'เปิดร้านวันนี้?',
    want ? 'วันนี้ลูกค้าจะสั่งอาหารไม่ได้ (สแกน QR แล้วระบบแจ้งว่าร้านปิด) — เปิดคืนได้ทุกเมื่อ และระบบเปิดให้เองเมื่อขึ้นวันใหม่'
         : 'เปิดร้านตามปกติ ลูกค้าสั่งอาหารได้ตามเวลาเปิด–ปิดที่ตั้งไว้',
    want ? 'ปิดร้านวันนี้' : 'เปิดร้าน');
  if (!ok) return;
  btn.disabled = true;
  try {
    const r = await API.setCloseToday(want);
    paintShopState(r.hours);
    toast(r.message || 'บันทึกแล้ว');
  } catch (err) { $('err').textContent = err.message; }
  finally { btn.disabled = false; }
});

$('btnHistory').addEventListener('click', () => NAV.go('/shop/history.html'));
$('btnReload').addEventListener('click', () => load().then(() => toast('โหลดใหม่แล้ว')));

if (window.qpageShop && API.onLive) {
  API.onLive((state) => {
    const live = $('live');
    live.className = 'live ' + state;
    $('liveText').textContent = state === 'open' ? 'อัปเดตสด' : state === 'error' ? 'ขาดการเชื่อมต่อ' : 'กำลังเชื่อมต่อ…';
  });
}

load();

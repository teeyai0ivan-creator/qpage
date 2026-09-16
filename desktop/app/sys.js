/**
 * sys.js — หน้าจอ "ตั้งค่าระบบ" ของ "โปรแกรม" (ไม่ใช่หน้าเว็บ)
 * ตอนนี้มีตัวเลือกเดียวตามหน้าเว็บ: ปิดใช้งาน QR ของโต๊ะทันทีเมื่อเช็คบิล (ต้องยืนยันก่อนทุกครั้ง)
 */
'use strict';

const API = window.qpageShop;
const NAV = window.qpageNav;
const $ = (id) => document.getElementById(id);
let enabled = false;
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
    $('err').textContent = '';
    paint();
  } catch (err) {
    $('err').textContent = 'โหลดค่าตั้งไม่สำเร็จ: ' + err.message;
  }
}

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

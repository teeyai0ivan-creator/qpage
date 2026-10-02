/**
 * delivery.js — หน้าจอ "รับที่บ้าน / รับที่ร้าน" ของ "โปรแกรม"
 *
 * คิวออเดอร์เดลิเวอร์รี่/รับที่ร้านที่ยังไม่ปิดบิล — กด "รับแล้ว" เพื่อปิดบิล
 * (บิลเงินสด = บันทึกรับเงินด้วย · บิลโอนเงินจะปิดเองเมื่อครัวเคลียร์ครบ จึงมักไม่โผล่ที่นี่)
 */
'use strict';

const API = window.qpageOrders;      // สะพานจาก preload (ใช้ตัวเดียวกับหน้าสั่งอาหาร)
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '฿' + Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const pad = (n) => String(n).padStart(2, '0');
const billNo = (n) => (n ? '#' + String(n).padStart(4, '0') : '—');
const dt = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? iso : pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };

let orders = [];
let filter = 'all';

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2600);
}

/** ยืนยันแบบ UI ของโปรแกรม (ไม่ใช้กล่องของเบราว์เซอร์) */
function ask(title, message, okText) {
  return new Promise((resolve) => {
    $('askTitle').textContent = title;
    $('askMsg').textContent = message;
    $('askOk').textContent = okText || 'ยืนยัน';
    $('askOverlay').classList.add('show');
    const done = (v) => { $('askOverlay').classList.remove('show'); $('askOk').onclick = null; $('askCancel').onclick = null; resolve(v); };
    $('askOk').onclick = () => done(true);
    $('askCancel').onclick = () => done(false);
  });
}

function mapLinkOf(o) {
  if (o.customer_lat != null && o.customer_lng != null && o.customer_lat !== '' && o.customer_lng !== '') {
    return 'https://maps.google.com/?q=' + encodeURIComponent(o.customer_lat + ',' + o.customer_lng);
  }
  const m = String(o.customer_address || '').match(/https?:\/\/\S+/);
  return m ? m[0] : '';
}
const isReady = (o) => o.status === 'open' && o.progress && o.progress.ready;
const isCashDue = (o) => o.status === 'open' && o.payment_method === 'cash' && o.payment_status !== 'paid';

function payBadge(o) {
  if (o.status === 'awaiting_payment') return '<span class="badge unpaid">รอชำระเงิน (โอน)</span>';
  if (o.payment_status === 'paid') return '<span class="badge paid">' + (o.payment_method === 'cash' ? 'เงินสด (รับแล้ว)' : 'โอนแล้ว') + '</span>';
  return '<span class="badge cash">เก็บเงินปลายทาง</span>';
}
function stateBadge(o) {
  const p = o.progress || {};
  if (o.status === 'awaiting_payment') return '<span class="badge unpaid">ยังไม่เข้าครัว</span>';
  if (p.ready) return '<span class="badge ready">อาหารครบ · พร้อมส่ง/รับ</span>';
  return '<span class="badge cook">กำลังทำ ' + (p.done || 0) + '/' + (p.plates || 0) + ' จาน</span>';
}
function matches(o) {
  if (filter === 'ready') return isReady(o);
  if (filter === 'cook') return o.status === 'open' && !isReady(o);
  if (filter === 'cash') return isCashDue(o);
  return true;
}

function render() {
  const list = orders.filter(matches);
  const nReady = orders.filter(isReady).length;
  const nCash = orders.filter(isCashDue).length;
  $('nReady').textContent = nReady;
  $('nCash').textContent = nCash;
  const cnt = (fn) => orders.filter(fn).length;
  $('cAll').textContent = orders.length ? '(' + orders.length + ')' : '';
  $('cCook').textContent = cnt((o) => o.status === 'open' && !isReady(o)) || '';
  $('cReady').textContent = nReady || '';
  $('cCash').textContent = nCash || '';

  const box = $('list');
  if (!list.length) {
    box.innerHTML = '<div class="empty-state">' + (orders.length ? 'ไม่มีออเดอร์ในตัวกรองนี้' : 'ยังไม่มีออเดอร์เดลิเวอร์รี่/รับที่ร้านที่ต้องจัดการ') + '</div>';
    return;
  }
  box.innerHTML = list.map((o) => {
    const isD = o.order_type === 'delivery';
    const ready = isReady(o);
    const cls = o.status === 'awaiting_payment' ? 'unpaid' : (ready ? 'ready' : (isCashDue(o) ? 'cash' : ''));
    const map = mapLinkOf(o);
    const items = (o.items || []).filter((i) => i.status !== 'cancelled').map((i) => {
      const st = i.status === 'done' ? 'เสร็จแล้ว' : (i.status === 'cooking' ? 'กำลังทำ' : 'รอทำ');
      return '<div class="it"><span class="q">' + (Number(i.quantity) || 0) + '×</span><span>' + esc(i.menu_name) + '</span><span class="st">' + st + '</span></div>';
    }).join('');
    const btn = o.status === 'open'
      ? '<button class="btn ' + (ready ? 'ok' : '') + '" data-recv="' + o.id + '" type="button"' + (ready ? '' : ' disabled') + '>✅ รับแล้ว</button>'
      : '<span class="s">รอลูกค้าชำระเงินก่อน</span>';
    return '<div class="card ' + cls + '">'
      + '<div class="top">'
      + '<div style="flex:1;min-width:220px;">'
      + '<div class="t">' + (isD ? '🛵 เดลิเวอร์รี่' : '🏠 รับที่ร้าน') + ' · บิล ' + billNo(o.bill_no) + ' · ' + esc(o.customer_name || '') + '</div>'
      + '<div class="s">' + dt(o.opened_at) + ' · เบอร์ ' + esc(o.customer_phone || '-') + ((o.progress && o.progress.plates) ? ' · ' + o.progress.plates + ' จาน' : '') + '</div>'
      + (o.customer_address ? '<div class="s">📍 ' + esc(o.customer_address) + (map ? ' — ' + esc(map) : '') + '</div>' : '')
      + (o.customer_note ? '<div class="s">📝 ' + esc(o.customer_note) + '</div>' : '')
      + '</div>'
      + '<div style="text-align:right;">' + payBadge(o) + '<div style="margin-top:6px;">' + stateBadge(o) + '</div></div>'
      + '</div>'
      + (items ? '<div class="items">' + items + '</div>' : '')
      + '<div class="foot"><span class="tot">' + money(o.total) + '</span><span class="spacer" style="flex:1;"></span>' + btn + '</div>'
      + '</div>';
  }).join('');
  box.querySelectorAll('[data-recv]').forEach((b) => b.addEventListener('click', () => receive(Number(b.dataset.recv), b)));
}

async function receive(orderId, btn) {
  const o = orders.find((x) => Number(x.id) === orderId);
  const cash = o && isCashDue(o);
  const ok = await ask(
    'รับแล้ว',
    'ยืนยันว่า' + (o && o.order_type === 'delivery' ? 'ส่งอาหารให้ลูกค้าแล้ว' : 'ลูกค้ามารับอาหารแล้ว')
      + (cash ? ' และเก็บเงินสด ' + money(o.total) + ' เรียบร้อย' : '')
      + '?\n\nระบบจะปิดบิลและพิมพ์ใบเสร็จ',
    'รับแล้ว · ปิดบิล'
  );
  if (!ok) return;
  btn.disabled = true;
  try {
    await API.closeRemote(orderId);
    toast('ปิดบิลแล้ว');
    await load();
  } catch (err) {
    toast('ทำรายการไม่สำเร็จ: ' + err.message);
    btn.disabled = false;
  }
}

async function load() {
  try {
    const data = await API.remoteOrders();
    orders = data.orders || [];
    render();
  } catch (err) {
    $('list').innerHTML = '<div class="empty-state">โหลดไม่สำเร็จ: ' + esc(err.message) + '</div>';
  }
}

document.querySelectorAll('.chip[data-f]').forEach((c) => c.addEventListener('click', () => {
  filter = c.dataset.f;
  document.querySelectorAll('.chip[data-f]').forEach((x) => x.classList.toggle('active', x === c));
  render();
}));
$('btnReload').addEventListener('click', () => load().then(() => toast('อัปเดตแล้ว')));

API.onLive((state) => {
  const live = $('live');
  live.className = 'live ' + state;
  $('liveText').textContent = state === 'open' ? 'อัปเดตสด' : state === 'error' ? 'ขาดการเชื่อมต่อ' : 'กำลังเชื่อมต่อ…';
});
API.onEvent((evt) => {
  if (['order_new', 'item_status', 'bill_changed', 'checkout', 'tables_changed'].includes(evt.type)) load();
});

load();
setInterval(load, 15000);

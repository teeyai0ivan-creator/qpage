/**
 * cashier.js — หน้าจอ "แคชเชียร์" ของ "โปรแกรม" (ไม่ใช่หน้าเว็บ)
 *
 * แคชเชียร์ต้องทำ 3 อย่างในจอเดียว:
 *   1) จัดรายการที่หมวดหมู่ถูกตั้งเส้นทางไว้ที่แคชเชียร์ (เครื่องดื่ม/ของว่าง) แล้วพิมพ์ใบสั่ง
 *   2) เก็บเงินบิลที่ครัวเคลียร์ครบแล้ว → ปิดบิล + พิมพ์ใบเสร็จ
 *   3) ขอใบเสร็จย้อนหลังให้ลูกค้า (พิมพ์ซ้ำ) จากบิลที่เก็บเงินไปแล้ววันนี้
 *
 * หน้าจอเป็นไฟล์ในเครื่อง (file://) จึงไม่เรียก API เอง — ส่งผ่าน IPC ให้ main ซึ่งถือ session ของร้านอยู่แล้ว
 */
'use strict';

const API = window.qpageCashier;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const money = (n) => '฿' + Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const billNo = (n) => (n ? '#' + String(n).padStart(4, '0') : '—');
const plates = (items) => (items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0);
const hhmm = (iso) => { const d = new Date(iso); return isNaN(d) ? '—' : pad(d.getHours()) + ':' + pad(d.getMinutes()); };

const REASONS = ['ของหมด', 'ลูกค้ายกเลิก', 'สั่งผิด', 'อื่น ๆ'];

let items = [];          // รายการที่ต้องจัด (station = cashier)
let bills = [];          // บิลที่เปิดอยู่
let today = [];          // บิลที่เก็บเงินแล้ววันนี้
let filter = 'all';
let groupBy = 'bill';
let cancelTarget = null;
let payTarget = null;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2800);
}

function optsText(json) {
  if (!json) return '';
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return '';
    return v.map((o) => (typeof o === 'string' ? o : (o && o.name) || '')).filter(Boolean).join(', ');
  } catch (e) { return ''; }
}

/** เวลาที่ผ่านมา (นาที:วินาที) — ใช้ทั้งกับรายการที่ต้องจัดและบิลที่รอเก็บเงิน */
function ageText(iso, status, doneAt) {
  const from = new Date(status === 'done' && doneAt ? doneAt : iso).getTime();
  if (isNaN(from)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - from) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? h + ':' + pad(m) + ':' + pad(sec) : pad(m) + ':' + pad(sec);
}
const isSameDay = (iso, d) => {
  const x = new Date(iso);
  return !isNaN(x) && x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth() && x.getDate() === d.getDate();
};

// ---------------------------------------------------------------------------
// 1) คิวรายการที่ต้องจัด (เครื่องดื่ม/ของว่าง)
// ---------------------------------------------------------------------------
function queueRowHtml(i) {
  const badge = i.status === 'pending' ? '<span class="badge wait">ยังไม่จัด</span>'
    : i.status === 'cooking' ? '<span class="badge cook">กำลังจัด</span>'
      : '<span class="badge done">จัดเสร็จ</span>';
  const opts = optsText(i.options_json);
  const acts = [];
  if (i.status === 'pending') acts.push(`<button class="btn btn-cook btn-sm" data-cook="${i.id}" type="button">เริ่มจัด</button>`);
  if (i.status === 'cooking') acts.push(`<button class="btn btn-clear btn-sm" data-clear="${i.id}" type="button">จัดเสร็จ</button>`);
  if (i.status !== 'done') acts.push(`<button class="btn btn-cancel btn-sm" data-cancel="${i.id}" data-name="${esc(i.menu_name)}" type="button">ยกเลิก</button>`);
  return `<div class="row ${i.status === 'done' ? 'done' : ''}">
    <div class="qty">${Number(i.quantity) || 0}×</div>
    <div class="info">
      <div class="name">${esc(i.menu_name)}</div>
      ${opts ? `<div class="opts">${esc(opts)}</div>` : ''}
      <div class="meta">สั่ง ${hhmm(i.created_at)} · <span class="age" data-since="${esc(i.created_at)}" data-status="${esc(i.status)}" data-done="${esc(i.done_at || '')}">${ageText(i.created_at, i.status, i.done_at)}</span></div>
    </div>
    ${badge}
    <div class="acts">${acts.join('')}</div>
  </div>`;
}

function queueGroups() {
  const list = filter === 'all' ? items : items.filter((i) => i.status === filter);
  if (groupBy === 'menu') {
    const map = new Map();
    for (const i of list) {
      const key = i.menu_id != null ? 'm' + i.menu_id : 'n' + i.menu_name;
      if (!map.has(key)) map.set(key, { title: i.menu_name, sub: '', items: [] });
      map.get(key).items.push(i);
    }
    return [...map.values()].map((g) => Object.assign(g, { sub: 'รวม ' + plates(g.items) + ' แก้ว/จาน' }));
  }
  const map = new Map();
  for (const i of list) {
    const key = String(i.order_id);
    if (!map.has(key)) map.set(key, { title: 'โต๊ะ ' + (i.table_code || '-'), sub: 'บิล ' + billNo(i.bill_no), items: [] });
    map.get(key).items.push(i);
  }
  return [...map.values()];
}

function renderQueue() {
  const nWait = items.filter((i) => i.status === 'pending').reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  const nCook = items.filter((i) => i.status === 'cooking').reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  const nDone = items.filter((i) => i.status === 'done').reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  $('cAll').textContent = items.length ? '(' + items.length + ')' : '';
  $('cWait').textContent = nWait ? '(' + nWait + ')' : '';
  $('cCook').textContent = nCook ? '(' + nCook + ')' : '';
  $('cDone').textContent = nDone ? '(' + nDone + ')' : '';

  const box = $('queue');
  const gs = queueGroups();
  if (!gs.length) {
    box.innerHTML = '<div class="empty">' + (items.length ? 'ไม่มีรายการในสถานะนี้' : 'ยังไม่มีรายการเครื่องดื่ม/ของว่างที่ต้องจัด') + '</div>';
    return;
  }
  box.innerHTML = gs.map((g) => {
    const pend = g.items.filter((i) => i.status === 'pending');
    const startAll = pend.length
      ? `<button class="btn btn-start-all" data-start-all="${pend.map((i) => i.id).join(',')}" type="button">🖨 เริ่มจัดทั้งโต๊ะ (${pend.length})</button>`
      : '';
    return `<section class="bill">
      <div class="bill-head">
        <span class="t">${esc(g.title)}</span>${g.sub ? `<span class="b">· ${esc(g.sub)}</span>` : ''}
        <span class="spacer"></span>
        ${startAll}
      </div>
      ${g.items.map(queueRowHtml).join('')}
    </section>`;
  }).join('');

  box.querySelectorAll('[data-cook]').forEach((b) => b.addEventListener('click', () => doStatus(Number(b.dataset.cook), 'cooking', b)));
  box.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => doStatus(Number(b.dataset.clear), 'done', b)));
  box.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => openCancel(Number(b.dataset.cancel), b.dataset.name)));
  box.querySelectorAll('[data-start-all]').forEach((b) => b.addEventListener('click', () => startAll(b)));
}

// ---------------------------------------------------------------------------
// 2) บิลที่เปิดอยู่ → เก็บเงิน
// ---------------------------------------------------------------------------
const liveItems = (o) => (o.items || []).filter((i) => i.status !== 'cancelled');
const billPlates = (o) => plates(liveItems(o));
const platesLiveDone = (o) => liveItems(o).filter((i) => i.status === 'done').reduce((s, i) => s + (Number(i.quantity) || 0), 0);
const billReady = (o) => liveItems(o).length > 0 && liveItems(o).every((i) => i.status === 'done');

function billItemsHtml(o) {
  const list = liveItems(o);
  if (!list.length) return '<div class="row"><div class="info"><div class="opts">ไม่มีรายการในบิลนี้</div></div></div>';
  return list.map((i) => {
    const badge = i.status === 'pending' ? '<span class="badge wait">รอทำ</span>'
      : i.status === 'cooking' ? '<span class="badge cook">กำลังทำ</span>'
        : '<span class="badge done">เสร็จ</span>';
    const opts = optsText(i.options_json);
    return `<div class="row ${i.status === 'done' ? 'done' : ''}">
      <div class="qty">${Number(i.quantity) || 0}×</div>
      <div class="info">
        <div class="name">${esc(i.menu_name)}</div>
        ${opts ? `<div class="opts">${esc(opts)}</div>` : ''}
      </div>
      ${badge}
      <div class="acts" style="min-width:74px;justify-content:flex-end;"><span style="font-weight:700;font-variant-numeric:tabular-nums;">${money(i.line_total)}</span></div>
    </div>`;
  }).join('');
}

function billCardHtml(o) {
  const ready = billReady(o);
  const left = billPlates(o) - platesLiveDone(o);
  return `<section class="bill ${ready ? 'ready' : ''}" data-order="${o.id}">
    <div class="bill-head">
      <span class="t">โต๊ะ ${esc(o.table_code || '-')}</span>
      <span class="b">· บิล ${billNo(o.bill_no)}</span>
      <span class="spacer"></span>
      <span class="age" data-prefix="⏱ " data-since="${esc(o.opened_at)}" data-status="cooking" data-done="">⏱ ${ageText(o.opened_at, 'cooking', null)}</span>
      ${ready
        ? `<button class="btn btn-pay" data-pay="${o.table_id}" type="button">💰 เก็บเงิน</button>`
        : `<span class="badge wait">ครัวยังทำไม่เสร็จ ${left} จาน</span>`}
    </div>
    <div class="sum">
      <span class="plates">${billPlates(o)} จาน</span>
      <span class="amt">${money(o.total)}</span>
      <span class="spacer"></span>
      <button class="btn btn-sm" data-toggle="${o.id}" type="button">ดูรายการ</button>
      <button class="btn btn-sm" data-print="${o.id}" type="button">🖨 พิมพ์บิล</button>
    </div>
    <div class="items" id="items-${o.id}" hidden>${billItemsHtml(o)}</div>
  </section>`;
}

function renderBills() {
  const list = bills.filter((o) => billPlates(o) > 0);
  const ready = list.filter(billReady).sort((a, b) => new Date(a.opened_at) - new Date(b.opened_at));
  const waiting = list.filter((o) => !billReady(o)).sort((a, b) => new Date(a.opened_at) - new Date(b.opened_at));
  $('nBills').textContent = ready.length;
  $('amtDue').textContent = money(ready.reduce((s, o) => s + Number(o.total || 0), 0));

  const box = $('bills');
  if (!list.length) {
    box.innerHTML = '<div class="empty">ยังไม่มีบิลที่เปิดอยู่ — เมื่อลูกค้าสั่งอาหาร บิลจะขึ้นที่นี่</div>';
    return;
  }
  let html = '';
  if (ready.length) {
    html += `<div class="sec-title" style="margin:0;">พร้อมเก็บเงิน (${ready.length}) <span class="line"></span></div>`;
    html += ready.map(billCardHtml).join('');
  }
  if (waiting.length) {
    html += `<div class="sec-title" style="margin:6px 0 0;">ครัวยังทำไม่เสร็จ (${waiting.length}) <span class="line"></span></div>`;
    html += waiting.map(billCardHtml).join('');
  }
  box.innerHTML = html;

  box.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', () => openPay(Number(b.dataset.pay))));
  box.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
    const el = $('items-' + b.dataset.toggle);
    if (!el) return;
    el.hidden = !el.hidden;
    b.textContent = el.hidden ? 'ดูรายการ' : 'ซ่อนรายการ';
  }));
  box.querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', () => {
    const id = Number(b.dataset.print);
    API.printReceipt({ orderId: id, url_path: '/shop/receipt.html?order=' + id });
    toast('กำลังพิมพ์บิลให้ลูกค้าตรวจ');
  }));
}

// ---------------------------------------------------------------------------
// 3) เก็บเงินแล้ววันนี้ (พิมพ์ใบเสร็จซ้ำได้)
// ---------------------------------------------------------------------------
function renderToday() {
  const list = today;
  $('amtToday').textContent = money(list.reduce((s, o) => s + Number(o.total || 0), 0));
  $('todayCount').textContent = list.length ? '(' + list.length + ' บิล)' : '';
  const box = $('today');
  if (!list.length) {
    box.innerHTML = '<div class="empty">วันนี้ยังไม่มีการเก็บเงิน</div>';
    return;
  }
  box.innerHTML = list.map((o) => `<section class="bill">
    <div class="bill-head" style="background:var(--money-bg);">
      <span class="t">บิล ${billNo(o.bill_no)}</span>
      <span class="b">· โต๊ะ ${esc(o.table_code || '-')}</span>
      <span class="spacer"></span>
      <span class="age">ปิด ${hhmm(o.closed_at)} · ${o.item_count} จาน</span>
      <span class="amt" style="font-size:16px;">${money(o.total)}</span>
      <button class="btn btn-sm" data-reprint="${o.id}" type="button">🖨 พิมพ์ใบเสร็จซ้ำ</button>
    </div>
  </section>`).join('');
  box.querySelectorAll('[data-reprint]').forEach((b) => b.addEventListener('click', () => {
    const id = Number(b.dataset.reprint);
    API.printReceipt({ orderId: id, url_path: '/shop/receipt.html?order=' + id });
    toast('กำลังพิมพ์ใบเสร็จซ้ำ (บิล #' + id + ')');
  }));
}

// ---------------------------------------------------------------------------
// เก็บเงิน (ปิดบิล + พิมพ์ใบเสร็จ)
// ---------------------------------------------------------------------------
function openPay(tableId) {
  const o = bills.find((x) => Number(x.table_id) === Number(tableId));
  if (!o) return;
  payTarget = o;
  $('payTable').textContent = 'โต๊ะ ' + (o.table_code || '-');
  $('payBill').textContent = billNo(o.bill_no);
  $('payPlates').textContent = billPlates(o) + ' จาน';
  $('payTotal').textContent = money(o.total);
  $('payOverlay').classList.add('show');
}
function closePay() { $('payOverlay').classList.remove('show'); payTarget = null; }

async function doPay() {
  const o = payTarget;
  if (!o) return;
  const btn = $('payConfirm');
  btn.disabled = true;
  try {
    const r = await API.checkout(o.table_id);
    closePay();
    toast('เก็บเงินโต๊ะ ' + (o.table_code || '-') + ' แล้ว' + (r.closed ? ' — กำลังพิมพ์ใบเสร็จ' : ''));
    if (r.closed) API.printReceipt({ orderId: r.closed.order_id, url_path: '/shop/receipt.html?order=' + r.closed.order_id });
    await loadAll();
  } catch (err) {
    toast('เก็บเงินไม่สำเร็จ: ' + err.message);
  } finally { btn.disabled = false; }
}

// ---------------------------------------------------------------------------
// ยกเลิกรายการ (พร้อมสาเหตุ)
// ---------------------------------------------------------------------------
function openCancel(id, name) {
  cancelTarget = id;
  $('cancelItemName').textContent = name || '';
  $('cancelReason').value = '';
  $('reasonList').innerHTML = REASONS.map((r) => `<button class="btn" data-reason="${esc(r)}" type="button">${esc(r)}</button>`).join('');
  $('reasonList').querySelectorAll('[data-reason]').forEach((b) => b.addEventListener('click', () => { $('cancelReason').value = b.dataset.reason; $('cancelConfirm').focus(); }));
  $('cancelOverlay').classList.add('show');
  setTimeout(() => $('cancelReason').focus(), 50);
}
function closeCancel() { $('cancelOverlay').classList.remove('show'); cancelTarget = null; }

// ---------------------------------------------------------------------------
// ทำงานกับเซิร์ฟเวอร์
// ---------------------------------------------------------------------------
async function doStatus(id, status, btn) {
  if (btn) btn.disabled = true;
  try {
    if (status === 'cooking') {
      // เริ่มจัดรายการเดียว = เริ่มแล้วพิมพ์ใบสั่งให้แคชเชียร์ (เหมือนหน้าเว็บ)
      const r = await API.start([id]);
      if (!r.started.length) { toast('รายการนี้เริ่มจัดไปแล้ว'); await loadAll(); return; }
      await loadAll();
      toast('เริ่มจัดแล้ว — กำลังพิมพ์ใบสั่ง');
      for (const round of (r.rounds || [])) API.printRound({ roundId: round.print_id, url_path: round.url_path });
      return;
    }
    await API.status(id, status);
    toast(status === 'done' ? 'จัดเสร็จแล้ว' : 'อัปเดตแล้ว');
    await loadAll();
  } catch (err) {
    toast('ทำรายการไม่สำเร็จ: ' + err.message);
    if (btn) btn.disabled = false;
  }
}

/** เริ่มจัดทั้งโต๊ะ (เฉพาะที่ยังไม่จัด) แล้วพิมพ์ใบสั่งให้แคชเชียร์ */
async function startAll(btn) {
  const ids = String(btn.dataset.startAll).split(',').map(Number).filter(Boolean);
  if (!ids.length) return;
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'กำลังเริ่มจัด…';
  try {
    const r = await API.start(ids);
    if (!r.started.length) { toast('รายการนี้เริ่มจัดไปแล้ว'); await loadAll(); return; }
    await loadAll();
    toast('เริ่มจัด ' + r.started.length + ' รายการ — กำลังพิมพ์ใบสั่ง');
    for (const round of (r.rounds || [])) API.printRound({ roundId: round.print_id, url_path: round.url_path });
  } catch (err) {
    toast('ทำรายการไม่สำเร็จ: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function loadAll() {
  try {
    const [q, b, h] = await Promise.all([API.items(), API.bills(), API.history(50)]);
    items = q.items || [];
    bills = b || [];
    const now = new Date();
    today = (h || []).filter((o) => isSameDay(o.closed_at, now));
    renderQueue();
    renderBills();
    renderToday();
  } catch (err) {
    $('bills').innerHTML = '<div class="empty">โหลดข้อมูลไม่สำเร็จ: ' + esc(err.message) + '</div>';
  }
}

// ---------- ตัวกรอง/การจัดกลุ่ม/รีเฟรช ----------
document.querySelectorAll('.chip[data-filter]').forEach((c) => c.addEventListener('click', () => {
  filter = c.dataset.filter;
  document.querySelectorAll('.chip[data-filter]').forEach((x) => x.classList.toggle('active', x === c));
  renderQueue();
}));
document.querySelectorAll('.seg [data-group]').forEach((b) => b.addEventListener('click', () => {
  groupBy = b.dataset.group;
  document.querySelectorAll('.seg [data-group]').forEach((x) => x.classList.toggle('active', x === b));
  renderQueue();
}));
$('btnReload').addEventListener('click', () => loadAll().then(() => toast('อัปเดตแล้ว')));

$('payClose').addEventListener('click', closePay);
$('payConfirm').addEventListener('click', doPay);
$('payOverlay').addEventListener('click', (e) => { if (e.target === $('payOverlay')) closePay(); });
$('cancelClose').addEventListener('click', closeCancel);
$('cancelOverlay').addEventListener('click', (e) => { if (e.target === $('cancelOverlay')) closeCancel(); });
$('cancelConfirm').addEventListener('click', async () => {
  const reason = $('cancelReason').value.trim();
  if (!reason) { toast('กรุณาระบุสาเหตุการยกเลิก'); return; }
  const id = cancelTarget;
  closeCancel();
  try {
    await API.cancel(id, reason);
    toast('ยกเลิกรายการแล้ว (' + reason + ')');
    await loadAll();
  } catch (err) { toast('ยกเลิกไม่สำเร็จ: ' + err.message); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePay(); closeCancel(); } });

// ---------- อัปเดตสด ----------
API.onLive((state) => {
  const live = $('live');
  live.className = 'live ' + state;
  $('liveText').textContent = state === 'open' ? 'อัปเดตสด' : state === 'error' ? 'ขาดการเชื่อมต่อ' : 'กำลังเชื่อมต่อ…';
});
API.onEvent((evt) => {
  if (['order_new', 'item_status', 'bill_changed', 'checkout', 'tables_changed'].includes(evt.type)) loadAll();
});

// นาฬิกาจับเวลาบนการ์ด (เดินเองโดยไม่ต้องดึงจากเซิร์ฟเวอร์)
setInterval(() => {
  document.querySelectorAll('.age[data-since]').forEach((el) => {
    el.textContent = (el.dataset.prefix || '') + ageText(el.dataset.since, el.dataset.status, el.dataset.done);
  });
}, 1000);

loadAll();
setInterval(loadAll, 30000);   // สำรอง เผื่อสายเรียลไทม์หลุด

/**
 * kitchen.js — หน้าจอครัว/แคชเชียร์ของ "โปรแกรม" (ไม่ใช่หน้าเว็บ)
 *
 * ตัวหน้าจอไม่คุยกับเซิร์ฟเวอร์เอง (ไฟล์ในเครื่องเรียกข้ามโดเมนพร้อมคุกกี้ไม่ได้)
 * ทุกอย่างส่งผ่าน IPC ไปให้ main process ซึ่งถือ session ของร้านอยู่แล้ว → main เรียก API ให้
 */
'use strict';

const API = window.qpageKitchen;     // สะพานจาก preload
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const billNo = (n) => (n ? '#' + String(n).padStart(4, '0') : '—');

const params = new URLSearchParams(location.search);
const STATION = params.get('station') === 'cashier' ? 'cashier' : 'kitchen';
const L = STATION === 'cashier'
  ? { title: 'แคชเชียร์', sub: 'รายการจากหมวดหมู่ที่ตั้งเส้นทางไว้ที่แคชเชียร์', start: 'เริ่มจัด', done: 'จัดเสร็จ', wait: 'ยังไม่จัด', cooking: 'กำลังจัด', finished: 'จัดเสร็จ' }
  : { title: 'ครัว', sub: 'รายการอาหารจากบิลที่เปิดอยู่ — กดเริ่มทำแล้วระบบจะพิมพ์ใบสั่งครัว', start: 'เริ่มทำ', done: 'เคลียร์อาหาร', wait: 'รอทำ', cooking: 'กำลังทำ', finished: 'เสร็จแล้ว' };

const REASONS = STATION === 'cashier'
  ? ['ของหมด', 'ลูกค้ายกเลิก', 'สั่งผิด', 'อื่น ๆ']
  : ['วัตถุดิบหมด', 'ลูกค้ายกเลิก', 'ทำซ้ำ/สั่งผิด', 'อื่น ๆ'];

let items = [];
let filter = 'all';
let groupBy = 'bill';
let timer = null;
let cancelTarget = null;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2600);
}

function optsText(json) {
  if (!json) return '';
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return '';
    return v.map((o) => (typeof o === 'string' ? o : (o && o.name) || '')).filter(Boolean).join(', ');
  } catch (e) { return ''; }
}

/** อายุรายการ (นาที:วินาที) นับจากเวลาที่ลูกค้าสั่ง */
function ageText(iso, status, doneAt) {
  const from = new Date(status === 'done' && doneAt ? doneAt : iso).getTime();
  if (isNaN(from)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - from) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? h + ':' + pad(m) + ':' + pad(sec) : pad(m) + ':' + pad(sec);
}
const hhmm = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' · '; };

function rowHtml(i) {
  const badge = i.status === 'pending' ? `<span class="badge wait">${L.wait}</span>`
    : i.status === 'cooking' ? `<span class="badge cook">${L.cooking}</span>`
      : `<span class="badge done">${L.finished}</span>`;
  const opts = optsText(i.options_json);
  const acts = [];
  if (i.status === 'pending') acts.push(`<button class="btn btn-cook" data-cook="${i.id}" type="button">${L.start}</button>`);
  if (i.status === 'cooking') acts.push(`<button class="btn btn-clear" data-clear="${i.id}" type="button">${L.done}</button>`);
  if (i.status !== 'done') acts.push(`<button class="btn btn-cancel" data-cancel="${i.id}" data-name="${esc(i.menu_name)}" type="button">ยกเลิก</button>`);
  return `<div class="row ${i.status === 'done' ? 'done' : ''}">
    <div class="qty">${Number(i.quantity) || 0}×</div>
    <div class="info">
      <div class="name">${esc(i.menu_name)}</div>
      ${opts ? `<div class="opts">${esc(opts)}</div>` : ''}
      <div class="meta">สั่ง ${hhmm(i.created_at)}<span class="age" data-since="${esc(i.created_at)}" data-status="${esc(i.status)}" data-done="${esc(i.done_at || '')}">${ageText(i.created_at, i.status, i.done_at)}</span></div>
    </div>
    ${badge}
    <div class="acts">${acts.join('')}</div>
  </div>`;
}

function groups() {
  const list = filter === 'all' ? items : items.filter((i) => i.status === filter);
  if (groupBy === 'menu') {
    const map = new Map();
    for (const i of list) {
      const key = i.menu_id != null ? 'm' + i.menu_id : 'n' + i.menu_name;
      if (!map.has(key)) map.set(key, { title: i.menu_name, sub: '', items: [], ctx: true });
      map.get(key).items.push(i);
    }
    return [...map.values()].map((g) => Object.assign(g, { sub: 'รวม ' + g.items.reduce((s, i) => s + (Number(i.quantity) || 0), 0) + ' จาน' }));
  }
  const map = new Map();
  for (const i of list) {
    const key = String(i.order_id);
    if (!map.has(key)) map.set(key, { title: 'โต๊ะ ' + (i.table_code || '-'), sub: 'บิล ' + billNo(i.bill_no), items: [], ctx: false, orderId: i.order_id });
    map.get(key).items.push(i);
  }
  return [...map.values()];
}

function render() {
  const all = items.length;
  const nWait = items.filter((i) => i.status === 'pending').reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  const nCook = items.filter((i) => i.status === 'cooking').reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  const nDone = items.filter((i) => i.status === 'done').reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  $('nWait').textContent = nWait; $('nCook').textContent = nCook; $('nDone').textContent = nDone;
  $('cAll').textContent = all ? '(' + all + ')' : '';
  $('cWait').textContent = nWait ? '(' + nWait + ')' : '';
  $('cCook').textContent = nCook ? '(' + nCook + ')' : '';
  $('cDone').textContent = nDone ? '(' + nDone + ')' : '';
  $('pgTitle').textContent = L.title;
  $('pgSub').textContent = L.sub;

  const box = $('list');
  const gs = groups();
  if (!gs.length) {
    box.innerHTML = '<div class="empty">' + (items.length ? 'ไม่มีรายการในสถานะนี้' : 'ยังไม่มีรายการ — รอลูกค้าสั่งอาหาร') + '</div>';
    return;
  }
  box.innerHTML = gs.map((g) => {
    const pend = g.items.filter((i) => i.status === 'pending');
    const startAll = (!g.ctx && pend.length)
      ? `<button class="btn btn-start-all" data-start-all="${pend.map((i) => i.id).join(',')}" type="button">🖨 ${L.start}ทั้งโต๊ะ (${pend.length})</button>`
      : '';
    const oldest = g.items.reduce((min, i) => {
      const t = new Date(i.status === 'done' && i.done_at ? i.done_at : i.created_at).getTime();
      return isNaN(t) ? min : Math.min(min, t);
    }, Infinity);
    const age = Number.isFinite(oldest) ? ageText(new Date(oldest).toISOString(), 'cooking', null) : '—';
    const isOld = Number.isFinite(oldest) && (Date.now() - oldest) > 15 * 60 * 1000;
    return `<section class="bill">
      <div class="bill-head">
        <span class="t">${esc(g.title)}</span>${g.sub ? `<span class="b">· ${esc(g.sub)}</span>` : ''}
        <span class="spacer"></span>
        <span class="age ${isOld ? 'old' : ''}" title="เวลารวมของโต๊ะนี้">⏱ ${age}</span>
        ${startAll}
      </div>
      ${g.items.map(rowHtml).join('')}
    </section>`;
  }).join('');

  box.querySelectorAll('[data-cook]').forEach((b) => b.addEventListener('click', () => doStatus(Number(b.dataset.cook), 'cooking', b)));
  box.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => doStatus(Number(b.dataset.clear), 'done', b)));
  box.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => openCancel(Number(b.dataset.cancel), b.dataset.name)));
  box.querySelectorAll('[data-start-all]').forEach((b) => b.addEventListener('click', () => startAll(b)));
}

/** นาฬิกาจับเวลาบนการ์ด (ไม่ต้องรีเฟรชจากเซิร์ฟเวอร์) */
function tick() {
  document.querySelectorAll('.age[data-since]').forEach((el) => {
    el.textContent = ageText(el.dataset.since, el.dataset.status, el.dataset.done);
  });
}

async function load() {
  try {
    const data = await API.list(STATION);
    items = data.items || [];
    render();
  } catch (err) {
    $('list').innerHTML = '<div class="empty">โหลดรายการไม่สำเร็จ: ' + esc(err.message) + '</div>';
  }
}

/** เริ่มทำรายการเดียวแล้วพิมพ์ใบสั่งครัวของรายการนั้น (เหมือนหน้าเว็บ: กดเริ่มทำ = พิมพ์) */
async function doStatus(id, status, btn) {
  if (btn) btn.disabled = true;
  try {
    if (status === 'cooking') {
      const r = await API.start([id]);
      if (!r.started.length) { toast('รายการนี้เริ่มทำไปแล้ว'); await load(); return; }
      await load();
      toast('เริ่มทำแล้ว — กำลังพิมพ์ใบสั่งครัว');
      for (const round of (r.rounds || [])) API.printRound({ roundId: round.print_id, url_path: round.url_path });
      return;
    }
    await API.status(id, status);
    toast(status === 'done' ? 'เคลียร์อาหารแล้ว' : 'อัปเดตแล้ว');
    await load();
  } catch (err) {
    toast('ทำรายการไม่สำเร็จ: ' + err.message);
    if (btn) btn.disabled = false;
  }
}

/** เริ่มทำทั้งโต๊ะ (เฉพาะที่ยังรอทำ) แล้วพิมพ์ใบสั่งครัว */
async function startAll(btn) {
  const ids = String(btn.dataset.startAll).split(',').map(Number).filter(Boolean);
  if (!ids.length) return;
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'กำลังเริ่มทำ…';
  try {
    const r = await API.start(ids);
    if (!r.started.length) { toast('รายการนี้เริ่มทำไปแล้ว'); await load(); return; }
    await load();
    toast('เริ่มทำ ' + r.started.length + ' รายการ — กำลังพิมพ์ใบสั่งครัว');
    // พิมพ์ใบสั่งครัว (main เปิดหน้าพิมพ์ในหน้าต่างซ่อนให้)
    for (const round of (r.rounds || [])) API.printRound({ roundId: round.print_id, url_path: round.url_path });
  } catch (err) {
    toast('ทำรายการไม่สำเร็จ: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// ---------- ยกเลิกรายการ (พร้อมสาเหตุ) ----------
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
    await load();
  } catch (err) { toast('ยกเลิกไม่สำเร็จ: ' + err.message); }
});

// ---------- ตัวกรอง/การจัดกลุ่ม/รีเฟรช ----------
document.querySelectorAll('.chip[data-filter]').forEach((c) => c.addEventListener('click', () => {
  filter = c.dataset.filter;
  document.querySelectorAll('.chip[data-filter]').forEach((x) => x.classList.toggle('active', x === c));
  render();
}));
document.querySelectorAll('.seg [data-group]').forEach((b) => b.addEventListener('click', () => {
  groupBy = b.dataset.group;
  document.querySelectorAll('.seg [data-group]').forEach((x) => x.classList.toggle('active', x === b));
  render();
}));
$('btnReload').addEventListener('click', () => { load().then(() => toast('อัปเดตแล้ว')); });

// ---------- อัปเดตสดจากเซิร์ฟเวอร์ ----------
API.onLive((state) => {
  const live = $('live');
  live.className = 'live ' + state;
  $('liveText').textContent = state === 'open' ? 'อัปเดตสด' : state === 'error' ? 'ขาดการเชื่อมต่อ' : 'กำลังเชื่อมต่อ…';
});
API.onEvent((evt) => {
  // มีเหตุการณ์จากครัว/ลูกค้า → ดึงข้อมูลใหม่ทันที (ไม่ต้องรอรีเฟรช)
  if (['order_new', 'item_status', 'bill_changed', 'checkout', 'tables_changed'].includes(evt.type)) load();
});

load();
tick();
timer = setInterval(tick, 1000);
setInterval(load, 30000);   // สำรอง เผื่อสายเรียลไทม์หลุด

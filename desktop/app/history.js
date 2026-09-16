/**
 * history.js — หน้าจอ "ประวัติ" ของ "โปรแกรม" (ไม่ใช่หน้าเว็บ)
 *
 * 2 แท็บ:
 *   1) ประวัติบิล — บิลที่ปิดแล้ว (กรองตามโต๊ะ/จำนวน) · ดูรายการในบิล · พิมพ์ใบเสร็จซ้ำ · ออก CSV
 *   2) QR โต๊ะที่ปิดใช้งาน — ดู/ดาวน์โหลด QR เดิมเก็บเป็นหลักฐาน พร้อมยอดขายของโต๊ะนั้น
 *
 * หน้าจอเป็นไฟล์ในเครื่อง (file://) จึงไม่เรียก API เอง — ส่งผ่าน IPC ให้ main ซึ่งถือ session ของร้านอยู่แล้ว
 */
'use strict';

const API = window.qpageHistory;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const money = (n) => '฿' + Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const billNo = (n) => (n ? '#' + String(n).padStart(4, '0') : '—');
const dt = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(-2) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
};
const optsText = (json) => {
  if (!json) return '';
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.map((o) => (typeof o === 'string' ? o : (o && o.name) || '')).filter(Boolean).join(', ') : ''; } catch (e) { return ''; }
};
const csvCell = (c) => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"';
const csvRows = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

let tab = 'bills';
let orders = [];
let retired = [];
const openBills = new Set();      // บิลที่กางรายการอยู่ (จำสถานะไว้หลังรีเฟรช)
const qrImages = new Map();       // tableId → data URL (โหลดครั้งเดียว)

function toast(msg, revealPath) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), revealPath ? 6000 : 3000);
  t._path = revealPath || '';
}
$('toast').addEventListener('click', () => { const p = $('toast')._path; if (p) API.reveal(p); });

// ---------------------------------------------------------------------------
// แท็บ
// ---------------------------------------------------------------------------
function showTab(which) {
  tab = which;
  document.querySelectorAll('.chip[data-tab]').forEach((c) => c.classList.toggle('active', c.dataset.tab === which));
  $('paneBills').hidden = which !== 'bills';
  $('paneQr').hidden = which !== 'qr';
  $('btnExport').textContent = which === 'qr' ? '⬇ ออกรายการ QR (CSV)' : '⬇ ออกรายการ (CSV)';
}
document.querySelectorAll('.chip[data-tab]').forEach((c) => c.addEventListener('click', () => showTab(c.dataset.tab)));

// ---------------------------------------------------------------------------
// แท็บ 1: ประวัติบิล
// ---------------------------------------------------------------------------
function billItemsHtml(o) {
  const items = o.items || [];
  if (!items.length) return '<div class="row"><div class="info"><div class="opts">ไม่มีรายการในบิลนี้</div></div></div>';
  return items.map((i) => {
    const cancelled = i.status === 'cancelled';
    const opts = optsText(i.options_json);
    return `<div class="row">
      <div class="qty">${Number(i.quantity) || 0}×</div>
      <div class="info">
        <div class="name ${cancelled ? 'cancelled' : ''}">${esc(i.menu_name)}</div>
        ${opts ? `<div class="opts">${esc(opts)}</div>` : ''}
      </div>
      ${cancelled ? `<span class="badge cancel">ยกเลิก${i.cancel_reason ? ': ' + esc(i.cancel_reason) : ''}</span>` : ''}
      <span class="price">${cancelled ? '—' : money(i.line_total)}</span>
    </div>`;
  }).join('');
}

function renderBills() {
  $('cntBills').textContent = orders.length ? '(' + orders.length + ')' : '';
  $('nBills').textContent = orders.length;
  $('nTotal').textContent = money(orders.reduce((s, o) => s + Number(o.total || 0), 0));
  const box = $('histList');
  if (!orders.length) {
    box.innerHTML = '<div class="empty">ยังไม่มีประวัติ — บิลจะมาแสดงที่นี่หลังเช็คบิล<br>(ถ้าเลือกกรองตามโต๊ะอยู่ ลองเปลี่ยนเป็น "ทุกโต๊ะ")</div>';
    return;
  }
  box.innerHTML = orders.map((o) => {
    const open = openBills.has(o.id);
    const items = (o.items || []);
    const cancelled = items.filter((i) => i.status === 'cancelled').length;
    return `<section class="bill" data-id="${o.id}">
      <div class="bill-head" data-toggle="${o.id}">
        <span class="t">บิล ${billNo(o.bill_no)}</span>
        <span class="b">· โต๊ะ ${esc(o.table_code || '-')}</span>
        <span class="spacer"></span>
        <span class="when">เปิด ${dt(o.opened_at)} · ปิด ${dt(o.closed_at)} · ${o.item_count} จาน${cancelled ? ' · ยกเลิก ' + cancelled : ''}</span>
        <span class="amt">${money(o.total)}</span>
        <span class="caret">${open ? '▲' : '▼'}</span>
      </div>
      ${open ? `<div class="bill-items">${billItemsHtml(o)}</div>
      <div class="bill-foot">
        <button class="btn btn-primary btn-sm" data-print="${o.id}" type="button">🖨 พิมพ์ใบเสร็จซ้ำ</button>
        ${o.table_code ? `<button class="btn btn-sm" data-code="${esc(o.table_code)}" type="button">ดูบิลทั้งหมดของโต๊ะนี้</button>` : ''}
      </div>` : ''}
    </section>`;
  }).join('');

  box.querySelectorAll('[data-toggle]').forEach((el) => el.addEventListener('click', () => {
    const id = Number(el.dataset.toggle);
    if (openBills.has(id)) openBills.delete(id); else openBills.add(id);
    renderBills();
  }));
  box.querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', () => {
    const id = Number(b.dataset.print);
    API.printReceipt({ orderId: id, url_path: '/shop/receipt.html?order=' + id });
    toast('กำลังพิมพ์ใบเสร็จซ้ำของบิล #' + id);
  }));
  box.querySelectorAll('[data-code]').forEach((b) => b.addEventListener('click', () => {
    $('fTable').value = 'code:' + b.dataset.code;
    showTab('bills');
    loadBills().then(() => toast('กรองเฉพาะโต๊ะ ' + b.dataset.code + ' แล้ว')).catch((e) => toast('โหลดไม่สำเร็จ: ' + e.message));
  }));
}

// ---------------------------------------------------------------------------
// แท็บ 2: QR โต๊ะที่ปิดใช้งาน
// ---------------------------------------------------------------------------
function renderRetired() {
  $('cntQr').textContent = retired.length ? '(' + retired.length + ')' : '';
  const box = $('qrList');
  if (!retired.length) {
    box.innerHTML = '<div class="empty">ยังไม่มี QR ที่ปิดใช้งาน</div>';
    return;
  }
  box.innerHTML = retired.map((t) => {
    const img = qrImages.get(t.id);
    return `<section class="qr-card" data-qr="${t.id}">
      ${img ? `<img src="${img}" alt="QR โต๊ะ ${esc(t.code)}">` : '<div class="qr-ph">กำลังโหลดรูป QR…</div>'}
      <div style="flex:1;min-width:0;">
        <div class="t">โต๊ะ ${esc(t.code)}<span class="qr-off">ปิดใช้งานแล้ว</span></div>
        <div class="l">${t.zone_name ? 'โซน ' + esc(t.zone_name) + ' · ' : ''}สร้าง QR ${dt(t.created_at)} · ปิดใช้งาน ${dt(t.retired_at)}</div>
        <div class="l">บิลที่ปิดแล้ว ${t.bill_count} ใบ · ยอดรวม ${money(t.total_sales)}</div>
        <div class="acts">
          <button class="btn btn-sm" data-download="${t.id}" data-code="${esc(t.code)}" type="button">⬇ ดาวน์โหลด QR</button>
          <button class="btn btn-sm" data-code="${esc(t.code)}" type="button">ดูบิลของโต๊ะนี้</button>
        </div>
      </div>
    </section>`;
  }).join('');

  box.querySelectorAll('[data-download]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await API.saveQr({ tableId: Number(b.dataset.download), name: 'QR-โต๊ะ-' + b.dataset.code + '.png' });
      toast('บันทึก QR แล้ว: ' + r.path + ' (กดที่ข้อความนี้เพื่อเปิดโฟลเดอร์)', r.path);
    } catch (e) { toast('ดาวน์โหลดไม่สำเร็จ: ' + e.message); }
    finally { b.disabled = false; }
  }));
  box.querySelectorAll('[data-code]:not([data-download])').forEach((b) => b.addEventListener('click', () => {
    $('fTable').value = 'code:' + b.dataset.code;
    showTab('bills');
    loadBills().then(() => toast('กรองเฉพาะโต๊ะ ' + b.dataset.code + ' แล้ว')).catch((e) => toast('โหลดไม่สำเร็จ: ' + e.message));
  }));
}

/** โหลดรูป QR ของโต๊ะที่ปิดใช้งาน (ทำครั้งเดียวต่อโต๊ะ) */
async function loadQrImages() {
  for (const t of retired) {
    if (qrImages.has(t.id)) continue;
    try {
      const img = await API.qr(t.id);
      qrImages.set(t.id, img.dataUrl);
      const el = document.querySelector('[data-qr="' + t.id + '"]');
      if (el) {
        const ph = el.querySelector('.qr-ph');
        if (ph) {
          const i = document.createElement('img');
          i.src = img.dataUrl;
          i.alt = 'QR โต๊ะ ' + t.code;
          ph.replaceWith(i);
        }
      }
    } catch (e) { /* รูปโหลดไม่ได้ก็ยังดูข้อมูลอื่นได้ */ }
  }
}

// ---------------------------------------------------------------------------
// โหลดข้อมูล
// ---------------------------------------------------------------------------
// ร้านอาจออก QR ให้โต๊ะชื่อเดิมหลายรอบ (ปิดใช้งานแล้วออกใหม่) → รวมทุก QR ของชื่อนั้นไว้ด้วยกัน
let recent = [];                  // ประวัติล่าสุดแบบไม่กรอง (ไว้สร้างตัวกรอง + นับรวม)
const idsByCode = new Map();      // ชื่อโต๊ะ → รหัสโต๊ะทุกอันที่เคยใช้ชื่อนี้
const perTable = new Map();       // tableId → บิลของโต๊ะนั้น (แคชต่อการโหลดหนึ่งรอบ)

function buildCodeMap() {
  idsByCode.clear();
  for (const t of retired) {
    if (!idsByCode.has(t.code)) idsByCode.set(t.code, new Set());
    idsByCode.get(t.code).add(t.id);
  }
  for (const o of recent) {
    if (!o.table_code || !o.table_id) continue;
    if (!idsByCode.has(o.table_code)) idsByCode.set(o.table_code, new Set());
    idsByCode.get(o.table_code).add(o.table_id);
  }
}

function renderTableFilter() {
  const sel = $('fTable');
  const cur = sel.value;
  const codes = [...idsByCode.keys()].sort((a, b) => String(a).localeCompare(String(b), 'th'));
  const retiredCodes = new Set(retired.map((t) => t.code));
  sel.innerHTML = '<option value="">ทุกโต๊ะ</option>' + codes.map((code) => {
    const allRetired = retiredCodes.has(code) && !recent.some((o) => o.table_code === code);
    return `<option value="code:${esc(code)}">โต๊ะ ${esc(code)}${allRetired ? ' (ปิดใช้งาน)' : ''}</option>`;
  }).join('');
  if (cur && sel.querySelector('option[value="' + cur.replace(/"/g, '\\"') + '"]')) sel.value = cur;
  else if (cur) sel.value = '';
}

async function loadTables() {
  retired = await API.retired();
  renderRetired();
  loadQrImages();
}

async function loadBills() {
  const limit = Number($('fLimit').value) || 50;
  const sel = $('fTable').value;
  if (!sel) {
    orders = recent.slice(0, limit);
  } else {
    const code = sel.replace(/^code:/, '');
    const ids = [...(idsByCode.get(code) || [])];
    const parts = await Promise.all(ids.map(async (id) => {
      if (!perTable.has(id)) perTable.set(id, await API.bills({ tableId: id, limit: 200 }));
      return perTable.get(id);
    }));
    orders = parts.flat()
      .sort((a, b) => new Date(b.closed_at || 0) - new Date(a.closed_at || 0))
      .slice(0, limit);
  }
  renderBills();
}

async function loadAll() {
  try {
    recent = await API.bills({ limit: 200 });
    perTable.clear();
    buildCodeMap();
    renderTableFilter();
    await loadBills();
    await loadTables();
  } catch (err) {
    $('histList').innerHTML = '<div class="empty">โหลดประวัติไม่สำเร็จ: ' + esc(err.message) + '</div>';
  }
}

// ---------------------------------------------------------------------------
// ออกรายการ CSV (บันทึกลงโฟลเดอร์ Downloads ของเครื่อง)
// ---------------------------------------------------------------------------
async function exportCsv() {
  const btn = $('btnExport');
  btn.disabled = true;
  try {
    let rows;
    let name;
    if (tab === 'qr') {
      if (!retired.length) { toast('ไม่มีข้อมูลให้ออก'); return; }
      rows = [['โต๊ะ', 'โซน', 'สร้าง QR', 'ปิดใช้งานเมื่อ', 'บิลที่ปิดแล้ว', 'ยอดรวม']];
      for (const t of retired) rows.push([t.code, t.zone_name || '', t.created_at || '', t.retired_at || '', t.bill_count, Number(t.total_sales)]);
      name = 'qpage-qr-history.csv';
    } else {
      if (!orders.length) { toast('ไม่มีข้อมูลให้ออก'); return; }
      rows = [['บิล', 'โต๊ะ', 'เปิด', 'ปิด', 'จำนวนจาน', 'ยอดรวม', 'รายการ']];
      for (const o of orders) {
        const names = (o.items || []).map((i) => i.quantity + 'x ' + i.menu_name + (i.status === 'cancelled' ? '(ยกเลิก)' : '')).join(' | ');
        rows.push([billNo(o.bill_no), o.table_code || '', o.opened_at || '', o.closed_at || '', o.item_count, Number(o.total || 0), names]);
      }
      name = 'qpage-order-history.csv';
    }
    const r = await API.saveCsv({ name, csv: csvRows(rows) });
    toast('บันทึกไฟล์แล้ว: ' + r.path + ' (กดที่ข้อความนี้เพื่อเปิดโฟลเดอร์)', r.path);
  } catch (e) {
    toast('ออกรายการไม่สำเร็จ: ' + e.message);
  } finally { btn.disabled = false; }
}

// ---------------------------------------------------------------------------
// ตัวควบคุม
// ---------------------------------------------------------------------------
$('fTable').addEventListener('change', () => loadBills().catch((e) => toast('โหลดไม่สำเร็จ: ' + e.message)));
$('fLimit').addEventListener('change', () => loadBills().catch((e) => toast('โหลดไม่สำเร็จ: ' + e.message)));
$('btnReload').addEventListener('click', () => loadAll().then(() => toast('อัปเดตแล้ว')));
$('btnExport').addEventListener('click', exportCsv);

API.onLive((state) => {
  const live = $('live');
  live.className = 'live ' + state;
  $('liveText').textContent = state === 'open' ? 'อัปเดตสด' : state === 'error' ? 'ขาดการเชื่อมต่อ' : 'กำลังเชื่อมต่อ…';
});
// เช็คบิล/ปิดใช้งาน QR ระหว่างเปิดหน้านี้อยู่ → ประวัติอัปเดตเอง
API.onEvent((evt) => {
  if (['checkout', 'bill_changed', 'tables_changed'].includes(evt.type)) loadAll();
});

showTab('bills');
loadAll();
setInterval(loadAll, 60000);   // สำรอง เผื่อสายเรียลไทม์หลุด

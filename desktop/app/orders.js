/**
 * orders.js — หน้าจอ "สั่งอาหาร" ของโปรแกรม (ผังโต๊ะ + บิล + เพิ่มอาหาร + เช็คบิล)
 *
 * เหมือนหน้าจอครัว: หน้าจอไม่เรียก API เอง (ไฟล์ในเครื่อง) — ส่งคำสั่งผ่าน IPC ให้ main เรียกให้
 */
'use strict';

const API = window.qpageOrders;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '฿' + Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const billNo = (n) => (n ? '#' + String(n).padStart(4, '0') : '—');
const plates = (items) => (items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0);

let tables = [];
let zones = [];
let names = [];               // รายชื่อโต๊ะ (แหล่งหลักของผัง — รวมชื่อที่ยังไม่ออก QR)
let openBills = [];
let catalog = { menus: [], categories: [], optionGroups: [], optionItems: [], menuGroups: [] };
let zoneFilter = '';
let currentTable = null;      // โต๊ะที่เปิดแผงบิลอยู่
let addState = { menuId: 0, qty: 1, tableId: null };
let formMode = null;          // 'table' | 'zone'
let deleting = false;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2800);
}
const optsText = (json) => {
  if (!json) return '';
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.map((o) => (typeof o === 'string' ? o : (o && o.name) || '')).filter(Boolean).join(', ') : ''; } catch (e) { return ''; }
};

// ---------------------------------------------------------------------------
// ผังโต๊ะ
// ---------------------------------------------------------------------------
function renderPlan() {
  // ผังสร้างจาก "รายชื่อโต๊ะ" (รวมชื่อที่ยังไม่ออก QR) แล้วผูกกับข้อมูล QR/บิล
  const tablesById = {};
  for (const t of tables) tablesById[t.id] = t;
  const zoneKeyOf = (n) => (n.zone_id ? String(n.zone_id) : '');

  // zoneFilter: '' = ทั้งหมด · '__none__' = ไม่ระบุโซน · อื่น ๆ = รหัสโซน
  const NO_ZONE = '__none__';
  const visible = zoneFilter === ''
    ? names
    : names.filter((n) => (zoneFilter === NO_ZONE ? !n.zone_id : String(n.zone_id || '') === zoneFilter));
  $('nTables').textContent = visible.length;
  // นับ "มีบิล" เฉพาะบิลที่มีรายการแล้ว (หลังเช็คบิล ระบบเปิดบิลว่างใหม่ให้โต๊ะเดิม → ไม่นับเป็นมีบิล)
  const billOf = (n) => (n.has_qr && tablesById[n.table_id] ? tablesById[n.table_id].open_order : null);
  const withBill = visible.filter((n) => {
    const o = billOf(n);
    return !!(o && (o.items || []).length);
  });
  $('nBills').textContent = withBill.length;
  $('nOpenTotal').textContent = money(withBill.reduce((s, n) => s + Number(billOf(n).total || 0), 0));

  // ปุ่มกรองตามโซน (ใช้โซนจากรายการโซนจริง + "ไม่ระบุโซน" ถ้ามี)
  const chips = [`<button class="chip ${zoneFilter === '' ? 'active' : ''}" data-zone="" type="button">ทั้งหมด <span class="c">(${names.length})</span></button>`];
  for (const z of zones) {
    const n = names.filter((x) => String(x.zone_id || '') === String(z.id)).length;
    chips.push(`<button class="chip ${zoneFilter === String(z.id) ? 'active' : ''}" data-zone="${z.id}" type="button">${esc(z.name)} <span class="c">(${n})</span></button>`);
  }
  const noZone = names.filter((x) => !x.zone_id).length;
  if (noZone) chips.push(`<button class="chip ${zoneFilter === NO_ZONE ? 'active' : ''}" data-zone="${NO_ZONE}" type="button">ไม่ระบุโซน <span class="c">(${noZone})</span></button>`);
  $('zoneChips').innerHTML = chips.join('');
  $('zoneChips').querySelectorAll('[data-zone]').forEach((b) => b.addEventListener('click', () => { zoneFilter = b.dataset.zone; renderPlan(); }));

  const box = $('plan');
  if (!visible.length) {
    box.innerHTML = '<div class="empty-state">ยังไม่มีโต๊ะ — กด "＋ เพิ่มโต๊ะใหม่" เพื่อเริ่ม</div>';
    return;
  }
  // จัดกลุ่มตามโซน (เรียงตามรายการโซน แล้วปิดท้ายด้วย "ไม่ระบุโซน")
  const grouped = new Map();
  for (const z of zones) grouped.set(String(z.id), []);
  grouped.set('', []);
  for (const n of visible) {
    const key = grouped.has(zoneKeyOf(n)) ? zoneKeyOf(n) : '';
    grouped.get(key).push(n);
  }
  let html = '';
  for (const [key, items] of grouped) {
    if (!items.length) continue;
    const zone = zones.find((z) => String(z.id) === key);
    html += `<div class="zone-title">${zone ? esc(zone.name) : 'ไม่ระบุโซน'} <span class="line"></span></div>`;
    html += '<div class="grid">' + items.map((n) => {
      const tb = n.has_qr ? tablesById[n.table_id] : null;
      if (!tb) {
        // ตั้งชื่อ/จัดโซนไว้แล้วแต่ยังไม่ออก QR → กดเพื่อออก QR ให้โต๊ะนี้
        const zone = zones.find((z) => String(z.id) === key);
        return `<button class="tile free" data-newqr="${n.id}" data-name="${esc(n.name)}" data-zone-id="${zone ? zone.id : ''}" type="button">
          <span class="dot"></span>
          <span class="code">${esc(n.name)}</span>
          <span class="empty">ยังไม่ออก QR · กดเพื่อออก QR</span>
        </button>`;
      }
      const o = tb.open_order;
      const withItems = !!(o && (o.items || []).length);
      return `<button class="tile ${withItems ? 'has-bill' : ''}" data-table="${tb.id}" type="button">
        <span class="dot"></span>
        <span class="code">${esc(n.name)}</span>
        ${withItems ? `<span class="line1">บิล ${billNo(o.bill_no)} · ${plates(o.items)} จาน</span>
               <span class="line2">เปิด ${o.opened_at ? new Date(o.opened_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : ''}</span>
               <span class="amt">${money(o.total)}</span>`
            : '<span class="empty">ว่าง — พร้อมรับลูกค้า</span>'}
      </button>`;
    }).join('') + '</div>';
  }
  box.innerHTML = html;
  box.querySelectorAll('[data-table]').forEach((b) => b.addEventListener('click', () => openDrawer(Number(b.dataset.table))));
  // โต๊ะที่ยังไม่ออก QR → กดแล้วออก QR ให้ทันที
  box.querySelectorAll('[data-newqr]').forEach((b) => b.addEventListener('click', () => issueQr(b.dataset.name, b.dataset.zoneId, b)));
}

/** ออก QR ให้ชื่อโต๊ะที่ยังไม่มี (สร้างโต๊ะ+โทเคนจากชื่อนั้น) */
async function issueQr(name, zoneId, btn) {
  if (btn) btn.disabled = true;
  try {
    await API.createQrForName(name, zoneId);
    toast('ออก QR ให้โต๊ะ "' + name + '" แล้ว — สแกนได้เลย');
    await loadAll();
  } catch (err) {
    toast('ออก QR ไม่สำเร็จ: ' + err.message);
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// แผงบิลด้านขวา
// ---------------------------------------------------------------------------
function openDrawer(tableId) {
  currentTable = tables.find((t) => t.id === tableId) || { id: tableId, code: '?' };
  renderDrawer();
  $('drawer').classList.add('open');
}
function closeDrawer() { $('drawer').classList.remove('open'); currentTable = null; }

function renderDrawer() {
  if (!currentTable) return;
  // ดึงบิลล่าสุดจากรายการที่โหลดไว้ (กันข้อมูลเก่าหลังเพิ่ม/ลบ)
  const t = tables.find((x) => x.id === currentTable.id) || currentTable;
  currentTable = t;
  const o = t.open_order;
  $('dTitle').textContent = 'โต๊ะ ' + (t.code || '—');
  $('dSub').textContent = o ? ('บิล ' + billNo(o.bill_no) + ' · ' + plates(o.items) + ' จาน') : 'ยังไม่มีบิลที่เปิดอยู่';
  const body = $('dBody');
  if (!o || !o.items || !o.items.length) {
    body.innerHTML = '<div class="empty-state" style="padding:28px 16px;">ยังไม่มีรายการในบิล<br>กด "＋ เพิ่มอาหาร" เพื่อเริ่มสั่ง</div>';
  } else {
    body.innerHTML = o.items.map((i) => {
      const st = i.status || 'pending';
      const stLabel = { pending: 'รอทำ', cooking: 'กำลังทำ', done: 'เสร็จ', cancelled: 'ยกเลิก' }[st] || st;
      return `<div class="bill-row">
        <span class="qty">${Number(i.quantity) || 0}×</span>
        <span class="info">
          <span class="name">${esc(i.menu_name)}</span>
          ${optsText(i.options_json) ? `<div class="opts">${esc(optsText(i.options_json))}</div>` : ''}
          <span class="st ${esc(st)}">${esc(stLabel)}</span>
        </span>
        <span class="price">${money(i.line_total)}</span>
        ${st === 'cancelled' ? '' : `<button class="del" data-del="${i.id}" data-name="${esc(i.menu_name)}" type="button">ลบ</button>`}
      </div>`;
    }).join('');
    body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => delItem(Number(b.dataset.del), b.dataset.name, b)));
  }
  $('dTotal').textContent = money(o ? o.total : 0);
  const uncleared = o && (o.items || []).some((i) => i.status === 'pending' || i.status === 'cooking');
  $('dCheckout').disabled = !o || !(o.items || []).length;
  $('dAdd').disabled = !o;
  $('dHint').textContent = !o
    ? 'โต๊ะนี้ยังไม่มีบิล — เพิ่มอาหารไม่ได้จนกว่าจะมีบิล (ลูกค้าสแกน QR หรือกดเพิ่มโต๊ะ/บิลจากหน้าเว็บ)'
    : uncleared
      ? 'ยังมีรายการที่ครัว/แคชเชียร์ยังไม่เคลียร์ — เช็คบิลได้เมื่อเคลียร์ครบแล้ว'
      : 'พร้อมเช็คบิล — ระบบจะพิมพ์ใบเสร็จให้อัตโนมัติ';
}

async function delItem(id, name, btn) {
  if (deleting) return;
  deleting = true;
  try {
    await API.deleteItem(id);
    toast('ลบ ' + name + ' แล้ว');
    await loadAll();
    renderDrawer();
  } catch (err) { toast('ลบไม่สำเร็จ: ' + err.message); }
  finally { deleting = false; if (btn) btn.disabled = false; }
}

// ---------------------------------------------------------------------------
// เพิ่มอาหาร
// ---------------------------------------------------------------------------
function openAdd() {
  if (!currentTable || !currentTable.open_order) { toast('โต๊ะนี้ยังไม่มีบิล'); return; }
  addState = { menuId: 0, qty: 1, tableId: currentTable.id };
  $('addSub').textContent = 'โต๊ะ ' + currentTable.code + ' · บิล ' + billNo(currentTable.open_order.bill_no);
  $('addSearch').value = '';
  $('addErr').textContent = '';
  $('qtyValue').textContent = '1';
  renderMenuList();
  $('addGroups').innerHTML = '';
  $('addOverlay').classList.add('show');
  setTimeout(() => $('addSearch').focus(), 60);
}
function closeAdd() { $('addOverlay').classList.remove('show'); }

function renderMenuList() {
  const q = $('addSearch').value.trim().toLowerCase();
  const catName = {};
  for (const c of catalog.categories) catName[c.id] = c.name;
  const list = catalog.menus
    .filter((m) => Number(m.available) === 1)
    .filter((m) => !q || String(m.name).toLowerCase().includes(q))
    .slice(0, 200);
  const box = $('addMenuList');
  if (!list.length) { box.innerHTML = '<div class="empty-state" style="padding:20px;">ไม่พบเมนูที่ตรงกับคำค้น</div>'; return; }
  box.innerHTML = list.map((m) => `<div class="menu-item ${addState.menuId === m.id ? 'sel' : ''}" data-menu="${m.id}">
    <span class="nm">${esc(m.name)}${catName[m.category_id] ? ` <span class="hint" style="margin:0;">· ${esc(catName[m.category_id])}</span>` : ''}</span>
    <span class="pr">${money(m.price)}</span>
  </div>`).join('');
  box.querySelectorAll('[data-menu]').forEach((el) => el.addEventListener('click', () => {
    addState.menuId = Number(el.dataset.menu);
    renderMenuList();
    renderOptionGroups();
  }));
}

/** กลุ่มตัวเลือกของเมนูที่เลือก (บังคับ/หลายอย่าง + ค่าเริ่มต้นที่ร้านมาร์ค ⭐) */
function renderOptionGroups() {
  const menuId = addState.menuId;
  const box = $('addGroups');
  if (!menuId) { box.innerHTML = ''; return; }
  const groupIds = catalog.menuGroups.filter((g) => Number(g.menu_id) === menuId).map((g) => Number(g.group_id));
  const groups = catalog.optionGroups.filter((g) => groupIds.includes(Number(g.id)));
  if (!groups.length) {
    box.innerHTML = '<div class="hint" style="margin-bottom:12px;">เมนูนี้ไม่มีตัวเลือกให้เลือก</div>';
    return;
  }
  box.innerHTML = groups.map((g) => {
    const items = catalog.optionItems.filter((i) => Number(i.group_id) === Number(g.id));
    const multi = Number(g.multi) === 1;
    return `<div class="opt-group" data-group="${g.id}">
      <div class="gh">${esc(g.name)}${Number(g.required) === 1 ? '<span class="req">บังคับ</span>' : ''}
        <span class="hint" style="margin:0;font-weight:600;">${multi ? 'เลือกได้หลายอย่าง' : 'เลือก 1 อย่าง'}</span></div>
      ${items.map((i) => {
        const checked = Number(i.is_default) === 1;
        return `<label class="opt-item">
          <input type="${multi ? 'checkbox' : 'radio'}" name="g${g.id}" value="${i.id}" ${checked ? 'checked' : ''}>
          <span>${esc(i.name)}</span>
          ${Number(i.price_delta) ? `<span class="extra">+${money(i.price_delta)}</span>` : ''}
        </label>`;
      }).join('')}
    </div>`;
  }).join('');
}

async function confirmAdd() {
  const btn = $('addConfirm');
  const err = $('addErr');
  err.textContent = '';
  const menuId = addState.menuId;
  if (!menuId) { err.textContent = 'กรุณาเลือกเมนูก่อน'; return; }
  // ตรวจกลุ่มบังคับเลือกก่อนส่ง (เซิร์ฟเวอร์ตรวจซ้ำอีกชั้น)
  for (const g of $('addGroups').querySelectorAll('[data-group]')) {
    const gid = Number(g.dataset.group);
    const meta = catalog.optionGroups.find((x) => Number(x.id) === gid) || {};
    if (Number(meta.required) === 1 && !g.querySelector('input:checked')) {
      err.textContent = 'กรุณาเลือก "' + (meta.name || 'ตัวเลือก') + '" (บังคับ)';
      return;
    }
  }
  const optionItemIds = [...$('addGroups').querySelectorAll('input:checked')].map((el) => Number(el.value));
  btn.disabled = true;
  try {
    await API.addItems(addState.tableId, [{ menuId, quantity: addState.qty, optionItemIds }]);
    toast('เพิ่มอาหารเข้าบิลแล้ว');
    closeAdd();
    await loadAll();
    renderDrawer();
  } catch (e) { err.textContent = e.message; }
  finally { btn.disabled = false; }
}

// ---------------------------------------------------------------------------
// เช็คบิล + พิมพ์ใบเสร็จ
// ---------------------------------------------------------------------------
function openCheckout() {
  const t = tables.find((x) => x.id === (currentTable && currentTable.id));
  if (!t || !t.open_order) return;
  $('coSub').textContent = 'โต๊ะ ' + t.code + ' · บิล ' + billNo(t.open_order.bill_no) + ' · ' + plates(t.open_order.items) + ' จาน';
  $('coTotal').textContent = money(t.open_order.total);
  const uncleared = (t.open_order.items || []).filter((i) => i.status === 'pending' || i.status === 'cooking');
  $('coHint').textContent = uncleared.length
    ? '⚠ ยังมี ' + plates(uncleared) + ' จานที่ครัว/แคชเชียร์ยังไม่เคลียร์ — กดได้ แต่ถ้าระบบไม่ให้เช็คบิล ให้เคลียร์รายการก่อน'
    : 'หลังยืนยัน ระบบจะปิดบิลและพิมพ์ใบเสร็จทันที';
  $('coOverlay').classList.add('show');
}
function closeCheckout() { $('coOverlay').classList.remove('show'); }

async function doCheckout() {
  const t = tables.find((x) => x.id === (currentTable && currentTable.id));
  if (!t) return;
  const btn = $('coOk');
  btn.disabled = true;
  try {
    const r = await API.checkout(t.id);
    closeCheckout();
    closeDrawer();
    toast('เช็คบิลโต๊ะ ' + t.code + ' แล้ว' + (r.qrDeleted ? ' · ปิดใช้งาน QR โต๊ะนี้' : ''));
    if (r.closed) API.printReceipt({ orderId: r.closed.order_id, url_path: '/shop/receipt.html?order=' + r.closed.order_id });
    await loadAll();
  } catch (err) {
    toast('เช็คบิลไม่สำเร็จ: ' + err.message);
  } finally { btn.disabled = false; }
}

// ---------------------------------------------------------------------------
// เพิ่มโต๊ะ / เพิ่มโซน
// ---------------------------------------------------------------------------
function openForm(mode) {
  formMode = mode;
  $('formErr').textContent = '';
  $('formCode').value = '';
  const zoneOpts = ['<option value="">ไม่ระบุโซน</option>'].concat(zones.map((z) => `<option value="${z.id}">${esc(z.name)}</option>`));
  $('formZone').innerHTML = zoneOpts.join('');
  if (mode === 'table') {
    $('formTitle').textContent = 'เพิ่มโต๊ะใหม่';
    $('formSub').textContent = 'ใส่ชื่อ/เลขโต๊ะ แล้วเลือกโซน (ถ้ามี) — ระบบจะออก QR ให้ใช้งานได้ทันที';
    $('formCodeField').style.display = '';
    $('formZoneField').style.display = '';
  } else {
    $('formTitle').textContent = 'เพิ่มโซน';
    $('formSub').textContent = 'เช่น ในร้าน, ริมระเบียง, ชั้น 2 — ใช้จัดกลุ่มโต๊ะในผัง';
    $('formCodeField').style.display = 'none';
    $('formZoneField').style.display = 'none';
  }
  $('formOverlay').classList.add('show');
  if (mode === 'zone') setTimeout(() => $('formCode').focus(), 60);
}
function closeForm() { $('formOverlay').classList.remove('show'); formMode = null; }

async function submitForm() {
  const err = $('formErr');
  err.textContent = '';
  const value = $('formCode').value.trim();
  if (!value) { err.textContent = formMode === 'zone' ? 'กรุณากรอกชื่อโซน' : 'กรุณากรอกชื่อ/เลขโต๊ะ'; return; }
  const btn = $('formOk');
  btn.disabled = true;
  try {
    if (formMode === 'zone') {
      await API.addZone(value);
      toast('เพิ่มโซน "' + value + '" แล้ว');
    } else {
      await API.addTable(value, $('formZone').value);
      toast('เพิ่มโต๊ะ "' + value + '" แล้ว');
    }
    closeForm();
    await loadAll();
  } catch (e) { err.textContent = e.message; }
  finally { btn.disabled = false; }
}

// ---------------------------------------------------------------------------
// โหลดข้อมูล + อัปเดตสด
// ---------------------------------------------------------------------------
async function loadAll() {
  try {
    const [tn, t, bills, cat] = await Promise.all([
      API.tableNames(),                                        // รายชื่อโต๊ะ+โซน = แหล่งหลักของผัง
      API.tables(),                                            // โต๊ะที่ออก QR แล้ว (มีข้อมูลบิล)
      API.openBills(),                                         // บิลที่เปิดอยู่ (มีรายการอาหาร)
      catalog.menus.length ? Promise.resolve(null) : API.catalog(),
    ]);
    names = tn.names || [];
    zones = tn.zones || [];
    tables = t.tables || [];
    openBills = bills || [];
    // ⚠️ /api/shop/tables ส่งบิลมาแบบ "ไม่มีรายการอาหาร" — ต้องใช้ข้อมูลจาก /orders/open (ที่มี items) ทับเสมอ
    const byTable = {};
    for (const o of openBills) if (o.table_id) byTable[o.table_id] = o;
    for (const tb of tables) if (byTable[tb.id]) tb.open_order = byTable[tb.id];
    if (cat) catalog = cat;
    renderPlan();
    if (currentTable) renderDrawer();
  } catch (err) {
    $('plan').innerHTML = '<div class="empty-state">โหลดข้อมูลไม่สำเร็จ: ' + esc(err.message) + '</div>';
  }
}

API.onLive((state) => {
  const live = $('live');
  live.className = 'live ' + state;
  $('liveText').textContent = state === 'open' ? 'อัปเดตสด' : state === 'error' ? 'ขาดการเชื่อมต่อ' : 'กำลังเชื่อมต่อ…';
});
API.onEvent((evt) => {
  if (['order_new', 'item_status', 'bill_changed', 'checkout', 'tables_changed'].includes(evt.type)) loadAll();
});

$('btnReload').addEventListener('click', () => loadAll().then(() => toast('อัปเดตแล้ว')));
$('btnAddTable').addEventListener('click', () => openForm('table'));
$('btnAddZone').addEventListener('click', () => openForm('zone'));
$('dClose').addEventListener('click', closeDrawer);
$('dAdd').addEventListener('click', openAdd);
$('dCheckout').addEventListener('click', openCheckout);
$('addClose').addEventListener('click', closeAdd);
$('addConfirm').addEventListener('click', confirmAdd);
$('addSearch').addEventListener('input', renderMenuList);
$('qtyMinus').addEventListener('click', () => { addState.qty = Math.max(1, addState.qty - 1); $('qtyValue').textContent = addState.qty; });
$('qtyPlus').addEventListener('click', () => { addState.qty = Math.min(99, addState.qty + 1); $('qtyValue').textContent = addState.qty; });
$('formClose').addEventListener('click', closeForm);
$('formOk').addEventListener('click', submitForm);
$('coCancel').addEventListener('click', closeCheckout);
$('coOk').addEventListener('click', doCheckout);
document.querySelectorAll('.overlay').forEach((o) => o.addEventListener('click', (e) => { if (e.target === o) o.classList.remove('show'); }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeAdd(); closeForm(); closeCheckout(); closeDrawer(); } });

loadAll();
setInterval(loadAll, 30000);   // สำรอง เผื่อสายเรียบไทม์หลุด

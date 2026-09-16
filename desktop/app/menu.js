/**
 * menu.js — หน้าจอ "จัดการเมนู" ของ "โปรแกรม" (ไม่ใช่หน้าเว็บ)
 * หมวดหมู่ (+ เส้นทางครัว/แคชเชียร์) · เมนูในแต่ละหมวด · กลุ่มตัวเลือกและตัวเลือกในกลุ่ม
 */
'use strict';

const API = window.qpageShop;
const K = window.MenuKit;
const $ = (id) => document.getElementById(id);

let categories = [];
let menus = [];
let optionGroups = [];
let optionItems = [];
let menuGroups = [];
let catFilter = '';              // '' = ทุกหมวด, 'c:<id>', 'c:none'

const imgCache = new Map();
const itemText = (json) => {
  if (!json) return '';
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.join(', ') : ''; } catch (e) { return ''; }
};

// ---------------------------------------------------------------------------
// หมวดหมู่
// ---------------------------------------------------------------------------
function renderCats() {
  const mains = categories.filter((c) => !c.parent_id);
  const rows = [];
  const catRow = (c, isSub) => {
    const n = menus.filter((m) => Number(m.category_id) === Number(c.id)).length;
    const station = c.station === 'cashier' ? 'cashier' : 'kitchen';
    return `<div class="row" style="${isSub ? 'padding-left:30px;' : ''}">
      <div class="info">
        <div class="name">${isSub ? '↳ ' : ''}${K.esc(c.name)}</div>
        <div class="sub">เมนูในหมวดนี้ ${n} รายการ</div>
      </div>
      <select class="inp" data-station="${c.id}" style="max-width:150px;">
        <option value="kitchen"${station === 'kitchen' ? ' selected' : ''}>🍳 ครัว</option>
        <option value="cashier"${station === 'cashier' ? ' selected' : ''}>🧾 แคชเชียร์</option>
      </select>
      <div class="acts">
        <button class="btn btn-sm" data-rencat="${c.id}" data-name="${K.esc(c.name)}" type="button">เปลี่ยนชื่อ</button>
        <button class="btn btn-sm btn-danger" data-delcat="${c.id}" data-name="${K.esc(c.name)}" type="button">ลบ</button>
      </div>
    </div>`;
  };
  for (const m of mains) {
    rows.push(catRow(m, false));
    for (const s of categories.filter((c) => Number(c.parent_id) === Number(m.id))) rows.push(catRow(s, true));
  }
  if (!rows.length) rows.push('<div class="empty" style="margin:0;">ยังไม่มีหมวดหมู่ — เพิ่มด้านล่างได้เลย</div>');
  $('catList').innerHTML = rows.join('');

  $('catList').querySelectorAll('[data-station]').forEach((sel) => sel.addEventListener('change', async () => {
    const id = Number(sel.dataset.station);
    sel.disabled = true;
    try {
      await API.updateCategory(id, { station: sel.value });
      const c = categories.find((x) => Number(x.id) === id);
      if (c) c.station = sel.value;
      K.toast(sel.value === 'cashier' ? 'ย้ายหมวดนี้ไปแคชเชียร์แล้ว' : 'ย้ายหมวดนี้ไปครัวแล้ว');
    } catch (err) { K.toast('บันทึกไม่สำเร็จ: ' + err.message); renderCats(); }
    finally { sel.disabled = false; }
  }));
  $('catList').querySelectorAll('[data-rencat]').forEach((b) => b.addEventListener('click', async () => {
    const v = await K.askText('เปลี่ยนชื่อหมวดหมู่', b.dataset.name, 'ชื่อหมวดใหม่', 'text');
    if (v == null || !v) return;
    try {
      await API.updateCategory(Number(b.dataset.rencat), { name: v });
      K.toast('เปลี่ยนชื่อหมวดแล้ว');
      await load();
    } catch (err) { K.toast('เปลี่ยนชื่อไม่สำเร็จ: ' + err.message); }
  }));
  $('catList').querySelectorAll('[data-delcat]').forEach((b) => b.addEventListener('click', async () => {
    const okDel = await K.confirmAsk('ลบหมวดหมู่', 'ลบหมวด "' + b.dataset.name + '" ? เมนูในหมวดนี้จะกลายเป็น "ไม่ระบุหมวด" (ไม่ถูกลบ)', 'ลบหมวดนี้');
    if (!okDel) return;
    try {
      await API.deleteCategory(Number(b.dataset.delcat));
      K.toast('ลบหมวดหมู่แล้ว');
      await load();
    } catch (err) { K.toast('ลบไม่สำเร็จ: ' + err.message); }
  }));

  // ตัวเลือก "อยู่ใต้หมวด"
  const mains2 = categories.filter((c) => !c.parent_id);
  $('newCatParent').innerHTML = '<option value="">— เป็นหมวดหลัก —</option>' + mains2.map((m) => `<option value="${m.id}">อยู่ใต้: ${K.esc(m.name)}</option>`).join('');
}

$('btnAddCat').addEventListener('click', async () => {
  const name = $('newCatName').value.trim();
  if (!name) { $('catErr').textContent = 'กรุณากรอกชื่อหมวดหมู่'; return; }
  $('catErr').textContent = '';
  try {
    await API.addCategory({ name, parentId: $('newCatParent').value || null, station: $('newCatStation').value });
    $('newCatName').value = '';
    K.toast('เพิ่มหมวดหมู่แล้ว');
    await load();
  } catch (err) { $('catErr').textContent = err.message; }
});

// ---------------------------------------------------------------------------
// เมนูในหมวด
// ---------------------------------------------------------------------------
function visibleMenus() {
  if (!catFilter) return menus;
  if (catFilter === 'c:none') return menus.filter((m) => !m.category_id);
  const id = Number(catFilter.slice(2));
  return menus.filter((m) => Number(m.category_id) === id);
}

function renderMenuChips() {
  const chips = [`<button class="chip ${catFilter === '' ? 'active' : ''}" data-cat="" type="button">ทุกหมวด <span class="c">(${menus.length})</span></button>`];
  for (const c of categories) {
    const n = menus.filter((m) => Number(m.category_id) === Number(c.id)).length;
    if (!n && c.parent_id) continue;
    chips.push(`<button class="chip ${catFilter === 'c:' + c.id ? 'active' : ''}" data-cat="c:${c.id}" type="button">${c.parent_id ? '↳ ' : ''}${K.esc(c.name)} <span class="c">(${n})</span></button>`);
  }
  const none = menus.filter((m) => !m.category_id).length;
  if (none) chips.push(`<button class="chip ${catFilter === 'c:none' ? 'active' : ''}" data-cat="c:none" type="button">ไม่ระบุหมวด <span class="c">(${none})</span></button>`);
  $('menuChips').innerHTML = chips.join('');
  $('menuChips').querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => { catFilter = b.dataset.cat; renderMenus(); }));
}

async function renderMenus() {
  renderMenuChips();
  const list = visibleMenus();
  const box = $('menuList');
  if (!list.length) {
    box.innerHTML = '<div class="empty" style="margin:0;">ไม่มีเมนูในหมวดนี้ — กด "＋ เพิ่มเมนู" เพื่อเพิ่ม</div>';
    return;
  }
  box.innerHTML = list.map((m) => {
    const on = Number(m.available) === 1;
    const grp = menuGroups.filter((g) => Number(g.menu_id) === Number(m.id))
      .map((g) => (optionGroups.find((x) => Number(x.id) === Number(g.group_id)) || {}).name)
      .filter(Boolean);
    return `<section class="card" style="padding:12px 14px;flex-direction:row;align-items:center;gap:12px;flex-wrap:wrap;">
      <img class="thumb" data-thumb="${m.id}" src="${K.EMPTY_IMG}" alt="">
      <div style="flex:1;min-width:170px;">
        <div class="name">${K.esc(m.name)}</div>
        <div class="sub">${K.esc(K.categoryPath(categories, m.category_id))}${grp.length ? ' · ตัวเลือก: ' + K.esc(grp.join(', ')) : ''}</div>
      </div>
      <span class="price">${K.money(m.price)}</span>
      <span class="badge ${on ? 'ok' : 'wait'}">${on ? 'พร้อมขาย' : 'ของหมด'}</span>
      <div class="acts">
        <button class="btn btn-sm" data-edit="${m.id}" type="button">แก้ไข</button>
        <button class="btn btn-sm btn-danger" data-del="${m.id}" data-name="${K.esc(m.name)}" type="button">ลบ</button>
      </div>
    </section>`;
  }).join('');

  list.forEach(async (m) => {
    const url = m.image_url || '';
    if (!url) return;
    let dataUrl = imgCache.get(url);
    if (!dataUrl) {
      try { dataUrl = await API.imageData(url); if (dataUrl) imgCache.set(url, dataUrl); } catch (e) { return; }
    }
    const el = box.querySelector('[data-thumb="' + m.id + '"]');
    if (el && dataUrl) el.src = dataUrl;
  });

  box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const m = menus.find((x) => Number(x.id) === Number(b.dataset.edit));
    if (m) K.openMenuEditor({ menu: m, categories, allGroups: optionGroups, menuGroups, withGroups: true, onSaved: load });
  }));
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const okDel = await K.confirmAsk('ลบเมนู', 'ต้องการลบเมนู "' + b.dataset.name + '" ใช่ไหม? รายการที่เคยสั่งไปแล้วยังอยู่ในประวัติ', 'ลบเมนูนี้');
    if (!okDel) return;
    try { await API.deleteMenu(Number(b.dataset.del)); K.toast('ลบเมนูแล้ว'); await load(); }
    catch (err) { K.toast('ลบไม่สำเร็จ: ' + err.message); }
  }));
}

// ---------------------------------------------------------------------------
// กลุ่มตัวเลือก + ตัวเลือกในกลุ่ม
// ---------------------------------------------------------------------------
function renderGroups() {
  const box = $('groupList');
  if (!optionGroups.length) {
    box.innerHTML = '<div class="empty" style="margin:0;">ยังไม่มีกลุ่มตัวเลือก — สร้างด้านล่างได้เลย (เช่น ระดับความเผ็ด · เพิ่มไข่ · ระดับความหวาน)</div>';
    return;
  }
  box.innerHTML = optionGroups.map((g) => {
    const items = optionItems.filter((i) => Number(i.group_id) === Number(g.id));
    const usedBy = menuGroups.filter((mg) => Number(mg.group_id) === Number(g.id)).length;
    return `<section class="card" style="padding:12px 14px;gap:8px;">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <b style="font-size:15px;">${K.esc(g.name)}</b>
        ${Number(g.required) === 1 ? '<span class="badge wait">บังคับเลือก</span>' : '<span class="badge">ไม่บังคับ</span>'}
        ${Number(g.multi) === 1 ? '<span class="badge cook">เลือกได้หลายอย่าง</span>' : '<span class="badge cook">เลือก 1 อย่าง</span>'}
        <span class="hint" style="margin:0;">ใช้กับ ${usedBy} เมนู</span>
        <span class="spacer" style="flex:1;"></span>
        <button class="btn btn-sm" data-rengrp="${g.id}" data-name="${K.esc(g.name)}" data-req="${Number(g.required) === 1 ? 1 : 0}" data-multi="${Number(g.multi) === 1 ? 1 : 0}" type="button">แก้ไขกลุ่ม</button>
        <button class="btn btn-sm btn-danger" data-delgrp="${g.id}" data-name="${K.esc(g.name)}" type="button">ลบกลุ่ม</button>
      </div>
      <div style="display:flex;flex-direction:column;">
        ${items.length ? items.map((i) => `<div class="row" style="padding:8px 2px;">
          <div class="info">
            <div class="name" style="font-size:14px;">${K.esc(i.name)}${Number(i.is_default) === 1 ? ' <span class="badge ok">⭐ ค่าเริ่มต้น</span>' : ''}</div>
            <div class="sub">${Number(i.price_delta) ? 'บวกเพิ่ม ' + K.money(i.price_delta) : 'ไม่บวกเพิ่ม'}</div>
          </div>
          <label class="sw" title="ตั้งเป็นค่าเริ่มต้น (ติ๊กให้อัตโนมัติเมื่อลูกค้าเลือกเมนูที่ใช้กลุ่มนี้)">
            <input type="checkbox" data-defitem="${i.id}" ${Number(i.is_default) === 1 ? 'checked' : ''}>
            <span class="track"></span>
          </label>
          <button class="btn btn-sm" data-renitem="${i.id}" data-name="${K.esc(i.name)}" data-price="${Number(i.price_delta) || 0}" type="button">แก้ไข</button>
          <button class="btn btn-sm btn-danger" data-delitem="${i.id}" data-name="${K.esc(i.name)}" type="button">ลบ</button>
        </div>`).join('') : '<div class="hint" style="padding:6px 2px;">ยังไม่มีตัวเลือกในกลุ่มนี้</div>'}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <input class="inp" data-itemname="${g.id}" placeholder="ชื่อตัวเลือก เช่น เผ็ดมาก" style="flex:1;min-width:150px;">
        <input class="inp mono" data-itemprice="${g.id}" type="number" step="0.01" placeholder="+ราคา" style="width:110px;">
        <label class="sw" style="gap:6px;"><input type="checkbox" data-itemdef="${g.id}"><span class="track"></span><span class="hint" style="margin:0;">ค่าเริ่มต้น</span></label>
        <button class="btn btn-sm btn-primary" data-additem="${g.id}" type="button">＋ เพิ่มตัวเลือก</button>
      </div>
    </section>`;
  }).join('');

  // เพิ่มตัวเลือก
  box.querySelectorAll('[data-additem]').forEach((b) => b.addEventListener('click', async () => {
    const gid = Number(b.dataset.additem);
    const nameEl = box.querySelector('[data-itemname="' + gid + '"]');
    const priceEl = box.querySelector('[data-itemprice="' + gid + '"]');
    const defEl = box.querySelector('[data-itemdef="' + gid + '"]');
    const name = nameEl.value.trim();
    if (!name) { K.toast('กรุณากรอกชื่อตัวเลือก'); nameEl.focus(); return; }
    b.disabled = true;
    try {
      await API.addOptionItem(gid, { name, priceDelta: Number(priceEl.value) || 0, isDefault: defEl.checked });
      K.toast('เพิ่มตัวเลือกแล้ว');
      await load();
    } catch (err) { K.toast('เพิ่มไม่สำเร็จ: ' + err.message); b.disabled = false; }
  }));
  // ลบตัวเลือก
  box.querySelectorAll('[data-delitem]').forEach((b) => b.addEventListener('click', async () => {
    const okDel = await K.confirmAsk('ลบตัวเลือก', 'ลบตัวเลือก "' + b.dataset.name + '" ออกจากกลุ่มนี้?', 'ลบตัวเลือกนี้');
    if (!okDel) return;
    try { await API.deleteOptionItem(Number(b.dataset.delitem)); K.toast('ลบตัวเลือกแล้ว'); await load(); }
    catch (err) { K.toast('ลบไม่สำเร็จ: ' + err.message); }
  }));
  // แก้ชื่อ/ราคาตัวเลือก
  box.querySelectorAll('[data-renitem]').forEach((b) => b.addEventListener('click', async () => {
    const r = await K.askForm('แก้ไขตัวเลือก', [
      { key: 'name', label: 'ชื่อตัวเลือก', value: b.dataset.name, required: true },
      { key: 'price', label: 'ราคาที่บวกเพิ่ม (บาท)', value: b.dataset.price, type: 'number' },
    ]);
    if (!r) return;
    try {
      await API.updateOptionItem(Number(b.dataset.renitem), { name: r.name, priceDelta: Number(r.price) || 0 });
      K.toast('บันทึกตัวเลือกแล้ว');
      await load();
    } catch (err) { K.toast('บันทึกไม่สำเร็จ: ' + err.message); }
  }));
  // ตั้ง/ยกเลิกค่าเริ่มต้น
  box.querySelectorAll('[data-defitem]').forEach((sw) => sw.addEventListener('change', async () => {
    const id = Number(sw.dataset.defitem);
    sw.disabled = true;
    try {
      await API.updateOptionItem(id, { isDefault: sw.checked });
      K.toast(sw.checked ? 'ตั้งเป็นค่าเริ่มต้นแล้ว' : 'ยกเลิกค่าเริ่มต้นแล้ว');
      await load();
    } catch (err) { sw.checked = !sw.checked; K.toast('บันทึกไม่สำเร็จ: ' + err.message); sw.disabled = false; }
  }));
  // แก้ไขกลุ่ม (ชื่อ/บังคับ/หลายอย่าง)
  box.querySelectorAll('[data-rengrp]').forEach((b) => b.addEventListener('click', async () => {
    const r = await K.askForm('แก้ไขกลุ่มตัวเลือก', [
      { key: 'name', label: 'ชื่อกลุ่ม', value: b.dataset.name, required: true },
      { key: 'required', label: 'บังคับให้ลูกค้าเลือกกลุ่มนี้', type: 'checkbox', value: b.dataset.req === '1' },
      { key: 'multi', label: 'ให้เลือกได้หลายอย่าง', type: 'checkbox', value: b.dataset.multi === '1' },
    ]);
    if (!r) return;
    try {
      await API.updateOptionGroup(Number(b.dataset.rengrp), { name: r.name, required: r.required, multi: r.multi });
      K.toast('บันทึกกลุ่มแล้ว');
      await load();
    } catch (err) { K.toast('บันทึกไม่สำเร็จ: ' + err.message); }
  }));
  // ลบกลุ่ม
  box.querySelectorAll('[data-delgrp]').forEach((b) => b.addEventListener('click', async () => {
    const okDel = await K.confirmAsk('ลบกลุ่มตัวเลือก', 'ลบกลุ่ม "' + b.dataset.name + '" พร้อมตัวเลือกทั้งหมดในกลุ่ม? เมนูที่ใช้กลุ่มนี้จะไม่ถามตัวเลือกนี้อีก', 'ลบกลุ่มนี้');
    if (!okDel) return;
    try { await API.deleteOptionGroup(Number(b.dataset.delgrp)); K.toast('ลบกลุ่มแล้ว'); await load(); }
    catch (err) { K.toast('ลบไม่สำเร็จ: ' + err.message); }
  }));
}

$('btnAddGroup').addEventListener('click', async () => {
  const name = $('newGrpName').value.trim();
  if (!name) { $('grpErr').textContent = 'กรุณากรอกชื่อกลุ่มตัวเลือก'; return; }
  $('grpErr').textContent = '';
  try {
    await API.addOptionGroup({ name, required: $('newGrpRequired').checked, multi: $('newGrpMulti').checked });
    $('newGrpName').value = '';
    $('newGrpRequired').checked = false;
    $('newGrpMulti').checked = false;
    K.toast('เพิ่มกลุ่มตัวเลือกแล้ว');
    await load();
  } catch (err) { $('grpErr').textContent = err.message; }
});

// ---------------------------------------------------------------------------
// โหลด
// ---------------------------------------------------------------------------
async function load() {
  try {
    const data = await API.all();
    categories = data.categories || [];
    menus = data.menus || [];
    optionGroups = data.optionGroups || [];
    optionItems = data.optionItems || [];
    menuGroups = data.menuGroups || [];
    $('nCats').textContent = categories.length;
    $('nMenus').textContent = menus.length;
    $('nGroups').textContent = optionGroups.length;
    renderCats();
    renderGroups();
    await renderMenus();
  } catch (err) {
    $('menuList').innerHTML = '<div class="empty">โหลดข้อมูลไม่สำเร็จ: ' + K.esc(err.message) + '</div>';
  }
}

$('btnAddMenu').addEventListener('click', () => {
  const preset = catFilter && catFilter.startsWith('c:') && catFilter !== 'c:none' ? Number(catFilter.slice(2)) : null;
  const fake = preset ? { category_id: preset } : null;
  K.openMenuEditor({ menu: fake, categories, allGroups: optionGroups, menuGroups, withGroups: true, onSaved: load });
});
$('btnReload').addEventListener('click', () => load().then(() => K.toast('โหลดใหม่แล้ว')));

if (API.onLive) {
  API.onLive((state) => {
    const live = $('live');
    live.className = 'live ' + state;
    $('liveText').textContent = state === 'open' ? 'อัปเดตสด' : state === 'error' ? 'ขาดการเชื่อมต่อ' : 'กำลังเชื่อมต่อ…';
  });
}

load();

/**
 * menus.js — หน้าจอ "เมนูทั้งหมด" ของ "โปรแกรม" (ไม่ใช่หน้าเว็บ)
 * ค้นหา · กรองตามหมวด/สถานะ · เปิด-ปิดการขายเร็ว ๆ · เพิ่ม/แก้ไข/ลบเมนู (พร้อมรูป)
 */
'use strict';

const API = window.qpageShop;
const K = window.MenuKit;
const $ = (id) => document.getElementById(id);

let categories = [];
let menus = [];
let menuGroups = [];
let optionGroups = [];
let status = 'all';
let catFilter = '';        // '' = ทั้งหมด, 'm:<id>' = หมวดหลัก (+ย่อย), 'c:<id>' = หมวดเดียว
let query = '';

const imgCache = new Map();     // image_url → data URL (โหลดครั้งเดียวต่อรูป)

function visibleMenus() {
  const q = query.trim().toLowerCase();
  return menus.filter((m) => {
    if (status === 'on' && Number(m.available) !== 1) return false;
    if (status === 'off' && Number(m.available) === 1) return false;
    if (catFilter) {
      const cid = Number(m.category_id);
      if (catFilter.startsWith('m:')) {
        const main = Number(catFilter.slice(2));
        const subs = categories.filter((c) => Number(c.parent_id) === main).map((c) => Number(c.id));
        if (cid !== main && !subs.includes(cid)) return false;
      } else if (catFilter.startsWith('c:')) {
        if (cid !== Number(catFilter.slice(2))) return false;
      }
    }
    if (q) {
      const hay = (String(m.name || '') + ' ' + String(m.description || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderChips() {
  const mains = categories.filter((c) => !c.parent_id);
  const chips = [`<button class="chip ${catFilter === '' ? 'active' : ''}" data-cat="" type="button">ทุกหมวด <span class="c">(${menus.length})</span></button>`];
  for (const m of mains) {
    const subs = categories.filter((c) => Number(c.parent_id) === Number(m.id));
    const ids = [Number(m.id), ...subs.map((s) => Number(s.id))];
    const n = menus.filter((x) => ids.includes(Number(x.category_id))).length;
    chips.push(`<button class="chip ${catFilter === 'm:' + m.id ? 'active' : ''}" data-cat="m:${m.id}" type="button">${K.esc(m.name)} <span class="c">(${n})</span></button>`);
    for (const s of subs) {
      const sn = menus.filter((x) => Number(x.category_id) === Number(s.id)).length;
      if (!sn) continue;
      chips.push(`<button class="chip ${catFilter === 'c:' + s.id ? 'active' : ''}" data-cat="c:${s.id}" type="button" style="font-weight:600;opacity:.9;">↳ ${K.esc(s.name)} <span class="c">(${sn})</span></button>`);
    }
  }
  if (menus.some((m) => !m.category_id)) {
    const n = menus.filter((m) => !m.category_id).length;
    chips.push(`<button class="chip ${catFilter === 'c:none' ? 'active' : ''}" data-cat="c:none" type="button">ไม่ระบุหมวด <span class="c">(${n})</span></button>`);
  }
  $('catChips').innerHTML = chips.join('');
  $('catChips').querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
    catFilter = b.dataset.cat;
    render();
  }));
}

async function thumbFor(m) {
  const url = m.image_url || '';
  if (!url) return K.EMPTY_IMG;
  if (imgCache.has(url)) return imgCache.get(url);
  imgCache.set(url, K.EMPTY_IMG);
  try {
    const d = await API.imageData(url);
    if (d) { imgCache.set(url, d); const el = document.querySelector('[data-thumb="' + m.id + '"]'); if (el) el.src = d; }
  } catch (e) { /* รูปโหลดไม่ได้ */ }
  return imgCache.get(url) || K.EMPTY_IMG;
}

function render() {
  const list = visibleMenus();
  $('nAll').textContent = menus.length;
  $('nOn').textContent = menus.filter((m) => Number(m.available) === 1).length;
  $('nOff').textContent = menus.filter((m) => Number(m.available) !== 1).length;
  renderChips();
  const box = $('list');
  if (!list.length) {
    box.innerHTML = '<div class="empty">' + (menus.length ? 'ไม่พบเมนูที่ตรงกับที่กรองอยู่' : 'ยังไม่มีเมนูในร้าน — กด "＋ เพิ่มเมนู" เพื่อเริ่ม') + '</div>';
    return;
  }
  box.innerHTML = list.map((m) => {
    const on = Number(m.available) === 1;
    return `<section class="card" style="padding:12px 14px;flex-direction:row;align-items:center;gap:12px;flex-wrap:wrap;">
      <img class="thumb" data-thumb="${m.id}" src="${K.EMPTY_IMG}" alt="">
      <div style="flex:1;min-width:180px;">
        <div class="name">${K.esc(m.name)}</div>
        <div class="sub">${K.esc(K.categoryPath(categories, m.category_id))}${m.description ? ' · ' + K.esc(m.description) : ''}</div>
      </div>
      <span class="price">${K.money(m.price)}</span>
      <span class="badge ${on ? 'ok' : 'wait'}">${on ? 'พร้อมขาย' : 'ของหมด'}</span>
      <label class="sw" title="เปิด/ปิดการขาย">
        <input type="checkbox" data-toggle="${m.id}" ${on ? 'checked' : ''}>
        <span class="track"></span>
      </label>
      <div class="acts" style="display:flex;gap:7px;">
        <button class="btn btn-sm" data-edit="${m.id}" type="button">แก้ไข</button>
        <button class="btn btn-sm btn-danger" data-del="${m.id}" data-name="${K.esc(m.name)}" type="button">ลบ</button>
      </div>
    </section>`;
  }).join('');

  // โหลดรูปจริงทีละใบ (เฉพาะที่แสดงอยู่)
  list.forEach(async (m) => {
    const dataUrl = await thumbFor(m);
    const el = box.querySelector('[data-thumb="' + m.id + '"]');
    if (el && dataUrl) el.src = dataUrl;
  });

  box.querySelectorAll('[data-toggle]').forEach((sw) => sw.addEventListener('change', async () => {
    const id = Number(sw.dataset.toggle);
    const on = sw.checked;
    sw.disabled = true;
    try {
      await API.updateMenu(id, { available: on });
      K.toast(on ? 'เปิดขายเมนูนี้แล้ว' : 'ปิดขายเมนูนี้แล้ว (ของหมด)');
      const m = menus.find((x) => Number(x.id) === id);
      if (m) m.available = on ? 1 : 0;
      render();
    } catch (err) {
      sw.checked = !on;
      K.toast('บันทึกไม่สำเร็จ: ' + err.message);
    } finally { sw.disabled = false; }
  }));
  box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const m = menus.find((x) => Number(x.id) === Number(b.dataset.edit));
    if (m) K.openMenuEditor({ menu: m, categories, onSaved: load });
  }));
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const okDel = await K.confirmAsk('ลบเมนู', 'ต้องการลบเมนู "' + b.dataset.name + '" ใช่ไหม? รายการที่เคยสั่งไปแล้วยังอยู่ในประวัติ', 'ลบเมนูนี้');
    if (!okDel) return;
    b.disabled = true;
    try {
      await API.deleteMenu(Number(b.dataset.del));
      K.toast('ลบเมนูแล้ว');
      await load();
    } catch (err) { K.toast('ลบไม่สำเร็จ: ' + err.message); b.disabled = false; }
  }));
}

async function load() {
  try {
    const data = await API.all();
    categories = data.categories || [];
    menus = data.menus || [];
    menuGroups = data.menuGroups || [];
    optionGroups = data.optionGroups || [];
    render();
  } catch (err) {
    $('list').innerHTML = '<div class="empty">โหลดเมนูไม่สำเร็จ: ' + K.esc(err.message) + '</div>';
  }
}

$('q').addEventListener('input', () => { query = $('q').value; render(); });
$('fStatus').querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => {
  status = b.dataset.status;
  $('fStatus').querySelectorAll('[data-status]').forEach((x) => x.classList.toggle('active', x === b));
  render();
}));
$('btnAdd').addEventListener('click', () => K.openMenuEditor({ categories, onSaved: load }));
$('btnReload').addEventListener('click', () => load().then(() => K.toast('โหลดใหม่แล้ว')));

if (API.onLive) {
  API.onLive((state) => {
    const live = $('live');
    live.className = 'live ' + state;
    $('liveText').textContent = state === 'open' ? 'อัปเดตสด' : state === 'error' ? 'ขาดการเชื่อมต่อ' : 'กำลังเชื่อมต่อ…';
  });
}
API.onEvent((evt) => {
  if (['order_new', 'item_status', 'checkout'].includes(evt.type)) load();   // เผื่อมีคนอื่นแก้เมนู/ของหมด
});

load();

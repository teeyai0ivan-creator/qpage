/**
 * notify.js — หน้าจอ "แจ้งเตือน" ของ "โปรแกรม" (ไม่ใช่หน้าเว็บ)
 * จัดการกลุ่มแจ้งเตือน Telegram: เพิ่ม/แก้/ลบ + เลือกเหตุการณ์ที่รับแจ้ง + เปิด/ปิดกลุ่ม
 */
'use strict';

const API = window.qpageShop;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let events = [];
let groups = [];
let editing = null;      // null = เพิ่มใหม่, ไม่งั้นคือ id ที่กำลังแก้

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 3400);
}
const setErr = (m) => { $('editErr').textContent = m || ''; };
const eventLabel = (key) => { const e = events.find((x) => x.key === key); return e ? e.label : key; };

function renderEventsExplain() {
  $('eventList').innerHTML = events.map((e) => `<div class="pick" style="cursor:default;align-items:flex-start;flex-direction:column;gap:2px;">
    <b>${esc(e.label)}</b><span class="hint" style="margin:0;">${esc(e.desc || '')}</span>
  </div>`).join('');
}

function renderGroups() {
  $('stGroups').textContent = 'กลุ่ม ' + groups.length;
  const activeCount = groups.filter((g) => Number(g.active) === 1).length;
  $('stActive').textContent = 'เปิดใช้งาน ' + activeCount;
  const box = $('groupList');
  if (!groups.length) {
    box.innerHTML = '<div class="empty">ยังไม่มีกลุ่มแจ้งเตือน<br>กด "＋ เพิ่มกลุ่มแจ้งเตือน" เพื่อเริ่ม (ต้องมีบอท Telegram ของร้าน)</div>';
    return;
  }
  box.innerHTML = groups.map((g) => {
    const evs = Array.isArray(g.events) ? g.events : [];
    const on = Number(g.active) === 1;
    return `<section class="card">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <b style="font-size:16px;">${esc(g.name)}</b>
        <span class="badge ${on ? 'ok' : 'wait'}">${on ? 'เปิดใช้งาน' : 'ปิดอยู่'}</span>
        <span class="spacer" style="flex:1;"></span>
        <span class="hint" style="margin:0;">Chat ID: <span class="mono">${esc(g.tg_chat || g.tgChat || '')}</span>${(g.tg_thread || g.tgThread) ? ' · thread ' + esc(g.tg_thread || g.tgThread) : ''}</span>
        <button class="btn btn-sm" data-edit="${g.id}" type="button">แก้ไข</button>
        <button class="btn btn-sm btn-danger" data-del="${g.id}" data-name="${esc(g.name)}" type="button">ลบ</button>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${evs.length ? evs.map((k) => `<span class="badge cook">${esc(eventLabel(k))}</span>`).join('') : '<span class="hint" style="margin:0;">ยังไม่ได้เลือกเหตุการณ์</span>'}
      </div>
    </section>`;
  }).join('');

  box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openEdit(Number(b.dataset.edit))));
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => askDelete(Number(b.dataset.del), b.dataset.name, b)));
}

/** ยืนยันการลบด้วยกล่องของโปรแกรมเอง (ไม่ใช้กล่อง confirm ของเบราว์เซอร์) */
function askDelete(id, name, btn) {
  $('delMsg').textContent = 'ต้องการลบกลุ่ม "' + name + '" ใช่ไหม? กลุ่มนี้จะไม่ได้รับการแจ้งเตือนอีก';
  $('delOverlay').classList.add('show');
  $('delOk').onclick = async () => {
    $('delOverlay').classList.remove('show');
    btn.disabled = true;
    try {
      await API.deleteNotifyGroup(id);
      toast('ลบกลุ่ม "' + name + '" แล้ว');
      await load();
    } catch (err) { toast('ลบไม่สำเร็จ: ' + err.message); btn.disabled = false; }
  };
  $('delCancel').onclick = () => { $('delOverlay').classList.remove('show'); };
}

function openEdit(id) {
  editing = id || null;
  const g = id ? groups.find((x) => Number(x.id) === Number(id)) : null;
  $('editTitle').textContent = g ? 'แก้ไขกลุ่มแจ้งเตือน' : 'เพิ่มกลุ่มแจ้งเตือน';
  $('fName').value = g ? (g.name || '') : '';
  $('fToken').value = g ? (g.tg_token || g.tgToken || '') : '';
  $('fChat').value = g ? (g.tg_chat || g.tgChat || '') : '';
  $('fThread').value = g ? (g.tg_thread || g.tgThread || '') : '';
  $('fActive').checked = g ? Number(g.active) === 1 : true;
  $('fActiveLabel').textContent = $('fActive').checked ? 'เปิดใช้งาน' : 'ปิดอยู่';
  const chosen = new Set(g && Array.isArray(g.events) ? g.events : []);
  $('fEvents').innerHTML = events.map((e) => `<label class="pick">
    <input type="checkbox" value="${esc(e.key)}" ${chosen.has(e.key) ? 'checked' : ''}>
    <span><b>${esc(e.label)}</b><br><span class="hint" style="margin:0;">${esc(e.desc || '')}</span></span>
  </label>`).join('');
  setErr('');
  $('editOverlay').classList.add('show');
  setTimeout(() => $('fName').focus(), 60);
}
function closeEdit() { $('editOverlay').classList.remove('show'); editing = null; }

$('fActive').addEventListener('change', () => { $('fActiveLabel').textContent = $('fActive').checked ? 'เปิดใช้งาน' : 'ปิดอยู่'; });

$('editSave').addEventListener('click', async () => {
  const btn = $('editSave');
  const evs = [...$('fEvents').querySelectorAll('input:checked')].map((el) => el.value);
  const fields = {
    name: $('fName').value.trim(),
    tgToken: $('fToken').value.trim(),
    tgChat: $('fChat').value.trim(),
    tgThread: $('fThread').value.trim(),
    active: $('fActive').checked,
    events: evs,
  };
  if (!fields.name) { setErr('กรุณาตั้งชื่อกลุ่มแจ้งเตือน'); return; }
  if (!evs.length) { setErr('เลือกอย่างน้อย 1 เหตุการณ์ที่ต้องการให้แจ้งเตือน'); return; }
  if (fields.active && (!fields.tgToken || !fields.tgChat)) { setErr('กลุ่มที่เปิดใช้งานต้องมี Bot Token และ Chat ID'); return; }
  btn.disabled = true;
  setErr('');
  try {
    if (editing) { await API.updateNotifyGroup(editing, fields); toast('บันทึกกลุ่มแล้ว'); }
    else { await API.addNotifyGroup(fields); toast('เพิ่มกลุ่มแล้ว'); }
    closeEdit();
    await load();
  } catch (err) { setErr(err.message); }
  finally { btn.disabled = false; }
});

$('btnAdd').addEventListener('click', () => openEdit(null));
$('btnReload').addEventListener('click', () => load().then(() => toast('โหลดใหม่แล้ว')));
$('editCancel').addEventListener('click', closeEdit);
$('editOverlay').addEventListener('click', (e) => { if (e.target === $('editOverlay')) closeEdit(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEdit(); });

async function load() {
  try {
    const data = await API.notifyGroups();
    events = data.events || [];
    groups = data.groups || [];
    renderEventsExplain();
    renderGroups();
  } catch (err) {
    $('groupList').innerHTML = '<div class="empty">โหลดข้อมูลไม่สำเร็จ: ' + esc(err.message) + '</div>';
  }
}

if (API.onLive) {
  API.onLive((state) => {
    const live = $('live');
    live.className = 'live ' + state;
    $('liveText').textContent = state === 'open' ? 'อัปเดตสด' : state === 'error' ? 'ขาดการเชื่อมต่อ' : 'กำลังเชื่อมต่อ…';
  });
}

load();

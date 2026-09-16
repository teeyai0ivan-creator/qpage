/**
 * settings.js — ตัวควบคุมหน้าตั้งค่าโปรแกรม (โหลด/บันทึกค่าผ่าน settings-preload.js)
 */
'use strict';

const $ = (id) => document.getElementById(id);
const KINDS = ['ticket', 'receipt', 'label', 'other'];          // แถวตั้งค่าเครื่องพิมพ์/ขนาดกระดาษ
const SWITCH_KINDS = ['ticket', 'receipt', 'label'];            // สวิตช์รับงานจากมือถือ (ไม่มี other)
const KIND_LABEL = { ticket: 'ใบสั่งครัว', receipt: 'ใบเสร็จ', label: 'ป้าย QR', other: 'เอกสารอื่น' };
// หมายเหตุ: Windows/Chromium ไม่รับขนาดกระดาษที่กำหนดเอง — ม้วน 58/80mm ให้ตั้งขนาดในไดรเวอร์เครื่องพิมพ์
const PAPERS = [
  { value: 'auto', label: 'ตามที่ตั้งไว้ในเครื่องพิมพ์ (แนะนำ)' },
  { value: 'a4', label: 'A4' },
  { value: 'letter', label: 'Letter' },
  { value: 'legal', label: 'Legal' },
];

let state = null;
let printers = [];

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dt = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
};

function fillPaperSelects() {
  for (const k of KINDS) {
    const sel = $('paper-' + k);
    if (!sel) continue;
    sel.innerHTML = PAPERS.map((p) => `<option value="${p.value}">${esc(p.label)}</option>`).join('');
  }
}

function fillPrinterSelects() {
  const opts = ['<option value="">(เครื่องพิมพ์เริ่มต้นของ Windows)</option>']
    .concat(printers.map((p) => `<option value="${esc(p.name)}">${esc(p.displayName)}${p.isDefault ? ' (ค่าเริ่มต้น)' : ''}</option>`));
  for (const k of KINDS) {
    const sel = $('printer-' + k);
    if (!sel) continue;
    const cur = (state.settings.printers[k] || {}).device || '';
    sel.innerHTML = opts.join('');
    sel.value = cur;
    // เครื่องพิมพ์ที่เคยเลือกไว้ถูกถอด/เปลี่ยนชื่อ → เตือนแล้วกลับไปใช้ค่าเริ่มต้น
    if (cur && !printers.some((p) => p.name === cur)) {
      sel.innerHTML = `<option value="${esc(cur)}">⚠️ ไม่พบเครื่องพิมพ์นี้แล้ว (${esc(cur)})</option>` + opts.join('');
      sel.value = cur;
    }
  }
}

function applyState() {
  $('serverUrl').value = state.settings.serverUrl || '';
  $('label').value = state.settings.label || '';
  $('sw-silent').checked = state.settings.silent !== false;
  $('sw-autostart').checked = !!state.settings.autoStart;
  $('sw-fullscreen').checked = !!state.settings.fullscreen;
  for (const k of SWITCH_KINDS) {
    const sw = $('sw-kind-' + k);
    if (sw) sw.checked = !!(state.settings.kinds || {})[k];
  }
  for (const k of KINDS) {
    const sel = $('paper-' + k);
    if (sel) sel.value = (state.settings.printers[k] || {}).paper || (k === 'other' ? 'a4' : 'auto');
  }
  fillPrinterSelects();
}

async function refreshStatus() {
  const box = $('statusBox');
  const me = await window.qpageSettings.me();
  const active = state.agentActive;
  if (me.loggedIn) {
    box.className = 'notice ok';
    box.innerHTML = `✅ เข้าสู่ระบบแล้ว: <b>${esc(me.email)}</b>${me.name ? ' — ร้าน ' + esc(me.name) : ''}`
      + (active ? ' · ตัวช่วยพิมพ์ <b>เปิด</b> (พร้อมรับงานจากมือถือ/แท็บเล็ต)' : ' · ตัวช่วยพิมพ์ <b>ปิด</b> (เปิดได้ด้านล่าง)');
  } else {
    box.className = 'notice warn';
    box.innerHTML = '⚠️ ยังไม่ได้เข้าสู่ระบบในโปรแกรม — เปิดหน้าต่างหลักแล้วเข้าสู่ระบบก่อน '
      + 'จึงจะรับงานพิมพ์จากมือถือ/แท็บเล็ตได้ (การพิมพ์จากเครื่องนี้ใช้ได้เลยไม่ต้องล็อกอิน)';
  }
}

async function refreshJobs() {
  const box = $('jobRows');
  const r = await window.qpageSettings.recentJobs();
  if (!r.ok) {
    box.innerHTML = `<tr><td colspan="4" class="hint">โหลดประวัติไม่ได้${r.status ? ' (HTTP ' + r.status + ')' : ''}${r.error ? ' — ' + esc(r.error) : ''}</td></tr>`;
    return;
  }
  if (!r.jobs.length) { box.innerHTML = '<tr><td colspan="4" class="hint">ยังไม่มีงานพิมพ์จากเครื่องอื่น</td></tr>'; return; }
  box.innerHTML = r.jobs.map((j) => {
    const cls = j.status === 'printed' ? 'ok' : j.status === 'pending' ? 'wait' : 'bad';
    const label = j.status === 'printed' ? 'พิมพ์แล้ว' : j.status === 'pending' ? 'รอพิมพ์' : j.status === 'failed' ? 'ไม่สำเร็จ' : 'ยกเลิก';
    return `<tr>
      <td>${dt(j.created_at)}</td>
      <td>${esc(KIND_LABEL[j.kind] || j.kind)}</td>
      <td>${j.table_code ? 'โต๊ะ ' + esc(j.table_code) : ''}${j.bill_no ? ' · บิล #' + String(j.bill_no).padStart(4, '0') : ''}</td>
      <td><span class="pill ${cls}">${label}</span>${j.error ? '<div class="hint">' + esc(j.error) + '</div>' : ''}</td>
    </tr>`;
  }).join('');
}

function renderLog(entry) {
  const box = $('logBox');
  const lines = [entry].filter(Boolean).concat((state.log || []).slice(0, 10));
  box.innerHTML = lines.slice(0, 10).map((e) => {
    const when = dt(new Date(e.at).toISOString());
    if (e.kind === 'agent') return `<div>${when} · <b>ตัวช่วยพิมพ์:</b> ${esc(e.reason)}</div>`;
    return `<div>${when} · <b>${esc(KIND_LABEL[e.kind] || e.kind || '')}</b> → ${e.ok ? '<span class="pill ok">พิมพ์แล้ว</span>' : '<span class="pill bad">ไม่สำเร็จ</span>'} ${esc(e.device || '')} (${esc(e.paper || '')})${e.reason ? ' — ' + esc(e.reason) : ''}</div>`;
  }).join('');
}

async function save(patch) {
  const r = await window.qpageSettings.save(patch);
  state.settings = r.settings;
  state.agentActive = Object.keys(r.settings.kinds || {}).some((k) => r.settings.kinds[k]);
  await refreshStatus();
}

async function init() {
  state = await window.qpageSettings.getState();
  printers = await window.qpageSettings.listPrinters();
  fillPaperSelects();
  applyState();
  $('aboutBox').innerHTML = `เวอร์ชัน ${esc(state.version)} · ไฟล์ตั้งค่า: <span class="mono">${esc(state.file)}</span>`
    + `<br>รหัสเครื่อง: <span class="mono">${esc(state.settings.deviceId)}</span> (ใช้แยกว่าคำสั่งมาจากเครื่องนี้ — กันพิมพ์ซ้ำ)`;
  renderLog();
  await refreshStatus();
  await refreshJobs();

  // ที่อยู่เซิร์ฟเวอร์ + ชื่อเครื่อง → บันทึกด้วยปุ่ม (กันพิมพ์พลาดแล้วหน้าเว็บรีโหลด)
  $('saveServerBtn').addEventListener('click', async () => {
    const url = $('serverUrl').value.trim();
    if (url && !/^https?:\/\//i.test(url)) { alert('ที่อยู่เซิร์ฟเวอร์ต้องขึ้นต้นด้วย http:// หรือ https://'); return; }
    await save({ serverUrl: url, label: $('label').value.trim() });
    alert('บันทึกแล้ว');
  });
  $('reloadBtn').addEventListener('click', async () => { await window.qpageSettings.reloadMain(); });

  // สวิตช์ต่าง ๆ → บันทึกทันที
  $('sw-silent').addEventListener('change', (e) => save({ silent: e.target.checked }));
  $('sw-autostart').addEventListener('change', (e) => save({ autoStart: e.target.checked }));
  $('sw-fullscreen').addEventListener('change', (e) => save({ fullscreen: e.target.checked }));
  for (const k of SWITCH_KINDS) {
    const sw = $('sw-kind-' + k);
    if (sw) sw.addEventListener('change', (e) => save({ kinds: { [k]: e.target.checked } }));
  }
  for (const k of KINDS) {
    const p = $('printer-' + k);
    const pa = $('paper-' + k);
    if (p) p.addEventListener('change', (e) => save({ printers: { [k]: { device: e.target.value } } }));
    if (pa) pa.addEventListener('change', (e) => save({ printers: { [k]: { paper: e.target.value } } }));
  }

  // ปุ่มพิมพ์ทดสอบ
  document.querySelectorAll('[data-test]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.test;
      const old = btn.textContent;
      btn.disabled = true; btn.textContent = 'กำลังพิมพ์…';
      const r = await window.qpageSettings.testPrint(kind);
      btn.disabled = false; btn.textContent = old;
      renderLog({ at: Date.now(), kind, ok: r.success, device: r.device, paper: r.paper, reason: r.reason });
      alert(r.success
        ? `ส่งงานพิมพ์${KIND_LABEL[kind]}ไปที่ ${r.device} แล้ว\nถ้าไม่เห็นกระดาษออก ให้ตรวจว่าเครื่องพิมพ์เปิดอยู่และเลือกเครื่องถูกต้อง`
        : `พิมพ์ไม่สำเร็จ: ${r.reason}`);
    });
  });

  window.qpageSettings.onPrintLog((entry) => renderLog(entry));
}

init().catch((err) => { $('statusBox').className = 'notice bad'; $('statusBox').textContent = 'โหลดค่าตั้งไม่สำเร็จ: ' + err.message; });

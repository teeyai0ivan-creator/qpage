/**
 * setup.js — หน้าจอ "ตั้งค่าข้อมูลร้าน" ของ "โปรแกรม" (ไม่ใช่หน้าเว็บ)
 * แก้ชื่อ/เบอร์/LINE/Maps/SEO + อัปโหลดโลโก้ (อ่านไฟล์ในเครื่องเป็น data URL แล้วส่งให้ main อัปโหลด)
 */
'use strict';

const API = window.qpageShop;
const $ = (id) => document.getElementById(id);
const EMPTY_LOGO = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96'%3E%3Crect width='96' height='96' fill='%23eef0fa'/%3E%3C/svg%3E";

let logoUrl = '';
let shop = null;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 3200);
}
const setErr = (m) => { $('err').textContent = m || ''; };

function paint() {
  $('fName').value = (shop && shop.name) || '';
  $('fPhone').value = (shop && shop.phone) || '';
  $('fLine').value = (shop && shop.line_url) || '';
  $('fMaps').value = (shop && shop.maps_url) || '';
  $('fSeoTitle').value = (shop && shop.seo_title) || '';
  $('fSeoDesc').value = (shop && shop.seo_description) || '';
  logoUrl = (shop && shop.logo_url) || '';
  $('fOpenTime').value = shop && shop.open_time ? String(shop.open_time).slice(0, 5) : '';
  $('fCloseTime').value = shop && shop.close_time ? String(shop.close_time).slice(0, 5) : '';
  setDays(shop && shop.open_days);
  $('logoPreview').src = logoUrl || EMPTY_LOGO;
}

/** รูปที่เก็บบนเซิร์ฟเวอร์เป็นพาธ (/uploads/...) — หน้าจอไฟล์ในเครื่องโหลดตรงไม่ได้ ต้องให้ main ดึงมาเป็น data URL */
async function loadLogoPreview() {
  if (!logoUrl) { $('logoPreview').src = EMPTY_LOGO; return; }
  $('logoPreview').src = logoUrl;
  try {
    const dataUrl = await API.imageData(logoUrl);
    if (dataUrl) $('logoPreview').src = dataUrl;
  } catch (e) { /* รูปเก่าโหลดไม่ได้ ก็ยังบันทึกค่าเดิมไว้ได้ */ }
}

async function load() {
  try {
    const data = await API.all();
    shop = data.shop;
    if (!shop) { setErr('บัญชีนี้ยังไม่มีร้าน'); return; }
    setErr('');
    paint();
    $('publicUrl').value = data.publicUrl || '';
    await loadLogoPreview();
  } catch (err) {
    setErr('โหลดข้อมูลร้านไม่สำเร็จ: ' + err.message);
  }
}

// ---------- อัปโหลดโลโก้ ----------
$('logoFile').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) { setErr('ไฟล์ใหญ่เกิน 3MB'); e.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = async () => {
    setErr('');
    $('logoHint').textContent = 'กำลังอัปโหลด…';
    try {
      const url = await API.upload(String(reader.result));
      logoUrl = url;
      $('logoPreview').src = String(reader.result);
      $('logoHint').textContent = 'อัปโหลดแล้ว — กด "บันทึกข้อมูลร้าน" เพื่อยืนยัน';
    } catch (err) {
      setErr('อัปโหลดรูปไม่สำเร็จ: ' + err.message);
      $('logoHint').textContent = 'รองรับ png/jpeg/webp/gif ไม่เกิน 3MB';
    } finally { e.target.value = ''; }
  };
  reader.readAsDataURL(file);
});
$('btnLogoClear').addEventListener('click', () => {
  logoUrl = '';
  $('logoPreview').src = EMPTY_LOGO;
  $('logoHint').textContent = 'เอาโลโก้ออกแล้ว — กด "บันทึกข้อมูลร้าน" เพื่อยืนยัน';
});

// ---------- บันทึก ----------
$('btnSave').addEventListener('click', async () => {
  const btn = $('btnSave');
  const name = $('fName').value.trim();
  if (name.length < 2) { setErr('กรุณากรอกชื่อร้าน (อย่างน้อย 2 ตัวอักษร)'); return; }
  btn.disabled = true;
  setErr('');
  try {
    // บันทึกเวลาเปิด–ปิด/วันเปิดทำการ (คนละปลายทางกับข้อมูลร้าน)
    await API.saveHours({ openTime: $('fOpenTime').value, closeTime: $('fCloseTime').value, openDays: chosenDays() });
    const r = await API.save({
      name,
      phone: $('fPhone').value.trim(),
      lineUrl: $('fLine').value.trim(),
      mapsUrl: $('fMaps').value.trim(),
      seoTitle: $('fSeoTitle').value.trim(),
      seoDescription: $('fSeoDesc').value.trim(),
      logoUrl,
    });
    shop = r.shop || shop;
    paint();
    $('savedAt').textContent = 'บันทึกล่าสุด ' + new Date().toLocaleTimeString('th-TH');
    toast(r.message || 'บันทึกข้อมูลร้านแล้ว');
  } catch (err) {
    setErr(err.message);
    toast('บันทึกไม่สำเร็จ: ' + err.message);
  } finally { btn.disabled = false; }
});

$('btnReload').addEventListener('click', () => load().then(() => toast('โหลดใหม่แล้ว')));
$('btnCopyUrl').addEventListener('click', async () => {
  const v = $('publicUrl').value;
  if (!v) return;
  try { await navigator.clipboard.writeText(v); toast('คัดลอกลิงก์แล้ว: ' + v); }
  catch (e) { toast('คัดลอกไม่สำเร็จ — คัดลอกจากช่องได้เลย: ' + v); }
});

if (API.onLive) {
  API.onLive((state) => {
    const live = $('live');
    live.className = 'live ' + state;
    $('liveText').textContent = state === 'open' ? 'อัปเดตสด' : state === 'error' ? 'ขาดการเชื่อมต่อ' : 'กำลังเชื่อมต่อ…';
  });
}

// ---------- วันเปิดทำการ ----------
const DAY_SHORT = ['', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.'];
const DAY_FULL = ['', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์'];
function renderDays(selected) {
  const on = new Set((selected && selected.length ? selected : [1,2,3,4,5,6,7]).map(Number));
  $('fDays').innerHTML = DAY_SHORT.slice(1).map((n, i) => {
    const d = i + 1;
    return '<label class="btn btn-sm" style="cursor:pointer;display:inline-flex;gap:6px;align-items:center;' + (on.has(d) ? 'background:linear-gradient(135deg,#4f46e5,#8b5cf6);color:#fff;border-color:transparent;' : '') + '">'
      + '<input type="checkbox" data-day value="' + d + '" ' + (on.has(d) ? 'checked' : '') + ' style="accent-color:#4f46e5;"> ' + n + '</label>';
  }).join('');
  $('fDays').querySelectorAll('[data-day]').forEach((cb) => cb.addEventListener('change', () => {
    const p = cb.parentElement;
    p.style.background = cb.checked ? 'linear-gradient(135deg,#4f46e5,#8b5cf6)' : '';
    p.style.color = cb.checked ? '#fff' : '';
    paintHours();
  }));
  paintHours();
}
function setDays(v) {
  const days = String(v == null ? '' : v).split(',').map((x) => Number(String(x).trim())).filter((n) => n >= 1 && n <= 7);
  renderDays(days.length ? days : [1,2,3,4,5,6,7]);
}
function chosenDays() { return [...document.querySelectorAll('#fDays [data-day]:checked')].map((c) => Number(c.value)); }
function paintHours() {
  const ot = $('fOpenTime').value, ct = $('fCloseTime').value, days = chosenDays();
  $('fHoursPreview').textContent = (!ot && !ct)
    ? ('ยังไม่กำหนดเวลา = เปิดตลอด 24 ชั่วโมง' + (days.length && days.length < 7 ? ' (เฉพาะวันที่เลือก)' : ''))
    : ('เปิด ' + (ot || '—') + '–' + (ct || '—') + ' · วันที่เปิด: ' + (days.length ? days.map((d) => DAY_FULL[d]).join(' · ') : 'ยังไม่เลือกวัน (ลูกค้าจะสั่งไม่ได้)'));
}
$('fOpenTime').addEventListener('change', paintHours);
$('fCloseTime').addEventListener('change', paintHours);
renderDays([1,2,3,4,5,6,7]);

load();

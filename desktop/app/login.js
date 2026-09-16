/**
 * login.js — หน้าเข้าสู่ระบบของ "โปรแกรม" (ไม่ใช่หน้าเว็บ)
 *
 * เงื่อนไขการใช้โปรแกรม (ตรวจจากเซิร์ฟเวอร์):
 *   1) ต้องเข้าสู่ระบบได้ (อีเมล + รหัสผ่าน)
 *   2) บัญชีต้องมีร้านค้า
 *   3) ต้องมีแพ็กเกจร้านค้าที่ยังไม่หมดอายุ (ซื้อไว้ หรือของขวัญจากแอดมิน)
 * ถ้าไม่ครบ → เข้าใช้โปรแกรมไม่ได้ (ข้อมูลร้าน/ลูกค้ายังอยู่ครบ ไม่ถูกลบ) พร้อมปุ่มไปซื้อ/ต่ออายุ
 */
'use strict';

const API = window.qpageLogin;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const thDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + (d.getFullYear() + 543);
};

function showErr(text) {
  const el = $('msgErr');
  el.textContent = text || '';
  el.classList.toggle('show', !!text);
}
function showBlocked(text) {
  const el = $('msgBlocked');
  el.innerHTML = text || '';
  el.classList.toggle('show', !!text);
}
let busy = false;
function setBusy(on, label) {
  busy = on;
  const b = $('btnLogin');
  b.disabled = on;
  b.innerHTML = on ? '<span class="spinner"></span>' + (label || 'กำลังเข้าสู่ระบบ…') : 'เข้าสู่ระบบ';
}

/** แสดงผลตามสถานะที่ main ตรวจมาให้ */
function paint(state) {
  const blocked = !!state.blocked;
  $('formArea').classList.toggle('hidden', blocked);
  $('blockArea').classList.toggle('hidden', !blocked);
  if (!blocked) {
    showBlocked('');
    $('footText').textContent = 'ใช้ได้เฉพาะบัญชีที่มีร้านค้าและแพ็กเกจที่ยังไม่หมดอายุ';
    return;
  }
  const lines = [];
  if (state.reason === 'no_shop') {
    lines.push('<b>บัญชีนี้ยังไม่มีร้านค้าในระบบ</b><br>โปรแกรมนี้ใช้สำหรับเจ้าของร้านที่มีแพ็กเกจร้านค้าแล้วเท่านั้น<br>กดปุ่มด้านล่างเพื่อซื้อแพ็กเกจ แล้วกลับมาเข้าสู่ระบบอีกครั้ง');
  } else if (state.reason === 'no_package') {
    lines.push('<b>ร้านนี้ยังไม่มีแพ็กเกจร้านค้า</b><br>กดปุ่มด้านล่างเพื่อซื้อแพ็กเกจ แล้วกลับมาเข้าสู่ระบบอีกครั้ง');
  } else if (state.reason === 'expired') {
    lines.push('<b>แพ็กเกจร้านค้าหมดอายุแล้ว' + (state.entitlementEnd ? ' (หมดอายุ ' + thDate(state.entitlementEnd) + ')' : '') + '</b><br>'
      + 'กดปุ่มด้านล่างเพื่อซื้อแพ็กเกจเพิ่ม แล้วกลับมาเข้าสู่ระบบอีกครั้ง');
  } else if (state.reason === 'server') {
    lines.push('<b>ตรวจสอบสิทธิ์ไม่ได้</b><br>' + (state.message || 'เซิร์ฟเวอร์ไม่ตอบสนอง — ตรวจการเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่'));
  } else {
    // ไม่ใช่บัญชีเจ้าของร้าน หรือแพ็กเกจหมดอายุจนระบบปรับบัญชีกลับเป็นผู้ใช้ทั่วไป (ข้อมูลยังอยู่ครบ)
    lines.push('<b>บัญชีนี้ยังไม่มีสิทธิ์ใช้ระบบร้านค้า</b><br>'
      + (state.message ? esc(state.message) + '<br>' : '')
      + 'ถ้าแพ็กเกจร้านค้าหมดอายุ ระบบจะปรับบัญชีกลับเป็นผู้ใช้ทั่วไปโดยอัตโนมัติ — ซื้อแพ็กเกจเพื่อกลับมาใช้งานต่อได้');
  }
  if (state.shopName) lines.push('ร้าน: <b>' + esc(state.shopName) + '</b>');
  if (state.email) lines.push('บัญชี: ' + esc(state.email));
  lines.push('<span style="font-weight:600;">ข้อมูลร้าน เมนู และประวัติลูกค้ายังอยู่ในระบบครบถ้วน — ไม่ได้ถูกลบ แค่ยังเข้าใช้โปรแกรมไม่ได้จนกว่าจะมีแพ็กเกจที่ใช้งานได้</span>');
  showBlocked(lines.join('<br>'));
  $('footText').textContent = state.shopName ? 'ร้าน ' + state.shopName : 'โปรแกรมร้านค้า QPage';
}

async function refresh() {
  try {
    const st = await API.state();
    paint(st);
  } catch (err) {
    paint({ blocked: false });
  }
}

async function doLogin() {
  if (busy) return;
  const email = $('email').value.trim();
  const password = $('password').value;
  showErr('');
  if (!email) { showErr('กรุณากรอกอีเมล'); $('email').focus(); return; }
  if (!password) { showErr('กรุณากรอกรหัสผ่าน'); $('password').focus(); return; }
  setBusy(true);
  try {
    const r = await API.login({ email, password });
    if (!r.ok) { showErr(r.message || 'เข้าสู่ระบบไม่สำเร็จ'); return; }
    if (r.blocked) { paint(r); return; }          // ล็อกอินได้แต่ไม่มีสิทธิ์ใช้โปรแกรม
    paint({ blocked: false });
    await API.enterApp();                          // ให้ main เปลี่ยนไปหน้าจอการใช้งาน
  } catch (err) {
    showErr(err && err.message ? err.message : 'เข้าสู่ระบบไม่สำเร็จ');
  } finally {
    setBusy(false);
  }
}

$('btnLogin').addEventListener('click', doLogin);
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('email').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('password').focus(); });
$('btnPurchase').addEventListener('click', async () => {
  try { await API.openPurchase(); } catch (err) { showErr('เปิดหน้าซื้อแพ็กเกจไม่สำเร็จ: ' + (err.message || err)); }
});
$('btnRetry').addEventListener('click', async () => {
  await refresh();
  try {
    const r = await API.recheck();
    if (r.blocked) { paint(r); showErr(''); } else { paint({ blocked: false }); await API.enterApp(); }
  } catch (err) { showErr(err.message || 'ตรวจสอบไม่สำเร็จ'); }
});
$('btnLogout').addEventListener('click', async () => {
  await API.logout();
  paint({ blocked: false });
  showErr('');
  $('password').value = '';
  await refresh();
});

refresh();
$('email').focus();

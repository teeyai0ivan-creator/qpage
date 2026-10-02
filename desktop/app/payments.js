/**
 * payments.js — หน้าจอ "ตั้งค่าการชำระเงิน" ของ "โปรแกรม" (ไม่ใช่หน้าเว็บ)
 * ร้านตั้งเองได้ทั้งหมด: พร้อมเพย์/ธนาคาร/หมายเหตุ/เวลาหมดอายุ + คีย์ EasySlip และโหมดตรวจอัตโนมัติ
 */
'use strict';

const API = window.qpageShop;
const NAV = window.qpageNav;
const $ = (id) => document.getElementById(id);

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 3400);
}
const setErr = (m) => { $('err').textContent = m || ''; };

function paint(d) {
  const s = (d && d.settings) || {};
  const slip = (d && d.slip) || {};
  $('payEnabled').checked = !!s.enabled;
  $('promptpayId').value = s.promptpayId || '';
  $('bankName').value = s.bankName || '';
  $('bankAccount').value = s.bankAccount || '';
  $('bankHolder').value = s.bankHolder || '';
  $('payNote').value = s.note || '';
  $('expireMinutes').value = s.expireMinutes || 10;
  $('slipApiKey').value = '';
  $('slipAutoApprove').checked = slip.autoApprove !== false;
  $('keyState').textContent = slip.configured
    ? ('ตั้งคีย์ไว้แล้ว: ' + slip.keyMasked + ' (เว้นว่าง = ไม่เปลี่ยน)')
    : 'ยังไม่ได้ตั้งคีย์ — ใส่เพื่อเปิดรับโอนเงิน';
  const ready = !!(d && d.transferReady);
  $('stReady').textContent = ready ? 'พร้อมรับโอนเงิน' : 'รับเงินสดเท่านั้น';
  $('stReady').className = 'stat ' + (ready ? 'ok' : 'wait');
  $('enabledHint').textContent = s.enabled
    ? (ready ? 'เปิดอยู่ — ลูกค้าเลือกโอนเงินได้ และระบบตรวจสลิปให้อัตโนมัติ' : 'เปิดอยู่ แต่ยังขาดพร้อมเพย์/เลขบัญชี หรือคีย์ EasySlip')
    : 'ปิดอยู่ = ลูกค้าชำระเงินสดเท่านั้น';
}

async function load() {
  try {
    const d = await API.paymentSettings();
    paint(d);
    setErr('');
  } catch (err) {
    setErr('โหลดค่าตั้งไม่สำเร็จ: ' + err.message);
  }
}

$('btnSave').addEventListener('click', async () => {
  const btn = $('btnSave');
  btn.disabled = true;
  setErr('');
  try {
    const fields = {
      enabled: $('payEnabled').checked,
      promptpayId: $('promptpayId').value.trim(),
      bankName: $('bankName').value.trim(),
      bankAccount: $('bankAccount').value.trim(),
      bankHolder: $('bankHolder').value.trim(),
      note: $('payNote').value.trim(),
      expireMinutes: Number($('expireMinutes').value) || 10,
      slipAutoApprove: $('slipAutoApprove').checked,
    };
    const key = $('slipApiKey').value.trim();
    if (key) fields.slipApiKey = key;
    const r = await API.savePayment(fields);
    paint(r);
    toast(r.message || 'บันทึกการชำระเงินแล้ว');
  } catch (err) {
    setErr(err.message);
    toast('บันทึกไม่สำเร็จ: ' + err.message);
  } finally { btn.disabled = false; }
});

$('btnReload').addEventListener('click', () => load().then(() => toast('โหลดใหม่แล้ว')));
$('btnHistory').addEventListener('click', () => NAV.go('/shop/history.html'));

if (API.onLive) {
  API.onLive((state) => {
    const live = $('live');
    live.className = 'live ' + state;
    $('liveText').textContent = state === 'open' ? 'อัปเดตสด' : state === 'error' ? 'ขาดการเชื่อมต่อ' : 'กำลังเชื่อมต่อ…';
  });
}

load();

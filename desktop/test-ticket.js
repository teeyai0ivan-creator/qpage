/**
 * test-ticket.js — เติมเวลา/ชนิดเอกสารในหน้าพิมพ์ทดสอบ (แยกไฟล์เพราะ CSP ห้ามสคริปต์ฝังในหน้า)
 */
'use strict';

(function () {
  const params = new URLSearchParams(location.search);
  const kind = params.get('kind') || 'ticket';
  const labels = { ticket: 'ใบสั่งครัว', receipt: 'ใบเสร็จ', label: 'ป้าย QR โต๊ะ', other: 'เอกสารอื่น' };
  const paper = params.get('paper') || '80mm';

  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const el = document.getElementById('now');
  if (el) el.textContent = p(now.getDate()) + '/' + p(now.getMonth() + 1) + '/' + (now.getFullYear() + 543) + ' ' + p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds());

  const kindEl = document.getElementById('kindName');
  if (kindEl) kindEl.textContent = labels[kind] || kind;

  const kindBox = document.querySelector('.kind');
  if (kindBox && labels[kind]) kindBox.textContent = labels[kind];

  // ปรับความกว้างตามขนาดกระดาษที่เลือก (เหมือนหน้าใบสั่งครัวจริง)
  const sizes = document.querySelectorAll('body');
  if (sizes.length) sizes[0].className = 'paper-' + (paper === 'a4' ? 'a4' : paper === '58mm' ? '58mm' : '80mm');
})();

/* ตัวช่วยที่ใช้ร่วมกันทุกหน้าฝั่งร้าน/หน้าลูกค้า (ไม่ต้องมี build step — โหลดด้วย <script src="/js/shop-ui.js">)
   แต่ละหน้าเคยประกาศตัวช่วยเหล่านี้ซ้ำกันเอง รวมไว้ที่เดียวเพื่อแก้ที่เดียวจบ
   หมายเหตุ: หน้าที่ต้องการตัวเลขแบบไม่มีสัญลักษณ์ ฿ (menus.html, purchase.html) ใช้ moneyNum ของตัวเอง */
(function () {
  const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  // กัน HTML injection ก่อนเอาไปใส่ innerHTML
  window.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => HTML_ESC[c]);

  // เงินแบบมีสัญลักษณ์ ฿ (ทศนิยมไม่เกิน 2 ตำแหน่ง)
  window.money = (n) => '฿' + Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  // เลขที่บิล #0001
  window.billNoFmt = (n) => (n ? '#' + String(n).padStart(4, '0') : '—');

  // วันเวลาแบบสั้นจาก ISO (วินาทีเป็น UTC ตามที่ฐานข้อมูลเก็บ)
  window.dt = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };

  // นับ "รายการ" เป็นจำนวนจาน (ผลรวม quantity) ให้ตรงกันทุกหน้า
  window.platesOf = (items) => (items || []).reduce((n, it) => n + (Number(it.quantity) || 0), 0);

  // เปิดแท็บเปล่าล่วงหน้าพร้อมข้อความ "กำลังเช็คบิล..." (ต้องเรียกจังหวะที่ผู้ใช้กดจริง ไม่งั้นเบราว์เซอร์บล็อกป๊อปอัป)
  window.openBlankTab = () => {
    const w = window.open('', '_blank');
    try {
      if (w && w.document) {
        w.document.write('<!doctype html><meta charset="utf-8"><title>กำลังเช็คบิล...</title><body style="font-family:Sarabun,Tahoma,sans-serif;padding:24px;color:#475467">กำลังเช็คบิล... กรุณารอสักครู่</body>');
        w.document.close();
      }
    } catch (e) { /* ข้าม */ }
    return w;
  };

  // พาแท็บที่เปิดล่วงหน้าไปหน้าใบเสร็จ · ป๊อปอัปถูกบล็อก → เปิดในแท็บนี้ (ลองซ้ำกันแท็บเปล่าค้าง)
  window.gotoReceipt = (w, url) => {
    if (!w) { location.href = url; return; }
    try { w.location.href = url; } catch (e) { location.href = url; return; }
    setTimeout(() => { try { if (w.location.href === 'about:blank') w.location.href = url; } catch (e) { /* ข้าม */ } }, 800);
  };
})();

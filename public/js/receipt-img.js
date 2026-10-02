/**
 * receipt-img.js — วาด "ใบเสร็จ" ลงบน canvas แล้วส่งออกเป็นภาพ (ใช้ในหน้าจ่ายเงิน/หน้าสำเร็จของลูกค้า)
 *
 * ทำไมวาดเอง: หน้าจอลูกค้าไม่ต้องใช้ไลบรารีภายนอก และ "ใบเสร็จภาพ" เอาไว้บันทึก/แชร์ได้เลย
 * ใช้งาน: window.qpageReceiptImage(receipt, { width }) → คืน data URL (image/png)
 *   receipt = { shop:{name,phone,logo_url}, bill_no, date, order_type, customer_name, customer_phone,
 *               address, items:[{menu_name,quantity,line_total}], total, payment_method, payment_status, trans_ref }
 */
'use strict';

(function () {
  const TH = "'Sarabun','Noto Sans Thai',Tahoma,sans-serif";
  const money = (n) => '฿' + Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (v) => {
    const d = v ? new Date(v) : new Date();
    if (isNaN(d.getTime())) return '';
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + (d.getFullYear() + 543) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  const billNo = (n) => (n ? '#' + String(n).padStart(4, '0') : '—');

  /** ตัดข้อความยาวให้พอดีความกว้าง (เติม … ท้าย) */
  function fit(ctx, text, maxW) {
    let t = String(text == null ? '' : text);
    if (ctx.measureText(t).width <= maxW) return t;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  function build(receipt) {
    const r = receipt || {};
    const items = Array.isArray(r.items) ? r.items : [];
    const W = 420;
    const PAD = 22;
    const lineH = 22;
    const headH = 118;
    const perItemH = 26;
    const infoLines = [];
    if (r.order_type === 'delivery') infoLines.push('จัดส่งที่บ้าน');
    else if (r.order_type === 'pickup') infoLines.push('รับที่ร้าน');
    if (r.customer_name) infoLines.push('ลูกค้า: ' + r.customer_name + (r.customer_phone ? ' · ' + r.customer_phone : ''));
    if (r.address) infoLines.push('ที่อยู่: ' + r.address);
    infoLines.push('ชำระเงิน: ' + (r.payment_status === 'paid'
      ? (r.payment_method === 'transfer' ? 'โอนเงินแล้ว (ตรวจสลิปอัตโนมัติ)' : 'เงินสด — ชำระแล้ว')
      : (r.payment_method === 'transfer' ? 'รอชำระเงิน (โอน)' : 'เก็บเงินปลายทาง')));
    if (r.trans_ref) infoLines.push('รายการโอน: ' + r.trans_ref);

    const footerH = 96;   // เผื่อขอบล่างให้บรรทัดท้ายไม่ถูกตัด
    const rows = Math.max(items.length, 1);   // 0 รายการก็ยังวาดบรรทัด "ไม่มีรายการ" 1 บรรทัด
    const H = headH + infoLines.length * lineH + 26 + rows * perItemH + 78 + footerH;

    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#0f172a';

    // หัวใบเสร็จ
    ctx.textAlign = 'center';
    ctx.font = 'bold 20px ' + TH;
    ctx.fillText(fit(ctx, r.shop && r.shop.name ? r.shop.name : 'ร้านค้า', W - PAD * 2), W / 2, 40);
    ctx.font = '13px ' + TH;
    ctx.fillStyle = '#64748b';
    if (r.shop && r.shop.phone) ctx.fillText('โทร ' + r.shop.phone, W / 2, 60);
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 16px ' + TH;
    ctx.fillText('ใบเสร็จรับเงิน', W / 2, 84);
    ctx.font = '13px ' + TH;
    ctx.fillStyle = '#334155';
    ctx.fillText('บิล ' + billNo(r.bill_no) + ' · ' + fmtDate(r.date), W / 2, 104);
    ctx.fillStyle = '#cbd5e1';
    ctx.fillRect(PAD, headH - 10, W - PAD * 2, 1);

    // ข้อมูลผู้รับ/การชำระ
    let y = headH + 14;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#334155';
    ctx.font = '13px ' + TH;
    for (const line of infoLines) {
      ctx.fillText(fit(ctx, line, W - PAD * 2), PAD, y);
      y += lineH;
    }

    // เส้นคั่น
    y += 8;
    ctx.strokeStyle = '#e2e8f0';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(PAD, y);
    ctx.lineTo(W - PAD, y);
    ctx.stroke();
    ctx.setLineDash([]);
    y += 20;

    // รายการอาหาร
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 13px ' + TH;
    ctx.fillText('รายการ', PAD, y);
    ctx.textAlign = 'right';
    ctx.fillText('จำนวน', W - 132, y);
    ctx.fillText('ราคา', W - PAD, y);
    ctx.textAlign = 'left';
    y += 8;
    ctx.font = '14px ' + TH;
    for (const it of items) {
      y += perItemH;
      ctx.fillStyle = '#0f172a';
      ctx.font = '14px ' + TH;
      ctx.fillText(fit(ctx, it.menu_name, W - PAD * 2 - 150), PAD, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#475569';
      ctx.fillText(String(Number(it.quantity) || 0) + ' × ' + money((Number(it.line_total) || 0) / (Number(it.quantity) || 1)), W - 132, y);
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 14px ' + TH;
      ctx.fillText(money(it.line_total), W - PAD, y);
      ctx.textAlign = 'left';
    }
    if (!items.length) { y += perItemH; ctx.fillStyle = '#94a3b8'; ctx.font = '13px ' + TH; ctx.fillText('ไม่มีรายการ', PAD, y); }

    // ยอดรวม
    y += 18;
    ctx.strokeStyle = '#cbd5e1';
    ctx.beginPath();
    ctx.moveTo(PAD, y);
    ctx.lineTo(W - PAD, y);
    ctx.stroke();
    y += 30;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 15px ' + TH;
    ctx.fillText('ยอดรวม', PAD, y);
    ctx.textAlign = 'right';
    ctx.font = 'bold 22px ' + TH;
    ctx.fillText(money(r.total), W - PAD, y);

    // ท้าย
    y += 40;
    ctx.textAlign = 'center';
    ctx.font = '12px ' + TH;
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('ขอบคุณที่ใช้บริการ 🙏', W / 2, y + 6);
    ctx.fillText('ภาพนี้บันทึกไว้เป็นหลักฐานการชำระเงิน', W / 2, y + 24);

    return c.toDataURL('image/png');
  }

  window.qpageReceiptImage = build;
})();

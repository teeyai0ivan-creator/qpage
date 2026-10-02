/**
 * order-pay.js — การชำระเงินของ "บิลอาหาร" (เดลิเวอร์รี่ / รับที่ร้าน)
 *
 * ต่างจาก lib/payments.js ซึ่งเป็นเรื่อง "ซื้อแพ็กเกจของเจ้าของระบบ":
 * ที่นี่ใช้ค่าที่ "แต่ละร้าน" ตั้งไว้เอง (shops.pay_*) และตรวจสลิปด้วยคีย์ EasySlip ของร้านนั้น
 *
 * ลูกค้าเลือก "โอน" ได้เฉพาะเมื่อร้านตั้งช่องทางรับเงิน + ต่อคีย์ EasySlip แล้วเท่านั้น
 * (ไม่ต่อ = เหลือทางเลือก "เงินสด" ทางเดียว เพื่อไม่ให้ลูกค้าโอนแล้วไม่มีใครตรวจสลิปให้)
 */
'use strict';

const crypto = require('node:crypto');
const { toMs } = require('./time');

/** รหัสอ้างอิงการชำระเงินของบิล (โชว์ให้ลูกค้าเห็น ใช้อ้างอิงกับร้าน) */
function newRef() {
  return 'OD' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

/** หมายเลขรับเงิน (พร้อมเพย์ หรือเลขบัญชีธนาคาร) ของร้าน */
function receiverOf(shop) {
  return {
    promptpayId: String((shop && shop.pay_promptpay_id) || '').trim(),
    bankName: String((shop && shop.pay_bank_name) || '').trim(),
    bankAccount: String((shop && shop.pay_bank_account) || '').trim(),
    bankHolder: String((shop && shop.pay_bank_holder) || '').trim(),
    note: String((shop && shop.pay_note) || '').trim(),
  };
}

/** ร้านนี้เปิดรับ "โอนเงิน" ได้ไหม = เปิดรับชำระ + มีช่องทางรับเงิน + ต่อคีย์ EasySlip */
function canTransfer(shop) {
  if (!shop || Number(shop.pay_enabled) !== 1) return false;
  const r = receiverOf(shop);
  if (!r.promptpayId && !r.bankAccount) return false;
  return Boolean(String(shop.slip_api_key || '').trim());
}

/** ข้อมูลการชำระเงินที่ส่งให้หน้าจ่ายเงินของลูกค้า (ไม่ส่งข้อมูลอ่อนไหวของร้าน) */
function publicInfo(order, shop, items = []) {
  const receiver = receiverOf(shop);
  const expiresMs = order.pay_expires_at ? toMs(order.pay_expires_at) : null;
  const secondsLeft = expiresMs ? Math.max(0, Math.round((expiresMs - Date.now()) / 1000)) : null;
  return {
    ref: order.pay_ref,
    bill_no: order.bill_no,
    order_type: order.order_type,
    total: Number(order.total) || 0,
    status: order.status,
    payment_method: order.payment_method,
    payment_status: order.payment_status,
    paid: order.payment_status === 'paid',
    cancelled: order.status === 'cancelled',
    expires_at_ms: expiresMs,
    seconds_left: secondsLeft,
    slip_status: order.slip_status || '',
    slip_detail: order.slip_detail || '',
    customer_name: order.customer_name || '',
    shop: { name: shop.name, phone: shop.phone || '', logo_url: shop.logo_url || '' },
    receiver: {
      promptpay_id: receiver.promptpayId,
      bank_name: receiver.bankName,
      bank_account: receiver.bankAccount,
      bank_holder: receiver.bankHolder,
      note: receiver.note,
    },
    // รูป QR ถูกสร้างจากยอดเงินของบิลนี้ (ดูเส้นทาง /api/public/pay/:ref/qr.png)
    qr_url: receiver.promptpayId ? '/api/public/pay/' + encodeURIComponent(order.pay_ref) + '/qr.png' : null,
    items: items.map((i) => ({ menu_name: i.menu_name, quantity: Number(i.quantity) || 0, line_total: Number(i.line_total) || 0, status: i.status })),
  };
}

module.exports = { newRef, canTransfer, receiverOf, publicInfo };

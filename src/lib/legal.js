/**
 * legal.js — ข้อมูลทางกฎหมาย/PDPA ของระบบ (ใช้แสดงในหน้าถ้อยแถลง + บันทึกความยินยอม)
 * ปรับชื่อผู้ให้บริการ/อีเมลติดต่อได้ผ่าน environment (ดู .env.example)
 */
'use strict';

// อัปเดตค่านี้ทุกครั้งที่แก้เนื้อหาถ้อยแถลง → ระบบจะบันทึกเวอร์ชันที่ผู้ใช้ยอมรับไว้ด้วย
const PRIVACY_VERSION = '2026-09-15';
const PRIVACY_UPDATED_AT = '15 กันยายน 2569';

const OPERATOR_NAME = process.env.LEGAL_OPERATOR || 'QPage — ระบบสั่งอาหารและระบบสมาชิกร้านค้า';
const CONTACT_EMAIL = process.env.LEGAL_EMAIL || 'support@qpage.website';
const CONTACT_CHANNEL = process.env.LEGAL_CONTACT || 'อีเมล';

/** ข้อมูลสำหรับหน้าถ้อยแถลง (สาธารณะ) */
function publicInfo() {
  return {
    version: PRIVACY_VERSION,
    updatedAt: PRIVACY_UPDATED_AT,
    operator: OPERATOR_NAME,
    email: CONTACT_EMAIL,
    contactChannel: CONTACT_CHANNEL,
  };
}

module.exports = { PRIVACY_VERSION, PRIVACY_UPDATED_AT, OPERATOR_NAME, CONTACT_EMAIL, publicInfo };

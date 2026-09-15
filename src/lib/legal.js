/**
 * legal.js — ข้อมูลทางกฎหมาย/PDPA ของระบบ (ใช้แสดงในหน้าถ้อยแถลง + บันทึกความยินยอม)
 * ค่าที่แสดง ดึงตามลำดับ: ตั้งค่าในหลังบ้าน (settings) → environment → ค่าเริ่มต้น
 * - legal_operator / legal_email  ตั้งได้ที่หลังบ้าน (ภาพรวม → ข้อมูลทางกฎหมายและความเป็นส่วนตัว)
 * - LEGAL_OPERATOR / LEGAL_EMAIL  ตั้งใน .env ได้เช่นกัน
 * - ถ้าไม่ได้ตั้งอีเมลเลย จะใช้ ADMIN_EMAIL ใน .env (อีเมลเจ้าของระบบ) เพื่อไม่ให้หน้าถ้อยแถลงแสดงอีเมลปลอม
 */
'use strict';

const db = require('../db');

// อัปเดตค่านี้ทุกครั้งที่แก้เนื้อหาถ้อยแถลง → ระบบจะบันทึกเวอร์ชันที่ผู้ใช้ยอมรับไว้ด้วย
const PRIVACY_VERSION = '2026-09-15';
const PRIVACY_UPDATED_AT = '15 กันยายน 2569';

const DEFAULT_OPERATOR = process.env.LEGAL_OPERATOR || 'ระบบสั่งอาหารและระบบสมาชิกร้านค้า (QPage)';
const FALLBACK_EMAIL = (process.env.LEGAL_EMAIL || process.env.ADMIN_EMAIL || '').trim();

function settingValue(key, fallback) {
  let v = '';
  try { v = String(db.getSetting(key) || '').trim(); } catch (e) { v = ''; }
  return v || fallback || '';
}

/** ชื่อผู้ให้บริการ/ผู้ควบคุมข้อมูล */
function operatorName() {
  return settingValue('legal_operator', DEFAULT_OPERATOR);
}

/** อีเมลติดต่อสำหรับใช้สิทธิ PDPA (ต้องเป็นกล่องเมลจริงที่ผู้ให้บริการเปิดอ่าน) */
function contactEmail() {
  return settingValue('legal_email', FALLBACK_EMAIL);
}

/** ข้อมูลสำหรับหน้าถ้อยแถลง (สาธารณะ) */
function publicInfo() {
  return {
    version: PRIVACY_VERSION,
    updatedAt: PRIVACY_UPDATED_AT,
    operator: operatorName(),
    email: contactEmail(),
  };
}

module.exports = { PRIVACY_VERSION, PRIVACY_UPDATED_AT, operatorName, contactEmail, publicInfo };

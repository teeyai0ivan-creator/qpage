/**
 * guards.js — middleware ป้องกันหน้าเว็บ (ไม่ใช่ API)
 *  - adminGuard:   /admin/* ต้องเป็นแอดมิน
 *  - accountGuard: /dashboard, /settings ต้องล็อกอิน + ยืนยันเบอร์แล้ว
 *  - ownerGuard:   หน้าหลังบ้านบางหน้า สงวนไว้ให้เจ้าของระบบ
 *
 * ผู้ที่ไม่มีสิทธิ์จะถูก "พากลับ" ไปหน้าที่เหมาะกับตัวเอง ไม่แสดงหน้า 403 ให้เห็น
 */
'use strict';

const { getCurrentUser } = require('./auth');
const { isAdminRole, isOwner } = require('../lib/roles');

// ปลายทางของคนที่ไม่มีสิทธิ์เข้าหน้าหลังบ้าน = หน้าโปรไฟล์ของตัวเอง
const PROFILE_URL = '/settings/profile';

async function adminGuard(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl || '/admin/'));
  }
  // ผู้ใช้ทั่วไป/เจ้าของร้านที่เผลอเปิดหน้าหลังบ้าน → พาไปหน้าโปรไฟล์ของตัวเอง
  if (!isAdminRole(user.role)) {
    return res.redirect(PROFILE_URL);
  }
  next();
}

// เฉพาะเจ้าของระบบ (owner) — ใช้กับหน้าที่ผู้ดูแลระบบทั่วไป (admin) เข้าไม่ได้
async function ownerGuard(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl || '/admin/packages.html'));
  }
  if (!isOwner(user.role)) {
    // แอดมินทั่วไป: หน้านี้สงวนไว้ให้เจ้าของระบบ → กลับหน้าหลังบ้านของตัวเอง
    // ผู้ใช้ทั่วไป/เจ้าของร้าน → หน้าโปรไฟล์ของตัวเอง
    return res.redirect(isAdminRole(user.role) ? '/admin/' : PROFILE_URL);
  }
  next();
}

// บัญชีค้างกลางคัน (ยังไม่ยืนยันเบอร์) → พาไปทำขั้นตอนให้ครบก่อน
async function accountGuard(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl || '/settings/profile'));
  }
  if (user.status !== 'active') {
    const completeUrl = user.provider === 'google' ? '/google-setup.html' : '/register.html';
    return res.redirect(completeUrl);
  }
  next();
}

// พื้นที่ร้านค้า (/shop/*) — ต้องล็อกอินและบัญชี active (การเช็ค role ทำใน route/API)
async function shopGuard(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl || '/shop'));
  }
  if (user.status !== 'active') {
    const completeUrl = user.provider === 'google' ? '/google-setup.html' : '/register.html';
    return res.redirect(completeUrl);
  }
  next();
}

module.exports = { adminGuard, accountGuard, shopGuard, ownerGuard };

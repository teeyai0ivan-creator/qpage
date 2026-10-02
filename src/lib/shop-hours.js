/**
 * shop-hours.js — เวลาเปิด–ปิดร้าน + วันเปิดทำการ + "ปิดร้านวันนี้"
 *
 * เก็บในตาราง shops:
 *   open_time   TIME NULL      เวลาเปิด (ตามเวลาท้องถิ่นร้าน เช่น 09:00)
 *   close_time  TIME NULL      เวลาปิด (ถ้าน้อยกว่าเวลาเปิด = ปิดข้ามคืน เช่น 18:00–02:00)
 *   open_days   VARCHAR(20)    '1,2,3,4,5,6,7' โดย 1 = จันทร์ … 7 = อาทิตย์
 *   closed_date DATE NULL      วันที่กด "ปิดร้านวันนี้" (ระบบถือว่าปิดทั้งวันนั้น แล้วหมดอายุเองเมื่อขึ้นวันใหม่)
 *
 * ค่าเริ่มต้น (ยังไม่ตั้งอะไร) = เปิดตลอด ไม่จำกัดวัน — ร้านเดิมจึงใช้งานได้ต่อโดยไม่ต้องตั้งค่า
 */
'use strict';

// เวลาท้องถิ่นของร้าน (ไทย UTC+7) — ปรับได้ผ่าน env ถ้าไปใช้ที่อื่น
const TZ_OFFSET_MINUTES = Number(process.env.SHOP_TZ_OFFSET_MINUTES || 420);

const DAY_LABEL = ['', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์'];

/** เวลาท้องถิ่นร้านของ "ตอนนี้" (หรือเวลาที่ส่งเข้ามา) */
function shopNow(at) {
  const ms = (at ? new Date(at) : new Date()).getTime() + TZ_OFFSET_MINUTES * 60000;
  return new Date(ms);
}

/** 'YYYY-MM-DD' ของวันในเวลาท้องถิ่นร้าน */
function shopDate(at) {
  const d = shopNow(at);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

/** เลขวัน 1=จันทร์ … 7=อาทิตย์ (ตามเวลาท้องถิ่นร้าน) */
function shopDayNumber(at) {
  const jsDay = shopNow(at).getUTCDay();   // 0 = อาทิตย์
  return jsDay === 0 ? 7 : jsDay;
}

/** 'HH:MM' → จำนวนนาทีนับจากเที่ยงคืน (คืน null ถ้าไม่ใช่วันเวลา) */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * แปลงค่าคอลัมน์ DATE จากฐานข้อมูล → 'YYYY-MM-DD'
 * ⚠️ mysql2 คืนคอลัมน์ DATE เป็น Date object (ไม่ใช่สตริง) — ถ้าใช้ String(v) จะได้
 *    "Thu Oct 02 2026 …" แล้วเทียบวันไม่ตรง (เจอจริงตอนทำปุ่ม "ปิดร้านวันนี้")
 */
function dateKeyOf(v) {
  if (!v) return '';
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate());
  }
  return String(v).slice(0, 10);
}

/** นาทีของเวลาปัจจุบัน (เวลาท้องถิ่นร้าน) */
function nowMinutes(at) {
  const d = shopNow(at);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** วันเปิดทำการเป็นตัวเลข array เช่น [1,2,3,4,5] */
function parseOpenDays(v) {
  const raw = String(v == null || v === '' ? '1,2,3,4,5,6,7' : v);
  const days = raw.split(',').map((x) => Number(String(x).trim())).filter((n) => n >= 1 && n <= 7);
  return [...new Set(days)].sort((a, b) => a - b);
}

const openDaysText = (v) => parseOpenDays(v).map((d) => DAY_LABEL[d]).join(' · ');

/**
 * สถานะร้าน ณ เวลาหนึ่ง
 * @returns {{open:boolean, reason:''|'closed_today'|'closed_day'|'before_open'|'after_close', message:string,
 *            open_time:string, close_time:string, open_days:number[], open_days_text:string, today:string}}
 */
function openState(shop, at) {
  const openTime = shop && shop.open_time ? String(shop.open_time).slice(0, 5) : '';
  const closeTime = shop && shop.close_time ? String(shop.close_time).slice(0, 5) : '';
  const days = parseOpenDays(shop && shop.open_days);
  const today = shopDate(at);
  const dayNum = shopDayNumber(at);
  const base = {
    open_time: openTime, close_time: closeTime, open_days: days,
    open_days_text: openDaysText(shop && shop.open_days), today,
  };
  // 1) กด "ปิดร้านวันนี้" ไว้
  const closedDate = dateKeyOf(shop && shop.closed_date);
  if (closedDate && closedDate === today) {
    return Object.assign({ open: false, reason: 'closed_today', message: 'วันนี้ร้านปิดทำการ' }, base);
  }
  // 2) วันนี้ไม่อยู่ในวันเปิดทำการ
  if (days.length && !days.includes(dayNum)) {
    return Object.assign({ open: false, reason: 'closed_day', message: 'วันนี้ร้านปิดทำการ (เปิด ' + openDaysText(shop && shop.open_days) + ')' }, base);
  }
  // 3) ไม่ได้ตั้งเวลาเปิด–ปิด = เปิดตลอด
  const from = toMinutes(openTime);
  const to = toMinutes(closeTime);
  if (from == null || to == null || from === to) {
    return Object.assign({ open: true, reason: '', message: '' }, base);
  }
  const now = nowMinutes(at);
  const overnight = to < from;                     // ปิดข้ามคืน (เช่น 18:00–02:00)
  const isOpen = overnight ? (now >= from || now < to) : (now >= from && now < to);
  if (isOpen) return Object.assign({ open: true, reason: '', message: '' }, base);
  if (now < from) {
    return Object.assign({ open: false, reason: 'before_open', message: 'ร้านยังไม่เปิด — เปิด ' + openTime + '–' + closeTime }, base);
  }
  return Object.assign({ open: false, reason: 'after_close', message: 'ร้านปิดแล้ววันนี้ — เปิด ' + openTime + '–' + closeTime }, base);
}

module.exports = { openState, parseOpenDays, openDaysText, shopNow, shopDate, shopDayNumber, toMinutes, DAY_LABEL, TZ_OFFSET_MINUTES };

/**
 * print.js — ส่งงานพิมพ์เข้าเครื่องพิมพ์ (ใช้ร่วมกันทั้งหน้าจอหลักและตัวช่วยพิมพ์)
 *
 * หลักการ: หน้าเว็บที่พิมพ์เอง (ใบสั่งครัว/ใบเสร็จ/ป้าย QR) จะเรียก window.print()
 *          ตัวโปรแกรม "ดัก" แล้วมาที่นี่ → สั่งพิมพ์แบบเงียบไปเครื่องที่ตั้งไว้
 *
 * อ้างอิงสเปก Electron: pageSize ใช้หน่วยไมครอน (ขั้นต่ำ 353), margins ใช้พิกเซล
 *   - deviceName ต้องเป็น "ชื่อระบบ" ของเครื่องพิมพ์ (getPrintersAsync → name) ไม่ใช่ชื่อที่แสดง
 *   - ถ้าตั้ง 'auto' จะใช้ usePrinterDefaultPageSize = true (ให้ไดรเวอร์จัดการขนาดกระดาษเอง)
 */
'use strict';

// ขนาดกระดาษที่เลือกได้ในหน้าตั้งค่า
const PAPER = {
  // ⚠️ ทดสอบจริงบน Windows แล้ว: Chromium ไม่รับขนาดกระดาษที่กำหนดเอง (เช่น 80mm × 297mm)
  //    จะได้ error "Printing failed" เพราะ Windows ยอมรับเฉพาะขนาดที่ไดรเวอร์เครื่องพิมพ์ประกาศไว้
  //    วิธีที่ถูกต้องสำหรับม้วน 58/80mm: ตั้งขนาดกระดาษในไดรเวอร์การพิมพ์ของ Windows ครั้งเดียว
  //    แล้วให้โปรแกรมใช้ขนาดนั้น (usePrinterDefaultPageSize) — เสถียรที่สุดและใช้ได้จริง
  auto: { usePrinterDefaultPageSize: true, margins: { marginType: 'none' } },
  a4: { pageSize: 'A4', margins: { marginType: 'default' } },
  letter: { pageSize: 'Letter', margins: { marginType: 'default' } },
  legal: { pageSize: 'Legal', margins: { marginType: 'default' } },
};

// ค่าเริ่มต้นต่อชนิดเอกสาร: ใบครัว/ใบเสร็จ/ป้าย = ตามที่ตั้งในเครื่องพิมพ์ · เอกสารอื่น = A4
const DEFAULT_PAPER = { ticket: 'auto', receipt: 'auto', label: 'auto', other: 'a4' };

const KIND_LABEL = { ticket: 'ใบสั่งครัว', receipt: 'ใบเสร็จ', label: 'ป้าย QR', other: 'เอกสารอื่น' };

/** ชนิดเอกสารจากที่อยู่หน้าเว็บ */
function detectKind(url) {
  const u = String(url || '');
  if (u.includes('/shop/ticket.html')) return 'ticket';
  if (u.includes('/shop/receipt.html')) return 'receipt';
  if (u.includes('/shop/label.html')) return 'label';
  return 'other';
}

/**
 * สร้างตัวเลือกการพิมพ์ตามชนิดเอกสาร + ค่าตั้งของผู้ใช้
 * @param {'ticket'|'receipt'|'label'|'other'} kind
 * @param {object} settings ค่าจาก lib/settings
 * @param {boolean} silentOverride บังคับโหมดพิมพ์ (ใช้ตอนพิมพ์ทดสอบ)
 */
function buildOptions(kind, settings, silentOverride) {
  const cfg = (settings.printers && settings.printers[kind]) || {};
  // เผื่อค่าที่บันทึกไว้เป็นขนาดเก่าที่เลิกใช้แล้ว (58mm/80mm แบบกำหนดเอง) → ถอยไปใช้ค่าที่ถูกต้อง
  const paper = PAPER[cfg.paper] || PAPER[DEFAULT_PAPER[kind]] || PAPER.auto;
  const opts = {
    silent: silentOverride === undefined ? settings.silent !== false : Boolean(silentOverride),
    printBackground: true,       // ให้พื้นสี (หัวใบสั่งครัวสีส้ม) ติดไปด้วย
    margins: paper.margins,
  };
  if (paper.pageSize) opts.pageSize = paper.pageSize;
  if (paper.usePrinterDefaultPageSize) opts.usePrinterDefaultPageSize = true;
  // ชื่อเครื่องพิมพ์ว่าง = ใช้เครื่องพิมพ์เริ่มต้นของ Windows (พฤติกรรมของ Electron เมื่อ silent=true)
  if (cfg.device) opts.deviceName = cfg.device;
  return opts;
}

/**
 * สั่งพิมพ์เนื้อหาของ webContents หนึ่ง ๆ แล้วรอผล
 * @returns {Promise<{success:boolean, reason:string, kind:string, device:string, paper:string}>}
 */
function printContents(contents, kind, settings, silentOverride, timeoutMs = 25000) {
  const cfg = (settings.printers && settings.printers[kind]) || {};
  const opts = buildOptions(kind, settings, silentOverride);
  const meta = { kind, device: opts.deviceName || '(เครื่องพิมพ์เริ่มต้น)', paper: cfg.paper || '80mm' };
  return new Promise((resolve) => {
    let done = false;
    const finish = (success, reason) => {
      if (done) return;
      done = true;
      resolve(Object.assign({ success, reason: reason || '' }, meta));
    };
    // กันกรณีตัวจัดการพิมพ์ (spooler) ไม่ตอบ เช่น เครื่องพิมพ์ค้าง/ออฟไลน์ — ไม่ปล่อยให้ค้างตลอดไป
    const timer = setTimeout(() => finish(false, 'หมดเวลารอผลการพิมพ์ (เครื่องพิมพ์ไม่ตอบสนอง)'), timeoutMs);
    try {
      contents.print(opts, (success, failureReason) => {
        clearTimeout(timer);
        finish(success, failureReason);
      });
    } catch (err) {
      clearTimeout(timer);
      finish(false, err.message || 'สั่งพิมพ์ไม่สำเร็จ');
    }
  });
}

module.exports = { PAPER, DEFAULT_PAPER, KIND_LABEL, detectKind, buildOptions, printContents };

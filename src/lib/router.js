/**
 * router.js — สร้าง Express router ที่ "handler แบบ async โยน error แล้วไม่ค้าง"
 *
 * Express 4 ไม่ดัก error จาก handler แบบ async ให้ ถ้ามี error เกิดขึ้น (เช่น SQL ผิด)
 * คำขอจะค้างอยู่ตลอดไปโดยไม่ตอบกลับ — ฝั่งโปรแกรม/หน้าเว็บจะรอนานไม่มีที่สิ้นสุด
 * (เจอจริงจากหน้างาน: แก้ชื่อตัวเลือกอาหารแล้ว MySQL ฟ้อง "Column 'name' ... ambiguous")
 *
 * ใช้แทน express.Router() ในไฟล์เส้นทางทั้งหมด
 */
'use strict';

const express = require('express');
const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'all'];

function makeRouter() {
  const router = express.Router();
  for (const method of METHODS) {
    const register = router[method].bind(router);
    router[method] = (routePath, ...handlers) => register(routePath, ...handlers.map((h) => {
      // ปล่อย middleware/error handler (รับ 4 อาร์กิวเมนต์) และค่าที่ไม่ใช่ฟังก์ชันไว้ตามเดิม
      if (typeof h !== 'function' || h.length >= 4) return h;
      return function wrappedHandler(req, res, next) {
        try {
          const out = h(req, res, next);
          if (out && typeof out.then === 'function') out.catch(next);
        } catch (err) {
          next(err);
        }
      };
    }));
  }
  return router;
}

module.exports = { makeRouter };

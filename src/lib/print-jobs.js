/**
 * print-jobs.js — คิวงานพิมพ์สำหรับ "ตัวช่วยพิมพ์" (โปรแกรม Windows ที่ติดตั้งในร้าน)
 *
 * ปัญหาที่แก้: มือถือ/แท็บเล็ตสั่งพิมพ์เงียบเองไม่ได้ (ข้อจำกัดของเบราว์เซอร์ทุกตัว)
 * ทางออก: คอมที่ร้านติดตั้งโปรแกรมซึ่งคอยรับงาน แล้วพิมพ์เข้าปริ้นเตอร์ที่ครัวให้
 *
 * หลักการสำคัญ: **สร้างงานพิมพ์เฉพาะเมื่อมีตัวช่วยพิมพ์ออนไลน์ที่รับงานชนิดนั้นได้**
 *   - ไม่มีตัวช่วยพิมพ์ออนไลน์ → ไม่สร้างงาน (ไม่ค้างเป็นขยะในคิว)
 *   - คำขอที่มาจากเครื่องตัวช่วยพิมพ์เอง → ไม่สร้างงาน (เครื่องนั้นพิมพ์เองในเครื่องอยู่แล้ว กันพิมพ์ซ้ำ)
 *   - มอบงานให้ตัวช่วยพิมพ์ "เครื่องแรก" ที่รับชนิดนั้นได้ (หนึ่งงานพิมพ์ครั้งเดียว)
 */
'use strict';

const db = require('../db');
const realtime = require('./realtime');

/** รหัสเครื่องที่ส่งมากับคำขอ (โปรแกรม Windows แนบ header X-QPage-Device เสมอ) */
function deviceIdOf(req) {
  return String((req && (req.deviceId || req.get?.('x-qpage-device'))) || '').slice(0, 64);
}

/**
 * เข้าคิวงานพิมพ์ถ้ามีคนรับงานได้
 * @param {import('express').Request} req คำขอต้นทาง (ใช้รู้ว่าใครเป็นคนสั่งพิมพ์)
 * @param {{id:number}} shop ร้าน
 * @param {'ticket'|'receipt'|'label'} kind ชนิดเอกสาร
 * @param {{refId?:number, urlPath:string, tableCode?:string, billNo?:number|null}} info
 * @returns {Promise<number|null>} รหัสงานพิมพ์ (null = ไม่ต้องเข้าคิว)
 */
async function enqueue(req, shop, kind, info) {
  try {
    const source = deviceIdOf(req);
    const agents = await db.listActivePrintAgents(shop.id);
    // ตัวช่วยพิมพ์ที่รับงานชนิดนี้ได้ และไม่ใช่เครื่องที่สั่ง (เครื่องที่สั่งพิมพ์เองอยู่แล้ว)
    const candidates = agents.filter((a) => a.kinds.includes(kind) && a.device_id !== source);
    if (!candidates.length) return null;

    const jobId = await db.createPrintJob({
      shopId: shop.id,
      kind,
      refId: info.refId != null ? Number(info.refId) : null,
      urlPath: info.urlPath,
      tableCode: info.tableCode || '',
      billNo: info.billNo != null ? Number(info.billNo) : null,
      sourceDevice: source,
      agentDevice: candidates[0].device_id,
    });
    // แจ้งตัวช่วยพิมพ์ให้ดึงงานทันที (ไม่ต้องรอรอบโพล)
    realtime.publish(shop.id, 'print_job', { job_id: jobId, kind });
    return jobId;
  } catch (err) {
    // คิวพิมพ์ล้มเหลวห้ามทำให้การทำงานหลัก (เริ่มทำ/เช็คบิล) พัง
    console.error('⚠️ เข้าคิวงานพิมพ์ไม่สำเร็จ:', err.message);
    return null;
  }
}

module.exports = { enqueue, deviceIdOf };

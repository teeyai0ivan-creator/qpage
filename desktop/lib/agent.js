/**
 * agent.js — ตัวช่วยพิมพ์: รับงานพิมพ์จากมือถือ/แท็บเล็ตมาพิมพ์ที่เครื่องนี้
 *
 * ทำไมต้องมี: เบราว์เซอร์บนมือถือ/แท็บเล็ตพิมพ์เงียบเองไม่ได้ (ต้องมีคนกดยืนยันทุกครั้ง)
 * ทางออก: คอมที่ร้านเปิดโปรแกรมนี้ค้างไว้ → ลงทะเบียนกับเซิร์ฟเวอร์ → เมื่อมีคนกด "เริ่มทำ"
 *         จากเครื่องอื่น เซิร์ฟเวอร์จะส่งงานมาให้เครื่องนี้พิมพ์เข้าปริ้นเตอร์ที่ครัวให้ทันที
 *
 * การทำงาน
 *   1) ลงทะเบียน + heartbeat ทุก 30 วิ (บอกว่ายังออนไลน์อยู่ และรับงานชนิดไหนได้)
 *   2) ฟังเหตุการณ์เรียลไทม์ (SSE) จากเซิร์ฟเวอร์เพื่อรู้ทันทีที่มีงาน + ดึงงานค้างเป็นระยะ (กันตกหล่น)
 *   3) เปิดงานใน "หน้าต่างซ่อน" (ใช้ session เดียวกัน) → หน้าเว็บสั่งพิมพ์เอง → ดักแล้วพิมพ์เงียบ
 *   4) รายงานผลกลับเซิร์ฟเวอร์ (สำเร็จ/ล้มเหลว) แล้วปิดหน้าต่าง
 */
'use strict';

const { BrowserWindow } = require('electron');
const path = require('node:path');
const print = require('./print');

const HEARTBEAT_MS = 30000;   // บอกเซิร์ฟเวอร์ว่ายังออนไลน์
const POLL_MS = 20000;        // ดึงงานค้างเป็นระยะ (SSE อาจหลุด)
const PRINT_WAIT_MS = 15000;  // รอให้หน้าเว็บสั่งพิมพ์ (หน้ายิงพิมพ์เองหลังเรนเดอร์ ~500ms)

class PrintAgent {
  /**
   * @param {{getSettings:Function, session:Function, onLog:Function, onJob:Function, attachPrintHook:Function}} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.timer = null;
    this.stream = null;
    this.stopped = null;
    this.printing = false;          // พิมพ์ทีละงาน (กันคิวทับกันที่ปริ้นเตอร์)
    this.missCount = 0;
  }

  base() {
    return String(this.deps.getSettings().serverUrl || '').replace(/\/+$/, '');
  }

  deviceId() {
    return this.deps.getSettings().deviceId || '';
  }

  /** ชนิดงานที่ผู้ใช้เปิดให้รับจากมือถือ/แท็บเล็ต */
  kinds() {
    const k = this.deps.getSettings().kinds || {};
    return Object.keys(k).filter((x) => k[x]);
  }

  log(msg) {
    if (this.deps.onLog) this.deps.onLog(msg);
    console.log('[agent] ' + msg);
  }

  start() {
    const kinds = this.kinds();
    if (!kinds.length) {
      this.log('ยังไม่เปิดรับงานพิมพ์จากมือถือ/แท็บเล็ต (เปิดได้ที่หน้าตั้งค่า)');
      return;
    }
    this.stop();
    this.stopped = false;
    this.register().catch(() => {});
    this.openStream();
    this.timer = setInterval(() => {
      this.register().catch(() => {});
      this.pull().catch(() => {});
    }, Math.min(HEARTBEAT_MS, POLL_MS));
    this.log('เริ่มทำงาน — รับงาน: ' + kinds.map((k) => print.KIND_LABEL[k] || k).join(', '));
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.stream) { try { this.stream.abort(); } catch (e) { /* ข้าม */ } this.stream = null; }
  }

  /** ลงทะเบียน/ยืนยันว่ายังออนไลน์ + รับงานชนิดไหนได้ */
  async register() {
    const session = this.deps.session();
    const kinds = this.kinds();
    if (!session || !kinds.length) return;
    const res = await session.fetch(this.base() + '/api/shop/print-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-QPage-Device': this.deviceId() },
      body: JSON.stringify({ deviceId: this.deviceId(), label: this.deps.getSettings().label || '', kinds }),
    });
    if (!res.ok) {
      const who = res.status === 401 || res.status === 403 ? 'ยังไม่ได้เข้าสู่ระบบในโปรแกรม (เข้าสู่ระบบก่อนจึงรับงานพิมพ์ได้)' : 'HTTP ' + res.status;
      if (this.missCount++ % 10 === 0) this.log('ลงทะเบียนไม่สำเร็จ: ' + who);
      return;
    }
    this.missCount = 0;
  }

  /** งานที่รอพิมพ์ */
  async pull() {
    const session = this.deps.session();
    if (!session || this.stopped) return [];
    const res = await session.fetch(this.base() + '/api/shop/print-jobs?deviceId=' + encodeURIComponent(this.deviceId()), {
      headers: { 'X-QPage-Device': this.deviceId() },
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    const jobs = (data && data.jobs) || [];
    for (const job of jobs) await this.handle(job);
    return jobs;
  }

  /** ฟังเหตุการณ์จากเซิร์ฟเวอร์ (SSE) — ใช้ fetch แบบสตรีม แล้วดึงงานเมื่อได้อีเวนต์ print_job */
  async openStream() {
    const session = this.deps.session();
    if (!session) return;
    try {
      const res = await session.fetch(this.base() + '/api/shop/events', {
        headers: { Accept: 'text/event-stream', 'X-QPage-Device': this.deviceId() },
      });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      this.stream = res.body.getReader ? res : null;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      this.log('เชื่อมต่อเหตุการณ์เรียลไทม์แล้ว');
      for (;;) {
        const { value, done } = await reader.read();
        if (done || this.stopped) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split('\n\n');
        buf = blocks.pop() || '';
        for (const block of blocks) {
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          let evt = null;
          try { evt = JSON.parse(line.slice(6)); } catch (e) { evt = null; }
          if (evt && evt.type === 'print_job') this.pull().catch(() => {});
        }
      }
    } catch (err) {
      if (!this.stopped) this.log('การเชื่อมต่อเรียลไทม์หลุด (' + err.message + ') — จะลองใหม่');
    }
    if (!this.stopped) setTimeout(() => this.openStream(), 5000);
  }

  /** พิมพ์งานหนึ่งงานผ่านหน้าต่างซ่อน */
  async handle(job) {
    if (this.stopped || this.printing) return;
    this.printing = true;
    let win = null;
    try {
      const cfg = this.deps.getSettings();
      const url = this.base() + job.url_path;
      win = new BrowserWindow({
        show: false,
        width: 900,
        height: 1400,
        webPreferences: {
          partition: 'persist:qpage',
          preload: path.join(__dirname, '..', 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,   // หน้าต่างซ่อนต้องไม่ถูกหน่วงเวลา (ไม่งั้นพิมพ์ช้า/ไม่ยิง)
        },
      });
      if (this.deps.onJob) this.deps.onJob(job, win, null);
      await win.loadURL(url);
      // หน้าเว็บจะเรียก print() เองหลังเรนเดอร์ — ดักไว้ที่ main.js แล้ว (attachPrintHook)
      const r = await this.deps.attachPrintHook(win.webContents, job);
      await this.report(job, r && r.success ? 'printed' : 'failed', r && r.reason);
    } catch (err) {
      this.log('พิมพ์งาน #' + job.id + ' ไม่สำเร็จ: ' + err.message);
      await this.report(job, 'failed', err.message);
    } finally {
      if (win && !win.isDestroyed()) win.destroy();
      this.printing = false;
    }
  }

  async report(job, status, error) {
    const session = this.deps.session();
    if (!session) return;
    try {
      await session.fetch(this.base() + '/api/shop/print-jobs/' + job.id + '/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-QPage-Device': this.deviceId() },
        body: JSON.stringify({ status, error: error || '' }),
      });
      this.log('งาน #' + job.id + ' (' + (print.KIND_LABEL[job.kind] || job.kind) + ') → ' + (status === 'printed' ? 'พิมพ์สำเร็จ' : 'พิมพ์ไม่สำเร็จ: ' + (error || '')));
    } catch (err) {
      this.log('รายงานผลการพิมพ์ไม่สำเร็จ: ' + err.message);
    }
  }
}

module.exports = { PrintAgent, PRINT_WAIT_MS };

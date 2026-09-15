/* ตัวช่วยที่ใช้ร่วมกันทุกหน้าฝั่งร้าน/หน้าลูกค้า (ไม่ต้องมี build step — โหลดด้วย <script src="/js/shop-ui.js">)
   แต่ละหน้าเคยประกาศตัวช่วยเหล่านี้ซ้ำกันเอง รวมไว้ที่เดียวเพื่อแก้ที่เดียวจบ
   หมายเหตุ: หน้าที่ต้องการตัวเลขแบบไม่มีสัญลักษณ์ ฿ (menus.html, purchase.html) ใช้ moneyNum ของตัวเอง */
(function () {
  const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  // กัน HTML injection ก่อนเอาไปใส่ innerHTML
  window.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => HTML_ESC[c]);

  // เงินแบบมีสัญลักษณ์ ฿ (ทศนิยมไม่เกิน 2 ตำแหน่ง)
  window.money = (n) => '฿' + Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  // เลขที่บิล #0001
  window.billNoFmt = (n) => (n ? '#' + String(n).padStart(4, '0') : '—');

  // วันเวลาแบบสั้นจาก ISO (วินาทีเป็น UTC ตามที่ฐานข้อมูลเก็บ)
  window.dt = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };

  // นับ "รายการ" เป็นจำนวนจาน (ผลรวม quantity) ให้ตรงกันทุกหน้า
  window.platesOf = (items) => (items || []).reduce((n, it) => n + (Number(it.quantity) || 0), 0);

  // เปิดแท็บเปล่าล่วงหน้าพร้อมข้อความ "กำลังเช็คบิล..." (ต้องเรียกจังหวะที่ผู้ใช้กดจริง ไม่งั้นเบราว์เซอร์บล็อกป๊อปอัป)
  window.openBlankTab = () => {
    const w = window.open('', '_blank');
    try {
      if (w && w.document) {
        w.document.write('<!doctype html><meta charset="utf-8"><title>กำลังเช็คบิล...</title><body style="font-family:Sarabun,Tahoma,sans-serif;padding:24px;color:#475467">กำลังเช็คบิล... กรุณารอสักครู่</body>');
        w.document.close();
      }
    } catch (e) { /* ข้าม */ }
    return w;
  };

  // พาแท็บที่เปิดล่วงหน้าไปหน้าใบเสร็จ · ป๊อปอัปถูกบล็อก → เปิดในแท็บนี้ (ลองซ้ำกันแท็บเปล่าค้าง)
  window.gotoReceipt = (w, url) => {
    if (!w) { location.href = url; return; }
    try { w.location.href = url; } catch (e) { location.href = url; return; }
    setTimeout(() => { try { if (w.location.href === 'about:blank') w.location.href = url; } catch (e) { /* ข้าม */ } }, 800);
  };

  // ---------------------------------------------------------------------------
  // กล่องยืนยัน / แจ้งเตือน / กรอกข้อความ — หน้าตาเป็น UI ของเว็บ (ไม่ใช้กล่องของเบราว์เซอร์)
  // ใช้: await uiConfirm({ title, message, ok, cancel, danger }) → true/false
  //      await uiPrompt({ title, label, value, ok })               → ข้อความ/ null
  //      await uiAlert({ title, message, ok })                     → true
  // ---------------------------------------------------------------------------
  const DIALOG_CSS = [
    '.uidlg-overlay{position:fixed;inset:0;background:rgba(16,24,40,.45);display:flex;align-items:center;justify-content:center;padding:18px;z-index:300;opacity:0;transition:opacity .15s ease;}',
    '.uidlg-overlay.show{opacity:1;}',
    '.uidlg{width:100%;max-width:420px;background:var(--surface,#fff);color:var(--text,#101828);border-radius:16px;box-shadow:0 18px 44px rgba(16,24,40,.22);padding:22px;font-family:var(--font,"Sarabun",Tahoma,Arial,sans-serif);transform:translateY(6px);transition:transform .15s ease;}',
    '.uidlg-overlay.show .uidlg{transform:translateY(0);}',
    '.uidlg h3{margin:0;font-size:17px;font-weight:800;letter-spacing:-.2px;}',
    '.uidlg p{margin:9px 0 0;font-size:13.5px;color:var(--muted,#667085);line-height:1.75;white-space:pre-line;}',
    '.uidlg-body{margin-top:14px;}',
    '.uidlg-body label{display:block;font-size:13px;font-weight:600;color:var(--text,#101828);margin-bottom:7px;}',
    '.uidlg-body input{width:100%;box-sizing:border-box;font-family:inherit;font-size:15px;padding:11px 14px;border-radius:10px;border:1px solid var(--border,#e4e7ec);background:var(--surface,#fff);color:var(--text,#101828);outline:none;}',
    '.uidlg-body input:focus{border-color:var(--accent,#6366f1);box-shadow:0 0 0 3px var(--ring,rgba(99,102,241,.18));}',
    '.uidlg-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:18px;flex-wrap:wrap;}',
    '.uidlg-btn{font-family:inherit;font-size:13px;font-weight:700;padding:9px 16px;border-radius:10px;border:1px solid var(--border-strong,#d0d5dd);background:var(--surface,#fff);color:var(--text,#101828);cursor:pointer;}',
    '.uidlg-btn:hover{background:var(--surface-hover,#f2f4f7);}',
    '.uidlg-btn.primary{background:var(--accent-gradient,linear-gradient(135deg,#6366f1,#8b5cf6));border:none;color:#fff;}',
    '.uidlg-btn.danger{background:var(--danger,#d92d20);border:none;color:#fff;}',
  ].join('');

  function uiDialog(opts) {
    const o = opts || {};
    if (!document.getElementById('uidlgStyle')) {
      const st = document.createElement('style');
      st.id = 'uidlgStyle';
      st.textContent = DIALOG_CSS;
      document.head.appendChild(st);
    }
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'uidlg-overlay';
      const box = document.createElement('div');
      box.className = 'uidlg';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');

      const h = document.createElement('h3');
      h.textContent = o.title || (o.input ? 'กรอกข้อมูล' : (o.cancel ? 'ยืนยัน' : 'แจ้งเตือน'));
      box.appendChild(h);

      if (o.message) {
        const p = document.createElement('p');
        p.textContent = o.message;
        box.appendChild(p);
      }

      let input = null;
      if (o.input) {
        const body = document.createElement('div');
        body.className = 'uidlg-body';
        const lb = document.createElement('label');
        lb.textContent = o.label || '';
        input = document.createElement('input');
        input.type = 'text';
        input.value = o.value == null ? '' : String(o.value);
        input.maxLength = o.maxLength || 60;
        input.setAttribute('autocomplete', 'off');
        if (o.placeholder) input.placeholder = o.placeholder;
        body.appendChild(lb);
        body.appendChild(input);
        box.appendChild(body);
      }

      const actions = document.createElement('div');
      actions.className = 'uidlg-actions';
      let cancelBtn = null;
      if (o.cancel !== false) {
        cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'uidlg-btn cancel';
        cancelBtn.textContent = o.cancelText || 'ยกเลิก';
        actions.appendChild(cancelBtn);
      }
      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'uidlg-btn ' + (o.danger ? 'danger' : 'primary') + ' ok';
      okBtn.textContent = o.okText || (o.cancel === false ? 'ตกลง' : 'ยืนยัน');
      actions.appendChild(okBtn);
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      let done = false;
      function close(result) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey);
        overlay.classList.remove('show');
        setTimeout(() => overlay.remove(), 160);
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(o.input ? null : (o.cancel === false ? true : false)); }
      }
      okBtn.addEventListener('click', () => close(o.input ? (input.value.trim() || null) : true));
      if (cancelBtn) cancelBtn.addEventListener('click', () => close(o.input ? null : false));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(o.input ? null : (o.cancel === false ? true : false)); });
      if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); } });
      document.addEventListener('keydown', onKey);

      requestAnimationFrame(() => overlay.classList.add('show'));
      if (input) setTimeout(() => { input.focus(); input.select(); }, 60);
      else setTimeout(() => okBtn.focus(), 60);
    });
  }

  window.uiConfirm = (opts) => uiDialog(Object.assign({ cancel: true }, opts));
  window.uiAlert = (opts) => uiDialog(Object.assign({ cancel: false, okText: 'ตกลง' }, opts));
  window.uiPrompt = (opts) => uiDialog(Object.assign({ input: true, cancel: true, okText: 'บันทึก' }, opts));
})();

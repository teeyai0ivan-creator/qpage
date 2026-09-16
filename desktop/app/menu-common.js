/**
 * menu-common.js — ส่วนกลางที่หน้าจอ "เมนูทั้งหมด" และ "จัดการเมนู" ใช้ร่วมกัน
 *   - ตัวช่วยเล็ก ๆ (ข้อความ/เงิน/แจ้งเตือน/กล่องยืนยัน/โหลดรูป)
 *   - หน้าต่างเพิ่ม/แก้ไขเมนู (ชื่อ · ราคา · หมวดหมู่ · รูป · พร้อมขาย · กลุ่มตัวเลือก)
 * ใช้เป็นสคริปต์ธรรมดา (ไม่ใช่โมดูล) แล้วเรียกผ่าน window.MenuKit
 */
'use strict';

(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '฿' + Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const EMPTY_IMG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96'%3E%3Crect width='96' height='96' fill='%23eef0fa'/%3E%3C/svg%3E";

  function toast(msg, ms) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('show'), ms || 3200);
  }

  /** กล่องยืนยันของโปรแกรม */
  function confirmAsk(title, message, okText) {
    const ov = document.getElementById('askOverlay');
    document.getElementById('askTitle').textContent = title;
    document.getElementById('askMsg').textContent = message;
    document.getElementById('askOk').textContent = okText || 'ยืนยัน';
    ov.classList.add('show');
    return new Promise((resolve) => {
      document.getElementById('askOk').onclick = () => { ov.classList.remove('show'); resolve(true); };
      document.getElementById('askCancel').onclick = () => { ov.classList.remove('show'); resolve(false); };
    });
  }

  /** ชื่อหมวดหมู่ของเมนู (แสดงเป็น "หมวดหลัก › หมวดย่อย") */
  function categoryPath(categories, categoryId) {
    const c = categories.find((x) => Number(x.id) === Number(categoryId));
    if (!c) return 'ไม่ระบุหมวด';
    if (c.parent_id) {
      const p = categories.find((x) => Number(x.id) === Number(c.parent_id));
      return (p ? p.name + ' › ' : '') + c.name;
    }
    return c.name;
  }

  /** รายการหมวดหมู่สำหรับ <select> (หมวดย่อยเยื้องเข้ามา) */
  function categoryOptions(categories, selectedId) {
    const mains = categories.filter((c) => !c.parent_id);
    const out = ['<option value="">ไม่ระบุหมวด</option>'];
    for (const m of mains) {
      out.push(`<option value="${m.id}"${Number(selectedId) === Number(m.id) ? ' selected' : ''}>${esc(m.name)}</option>`);
      for (const s of categories.filter((c) => Number(c.parent_id) === Number(m.id))) {
        out.push(`<option value="${s.id}"${Number(selectedId) === Number(s.id) ? ' selected' : ''}>&nbsp;&nbsp;↳ ${esc(s.name)}</option>`);
      }
    }
    return out.join('');
  }

  /** กล่องกรอกข้อความของโปรแกรม (⚠️ Electron ไม่รองรับ window.prompt) */
  function askForm(title, fields, okText) {
    ensureModal();          // กล่องถูกสร้างพร้อมหน้าต่างแก้ไขเมนู — ถ้ายังไม่เคยเปิด ต้องสร้างก่อนใช้
    const ov = document.getElementById('formOverlay');
    document.getElementById('formTitle').textContent = title;
    document.getElementById('formFields').innerHTML = fields.map((f) => {
      if (f.type === 'checkbox') {
        return `<label class="sw" style="gap:8px;margin:2px 0;"><input type="checkbox" data-k="${esc(f.key)}" ${f.value ? 'checked' : ''}><span class="track"></span><span class="hint" style="margin:0;">${esc(f.label)}</span></label>`;
      }
      return `<div class="field"><label class="lbl">${esc(f.label)}</label>
        <input class="inp${f.type === 'number' ? ' mono' : ''}" data-k="${esc(f.key)}" type="${f.type === 'number' ? 'number' : 'text'}"
          ${f.type === 'number' ? 'step="0.01"' : ''} value="${esc(f.value == null ? '' : f.value)}" placeholder="${esc(f.placeholder || '')}"></div>`;
    }).join('');
    document.getElementById('formErr').textContent = '';
    document.getElementById('formOk').textContent = okText || 'บันทึก';
    ov.classList.add('show');
    const first = document.querySelector('#formFields input');
    if (first) setTimeout(() => first.focus(), 60);
    return new Promise((resolve) => {
      const collect = () => {
        const out = {};
        document.querySelectorAll('#formFields [data-k]').forEach((el) => {
          out[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value.trim();
        });
        return out;
      };
      document.getElementById('formOk').onclick = () => {
        const values = collect();
        const bad = fields.find((f) => f.required && (f.type === 'checkbox' ? false : !values[f.key]));
        if (bad) { document.getElementById('formErr').textContent = 'กรุณากรอก: ' + bad.label; return; }
        ov.classList.remove('show');
        resolve(values);
      };
      document.getElementById('formCancel').onclick = () => { ov.classList.remove('show'); resolve(null); };
      document.getElementById('formOverlay').onclick = (e) => { if (e.target === ov) { ov.classList.remove('show'); resolve(null); } };
    });
  }

  /** คำย่อของ askForm สำหรับแก้ค่าเดียว */
  function askText(title, value, label, type) {
    return askForm(title, [{ key: 'v', label, value, type: type || 'text', required: true }]).then((r) => (r ? r.v : null));
  }

  // -------------------------------------------------------------------------
  // หน้าต่างเพิ่ม/แก้ไขเมนู
  // -------------------------------------------------------------------------
  let ctx = null;   // { menu, categories, allGroups, menuGroups, withGroups, onSaved }

  function ensureModal() {
    if (document.getElementById('menuEditOverlay')) return;
    const form = document.createElement('div');
    form.innerHTML = `
      <div class="overlay" id="formOverlay">
        <div class="modal narrow">
          <h3 id="formTitle">แก้ไข</h3>
          <div id="formFields" style="display:flex;flex-direction:column;gap:10px;"></div>
          <div class="err" id="formErr"></div>
          <div class="foot">
            <button class="btn" id="formCancel" type="button">ยกเลิก</button>
            <button class="btn btn-primary" id="formOk" type="button">บันทึก</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(form.firstElementChild);

    const box = document.createElement('div');
    box.innerHTML = `
      <div class="overlay" id="menuEditOverlay">
        <div class="modal">
          <h3 id="meTitle">เพิ่มเมนู</h3>
          <div style="display:flex;gap:14px;flex-wrap:wrap;">
            <div style="display:flex;flex-direction:column;gap:8px;align-items:center;">
              <img class="thumb-lg" id="meImg" alt="รูปเมนู">
              <input type="file" id="meImgFile" accept="image/png,image/jpeg,image/webp,image/gif" style="font-size:12.5px;max-width:180px;">
              <button class="btn btn-sm" id="meImgClear" type="button">ลบรูป</button>
            </div>
            <div style="flex:1;min-width:260px;display:flex;flex-direction:column;gap:10px;">
              <div class="field">
                <label class="lbl" for="meName">ชื่อเมนู *</label>
                <input class="inp" id="meName" maxlength="150" placeholder="เช่น ผัดไทยกุ้งสด">
              </div>
              <div class="grid2">
                <div class="field">
                  <label class="lbl" for="mePrice">ราคา (บาท) *</label>
                  <input class="inp mono" id="mePrice" type="number" min="0" step="0.01" placeholder="0">
                </div>
                <div class="field">
                  <label class="lbl" for="meCat">หมวดหมู่</label>
                  <select class="inp" id="meCat"></select>
                </div>
              </div>
              <div class="field">
                <label class="lbl" for="meDesc">รายละเอียด (แสดงใต้ชื่อเมนู)</label>
                <textarea class="inp" id="meDesc" maxlength="500" placeholder="เช่น เส้นใหญ่ กุ้งสด ไข่ 2 ฟอง"></textarea>
              </div>
              <label class="sw"><input type="checkbox" id="meAvail" checked><span class="track"></span><span id="meAvailLabel">พร้อมขาย</span></label>
            </div>
          </div>
          <div class="field" id="meGroupsWrap" style="display:none;">
            <label class="lbl">กลุ่มตัวเลือกที่ใช้กับเมนูนี้ (เช่น ระดับความเผ็ด)</label>
            <div id="meGroups" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;"></div>
          </div>
          <div class="err" id="meErr"></div>
          <div class="foot">
            <button class="btn" id="meCancel" type="button">ยกเลิก</button>
            <button class="btn btn-primary" id="meSave" type="button">บันทึก</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(box.firstElementChild);
    wire();
  }

  function wire() {
    const $ = (id) => document.getElementById(id);
    $('meAvail').addEventListener('change', () => { $('meAvailLabel').textContent = $('meAvail').checked ? 'พร้อมขาย' : 'ของหมด'; });
    $('meCancel').addEventListener('click', close);
    $('menuEditOverlay').addEventListener('click', (e) => { if (e.target === $('menuEditOverlay')) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    $('meImgClear').addEventListener('click', () => { ctx.imageUrl = ''; $('meImg').src = EMPTY_IMG; });
    $('meImgFile').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.size > 3 * 1024 * 1024) { $('meErr').textContent = 'ไฟล์ใหญ่เกิน 3MB'; e.target.value = ''; return; }
      const reader = new FileReader();
      reader.onload = async () => {
        $('meErr').textContent = '';
        try {
          const url = await window.qpageShop.upload(String(reader.result));
          ctx.imageUrl = url;
          $('meImg').src = String(reader.result);
          toast('อัปโหลดรูปแล้ว — อย่าลืมกดบันทึก');
        } catch (err) { $('meErr').textContent = 'อัปโหลดรูปไม่สำเร็จ: ' + err.message; }
        finally { e.target.value = ''; }
      };
      reader.readAsDataURL(file);
    });
    $('meSave').addEventListener('click', save);
  }

  /** เปิดหน้าต่าง (menu = null คือเพิ่มใหม่) */
  async function open(opts) {
    ensureModal();
    const $ = (id) => document.getElementById(id);
    ctx = {
      menu: opts.menu || null,
      categories: opts.categories || [],
      allGroups: opts.allGroups || [],
      menuGroups: opts.menuGroups || [],
      withGroups: !!opts.withGroups,
      onSaved: opts.onSaved || function () {},
      imageUrl: (opts.menu && opts.menu.image_url) || '',
    };
    $('meTitle').textContent = ctx.menu ? 'แก้ไขเมนู' : 'เพิ่มเมนู';
    $('meName').value = ctx.menu ? (ctx.menu.name || '') : '';
    $('mePrice').value = ctx.menu ? Number(ctx.menu.price || 0) : '';
    $('meDesc').value = ctx.menu ? (ctx.menu.description || '') : '';
    $('meCat').innerHTML = categoryOptions(ctx.categories, ctx.menu && ctx.menu.category_id);
    $('meAvail').checked = ctx.menu ? Number(ctx.menu.available) === 1 : true;
    $('meAvailLabel').textContent = $('meAvail').checked ? 'พร้อมขาย' : 'ของหมด';
    $('meErr').textContent = '';
    $('meImg').src = EMPTY_IMG;
    $('meGroupsWrap').style.display = ctx.withGroups ? '' : 'none';
    if (ctx.withGroups) {
      const chosen = new Set(ctx.menuGroups.filter((g) => Number(g.menu_id) === Number(ctx.menu && ctx.menu.id)).map((g) => Number(g.group_id)));
      $('meGroups').innerHTML = ctx.allGroups.length
        ? ctx.allGroups.map((g) => `<label class="pick"><input type="checkbox" value="${g.id}" ${chosen.has(Number(g.id)) ? 'checked' : ''}><span>${esc(g.name)}${Number(g.required) === 1 ? ' <span class="badge">บังคับ</span>' : ''}</span></label>`).join('')
        : '<div class="hint" style="margin:0;">ยังไม่มีกลุ่มตัวเลือก — สร้างได้ที่หน้าจอ "จัดการเมนู"</div>';
    }
    $('menuEditOverlay').classList.add('show');
    setTimeout(() => $('meName').focus(), 60);
    if (ctx.imageUrl) {
      try { const d = await window.qpageShop.imageData(ctx.imageUrl); if (d) $('meImg').src = d; } catch (e) { /* รูปเก่าโหลดไม่ได้ */ }
    }
  }

  function close() {
    const ov = document.getElementById('menuEditOverlay');
    if (ov) ov.classList.remove('show');
    ctx = null;
  }

  async function save() {
    if (!ctx) return;
    const $ = (id) => document.getElementById(id);
    const name = $('meName').value.trim();
    const price = Number($('mePrice').value);
    if (!name) { $('meErr').textContent = 'กรุณากรอกชื่อเมนู'; return; }
    if (!Number.isFinite(price) || price < 0) { $('meErr').textContent = 'ราคาไม่ถูกต้อง'; return; }
    const fields = {
      name,
      price,
      description: $('meDesc').value.trim(),
      categoryId: $('meCat').value || null,
      available: $('meAvail').checked,
      imageUrl: ctx.imageUrl,
    };
    const btn = $('meSave');
    btn.disabled = true;
    $('meErr').textContent = '';
    try {
      const API = window.qpageShop;
      let id = ctx.menu && ctx.menu.id;
      if (id) { await API.updateMenu(id, fields); } else { const r = await API.addMenu(fields); id = r.id; }
      if (ctx.withGroups) {
        const ids = [...$('meGroups').querySelectorAll('input:checked')].map((el) => Number(el.value));
        await API.setMenuGroups(id, ids);
      }
      const wasEdit = !!ctx.menu;
      const after = ctx.onSaved;
      close();
      toast(wasEdit ? 'บันทึกเมนูแล้ว' : 'เพิ่มเมนูแล้ว');
      await after();
    } catch (err) {
      $('meErr').textContent = err.message;
    } finally { btn.disabled = false; }
  }

  window.MenuKit = {
    esc, money, toast, confirmAsk, askForm, askText, categoryPath, categoryOptions,
    EMPTY_IMG, openMenuEditor: open, closeMenuEditor: close,
  };
})();

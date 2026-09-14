/**
 * side-menu.js — เปิด/ปิดเมนูด้านซ้ายบนมือถือ (ใช้ร่วมได้ทุกโซน)
 *
 * วิธีใช้: ใส่ <script src="/js/side-menu.js" data-key="..." data-panel="..."></script>
 *   data-key   คีย์ที่ใช้จำสถานะใน localStorage (ค่าเริ่มต้น: qpage_side_menu)
 *   data-panel ซีเล็กเตอร์ของเมนูด้านซ้าย (ค่าเริ่มต้น: .admin-sidebar)
 *
 * ต้องมีปุ่ม id="menuToggle" อยู่ในหน้า — ปุ่มจะแสดงเฉพาะจอมือถือ (คุมด้วย CSS)
 * ทำงานร่วมกับ CSS: body.side-menu-closed = ปิดเมนู, .side-menu-backdrop = ฉากมืดด้านหลัง
 */
(function () {
  var me = document.currentScript;
  var KEY = (me && me.dataset.key) || 'qpage_side_menu';
  var PANEL = (me && me.dataset.panel) || '.admin-sidebar';
  var MOBILE_MAX = 900;

  var btn = document.getElementById('menuToggle');
  var panel = document.querySelector(PANEL);
  if (!btn || !panel) return;

  function applyMenu(open) {
    document.body.classList.toggle('side-menu-closed', !open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function saveMenu(open) { try { localStorage.setItem(KEY, open ? 'open' : 'closed'); } catch (e) { /* ข้าม */ } }
  function isMobile() { return window.innerWidth <= MOBILE_MAX; }
  function closeMenu() { applyMenu(false); saveMenu(false); }

  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* ข้าม */ }
  // ค่าเริ่มต้น: จอใหญ่เปิดเมนู จอมือถือซ่อนไว้ก่อน (จำค่าที่ผู้ใช้เลือกไว้ในเครื่อง)
  applyMenu(saved ? saved === 'open' : !isMobile());

  btn.addEventListener('click', function () { var open = document.body.classList.contains('side-menu-closed'); applyMenu(open); saveMenu(open); });

  // ความสูงจริงของแถบหัว (ถ้ามี) → ใช้เป็นจุดเริ่มของแผงเมนู
  function syncNavHeight() {
    var nav = document.querySelector('.site-nav');
    if (nav) document.documentElement.style.setProperty('--nav-h', Math.round(nav.getBoundingClientRect().height) + 'px');
  }
  syncNavHeight();
  window.addEventListener('resize', syncNavHeight);

  // ฉากมืดด้านหลัง — แตะแล้วปิด
  var back = document.createElement('div');
  back.className = 'side-menu-backdrop';
  document.body.appendChild(back);
  back.addEventListener('click', closeMenu);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });
  // เลือกเมนูแล้วปิดแผงบนมือถือ
  panel.querySelectorAll('a, button').forEach(function (el) { el.addEventListener('click', function () { if (isMobile()) closeMenu(); }); });
})();

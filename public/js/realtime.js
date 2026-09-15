/* ตัวช่วยฝั่งเบราว์เซอร์: เชื่อมต่อ SSE กับเซิร์ฟเวอร์ แล้วแจ้งหน้าเว็บให้รีเฟรชข้อมูลทันที
   ใช้: shopLive({ onEvent: (ev) => { ... } })  — ev.type = order_new | item_status | bill_changed | checkout | tables_changed */
(function () {
  'use strict';

  window.shopLive = function (opts) {
    const o = opts || {};
    const onEvent = typeof o.onEvent === 'function' ? o.onEvent : function () {};
    const waitMs = Number(o.debounce) > 0 ? Number(o.debounce) : 250; // รวมเหตุการณ์ที่มาถี่ ๆ ให้เรียกครั้งเดียว
    let es = null;
    let timer = null;
    let closed = false;
    let lastType = '';

    window.__liveState = 'connecting';

    function fire(ev) {
      lastType = ev && ev.type ? ev.type : '';
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        try { onEvent({ type: lastType }); } catch (e) { /* หน้าเว็บจัดการเอง */ }
      }, waitMs);
    }

    function connect() {
      if (closed) return;
      try { es = new EventSource('/api/shop/events'); }
      catch (e) { window.__liveState = 'unsupported'; return; }
      es.onopen = function () { window.__liveState = 'open'; };
      es.onmessage = function (m) {
        let d = null;
        try { d = JSON.parse(m.data); } catch (e) { return; }
        if (!d || !d.type || d.type === 'hello') return;
        fire(d);
      };
      es.onerror = function () {
        window.__liveState = 'error';
        // EventSource ต่อใหม่เองอัตโนมัติ ถ้าปิดสนิทให้ลองใหม่ช้า ๆ (กันลูปถี่)
        if (es && es.readyState === 2) {
          try { es.close(); } catch (e) { /* ข้าม */ }
          if (!closed) setTimeout(connect, 5000);
        }
      };
    }

    connect();

    // กลับมาเปิดแท็บ/หน้าต่างอีกครั้ง → ดึงข้อมูลใหม่กันตกหล่นช่วงที่ไม่ได้เชื่อมต่อ
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) fire({ type: 'visible' });
    });

    return {
      state: function () { return window.__liveState; },
      close: function () { closed = true; if (es) { try { es.close(); } catch (e) { /* ข้าม */ } } },
    };
  };
})();

/** ทดสอบชั่วคราว (ลบทิ้ง): หาว่าอะไรทำให้หน้า /d/<token> ล้นขวาบนมือถือตอนร้านปิด */
'use strict';
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const WS = globalThis.WebSocket;
const TARGET = process.argv[2] || 'https://qpage.website/d/fd5996e991a334f9';
const PORT = 9660;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cdp(u) { return new Promise((res, rej) => { const ws = new WS(u); let id = 0; const w = new Map();
  const api = { ws, send(m, p) { return new Promise((r2, j2) => { const i = ++id; w.set(i, { res: r2, rej: j2 }); ws.send(JSON.stringify({ id: i, method: m, params: p })); }); }, close() { ws.close(); } };
  ws.addEventListener('open', () => res(api));
  ws.addEventListener('message', (raw) => { const m = JSON.parse(String(raw.data)); if (m.id && w.has(m.id)) { const x = w.get(m.id); w.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); } });
  ws.addEventListener('error', () => rej(new Error('ws'))); }); }
(async () => {
  const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--window-size=390,844', '--user-data-dir=' + path.join(os.tmpdir(), 'qa-overflow'), 'about:blank'], { stdio: 'ignore' });
  try {
    let tab = null;
    for (let i = 0; i < 40 && !tab; i++) { await sleep(500); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page'); } catch (e) {} }
    const c = await cdp(tab.webSocketDebuggerUrl);
    await c.send('Page.enable'); await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await c.send('Page.navigate', { url: TARGET });
    await sleep(5000);
    const ev = async (x) => { const r = await c.send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.result ? r.result.value : undefined; };
    const vw = await ev(`innerWidth`);
    const doc = await ev(`document.documentElement.scrollWidth`);
    console.log('viewport =', vw, '| document.scrollWidth =', doc, doc > vw ? '❌ ล้นแนวนอน ' + (doc - vw) + 'px' : '✅ ไม่ล้น');
    const info = JSON.parse(await ev(`JSON.stringify({
      closed: (function(){ var el = document.querySelector('.closed-note'); if(!el) return null; var r = el.getBoundingClientRect(); var cs = getComputedStyle(el); var chain = []; var p = el.parentElement; while (p) { var pr = p.getBoundingClientRect(); var pcs = getComputedStyle(p); chain.push({ tag: p.tagName + (p.className ? '.' + String(p.className).split(' ').slice(0,2).join('.') : ''), w: Math.round(pr.width), sw: p.scrollWidth, display: pcs.display, flexWrap: pcs.flexWrap, ws: pcs.whiteSpace, overflowX: pcs.overflowX, minWidth: pcs.minWidth }); p = p.parentElement; if (chain.length > 5) break; } return { text: el.textContent.trim(), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), scrollW: el.scrollWidth, nowrap: cs.whiteSpace, wordBreak: cs.wordBreak, overflowWrap: cs.overflowWrap, chain: chain }; })()
    })`));
    console.log('closed-note:', JSON.stringify(info.closed, null, 1));
    const wide = JSON.parse(await ev(`JSON.stringify([].slice.call(document.querySelectorAll('*')).filter(function(e){ var r = e.getBoundingClientRect(); return r.right > innerWidth + 1 || r.width > innerWidth + 1; }).slice(0, 12).map(function(e){ var r = e.getBoundingClientRect(); return { tag: e.tagName + (e.className ? '.' + String(e.className).split(' ').slice(0,2).join('.') : ''), w: Math.round(r.width), right: Math.round(r.right), text: (e.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 60) }; }))`));
    console.log('elements wider than viewport:', JSON.stringify(wide, null, 1));
    c.close();
  } catch (e) { console.error('ERR', e.message); }
  finally { try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} }
  process.exit(0);
})();

/**
 * shop-seo.js — ใส่ข้อมูล SEO ของร้านลงในหน้าร้านสาธารณะ (/s/:code) ตั้งแต่ฝั่งเซิร์ฟเวอร์
 *
 * ทำไมต้องฝั่งเซิร์ฟเวอร์: การ์ดพรีวิวเวลาแชร์ลิงก์ (LINE / Facebook / Discord) และเสิร์ชเอนจิน
 * อ่านค่า <meta> จาก HTML ที่ตอบกลับทันที — ถ้ารอ JS เติมทีหลัง การ์ดจะไม่มีรูป/ชื่อร้าน
 *
 * สิ่งที่ใส่: title, description, canonical, Open Graph, Twitter card และ JSON-LD (schema.org/Restaurant)
 * ค่าที่ใช้: เนื้อหา SEO ที่ร้านกรอกไว้ (seo_title / seo_description) ถ้าเว้นว่างจะสร้างจากชื่อร้านให้เอง
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

const SHOP_DIR = path.join(__dirname, '..', '..', 'public', 'shop');
const MARKER_RE = /^[ \t]*<!--SHOP_SEO-->[ \t]*\r?\n/m;
const SITE_NAME = 'QPage';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

/** ลิงก์เต็มจากพาธภายใน (เช่น /uploads/logos/x.png → https://โดเมน/uploads/logos/x.png) */
function absoluteUrl(origin, url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return String(origin || '').replace(/\/+$/, '') + (u.startsWith('/') ? u : '/' + u);
}

/** หัวข้อที่แสดงบนแท็บเบราว์เซอร์/Google */
function seoTitle(shop) {
  return clip(shop.seo_title, 160) || `${clip(shop.name, 100)} — เมนูและสั่งอาหารออนไลน์`;
}

/** คำอธิบายที่แสดงใต้หัวข้อ (Google) และในการ์ดพรีวิวเวลาแชร์ลิงก์ */
function seoDescription(shop) {
  const custom = clip(shop.seo_description, 400);
  if (custom) return custom;
  const bits = [`ร้าน ${clip(shop.name, 80)}`];
  if (shop.phone) bits.push(`โทร ${clip(shop.phone, 20)}`);
  bits.push('ดูเมนู สแกน QR ที่โต๊ะแล้วสั่งอาหารออนไลน์ได้ทันที');
  return clip(bits.join(' · '), 200);
}

function jsonLd(shop, pageUrl, imageUrl) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Restaurant',
    name: clip(shop.name, 120),
    url: pageUrl,
    hasMenu: pageUrl,
  };
  if (imageUrl) data.image = imageUrl;
  if (shop.phone) data.telephone = clip(shop.phone, 30);
  if (shop.line_url) data.sameAs = [String(shop.line_url).trim()];
  if (shop.maps_url) data.hasMap = String(shop.maps_url).trim();
  return data;
}

/**
 * สร้างบล็อก <meta> สำหรับหน้าร้าน
 * @param {object|null} shop ข้อมูลร้านจาก findPublicShopByCode (null = ไม่พบร้าน)
 * @param {string} origin เช่น https://qpage.website
 */
function metaHtml(shop, origin) {
  if (!shop) {
    // ไม่พบร้าน/ร้านปิดอยู่ — ไม่ให้เสิร์ชเอนจินเก็บหน้านี้
    return [
      `<title>ไม่พบร้านนี้ | ${SITE_NAME}</title>`,
      '<meta name="robots" content="noindex,follow">',
    ].join('\n    ');
  }

  const pageUrl = `${String(origin || '').replace(/\/+$/, '')}/s/${shop.public_code}`;
  const imageUrl = absoluteUrl(origin, shop.logo_url);
  const t = seoTitle(shop);
  const d = seoDescription(shop);

  const tags = [
    `<title>${esc(t)}</title>`,
    `<meta name="description" content="${esc(d)}">`,
    `<link rel="canonical" href="${esc(pageUrl)}">`,
    '<meta name="robots" content="index,follow">',
    // Open Graph — LINE / Facebook / Discord ใช้ชุดนี้ทำการ์ดพรีวิว
    '<meta property="og:type" content="restaurant.restaurant">',
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    `<meta property="og:title" content="${esc(t)}">`,
    `<meta property="og:description" content="${esc(d)}">`,
    `<meta property="og:url" content="${esc(pageUrl)}">`,
    '<meta property="og:locale" content="th_TH">',
  ];
  if (imageUrl) {
    tags.push(`<meta property="og:image" content="${esc(imageUrl)}">`);
    tags.push(`<meta property="og:image:alt" content="${esc(clip(shop.name, 120))}">`);
  }
  tags.push(imageUrl ? '<meta name="twitter:card" content="summary_large_image">' : '<meta name="twitter:card" content="summary">');
  tags.push(`<meta name="twitter:title" content="${esc(t)}">`);
  tags.push(`<meta name="twitter:description" content="${esc(d)}">`);
  if (imageUrl) tags.push(`<meta name="twitter:image" content="${esc(imageUrl)}">`);
  // JSON-LD: บอกเสิร์ชเอนจินว่านี่คือหน้าเว็บของร้านอาหารชื่ออะไร
  tags.push(`<script type="application/ld+json">${JSON.stringify(jsonLd(shop, pageUrl, imageUrl))}</script>`);

  return tags.join('\n    ');
}

/**
 * อ่านไฟล์หน้าร้าน + แทรกบล็อก SEO ที่จุดแทนที่ <!--SHOP_SEO--> แล้วส่งกลับ
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object|null} shop
 */
async function sendPublicShopPage(req, res, shop) {
  const origin = `${req.protocol}://${req.get('host')}`;
  const full = path.join(SHOP_DIR, 'index.html');
  res.set('Cache-Control', 'no-store');
  try {
    const html = await fs.readFile(full, 'utf8');
    const meta = metaHtml(shop, origin);
    let out = html.replace(MARKER_RE, meta + '\n');
    // กันเหนียว: ถ้าไฟล์ไม่มีจุดแทนที่ (หรือถูกแก้จนหาย) ต้องยังมี <title> เสมอ
    if (!/<title>/i.test(out)) {
      out = out.replace(/<head>/i, `<head>\n    <title>${esc(seoTitle(shop || { name: '' }))}</title>`);
    }
    res.type('html').send(out);
  } catch (err) {
    console.error('⚠️ อ่านหน้าร้านสาธารณะไม่สำเร็จ:', err.message);
    res.sendFile(full);
  }
}

module.exports = { metaHtml, seoTitle, seoDescription, absoluteUrl, sendPublicShopPage };

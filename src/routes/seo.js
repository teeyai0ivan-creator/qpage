/**
 * seo.js — ไฟล์บอกเสิร์ชเอนจิน: robots.txt + sitemap.xml
 *
 * - robots.txt: ให้เก็บหน้าเว็บสาธารณะ (หน้าแรก, หน้าสมัคร, นโยบาย, หน้าร้าน /s/…) ได้
 *   แต่ห้ามเก็บพื้นที่ส่วนตัว (หลังบ้าน/บัญชี/โซนร้านค้า/API)
 * - sitemap.xml: สร้างจากรายชื่อร้านจริงในฐานข้อมูล → Google/LINE ค้นเจอหน้าร้านแต่ละร้าน
 *   (ต้องยื่น sitemap กับ Google Search Console ครั้งเดียว แล้วระบบจะอัปเดตรายการเองอัตโนมัติ)
 */
'use strict';

const express = require('express');
const db = require('../db');

const { makeRouter } = require('../lib/router');
const router = makeRouter();

router.get('/robots.txt', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  res.type('text/plain').send(
    [
      'User-agent: *',
      'Allow: /$',
      'Allow: /privacy.html',
      'Allow: /login.html',
      'Allow: /register.html',
      'Allow: /s/',
      'Disallow: /admin',
      'Disallow: /settings',
      'Disallow: /dashboard',
      'Disallow: /shop',
      'Disallow: /order/',
      'Disallow: /api/',
      '',
      `Sitemap: ${origin}/sitemap.xml`,
      '',
    ].join('\n')
  );
});

router.get('/sitemap.xml', async (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = (d) => {
    const t = new Date(d || Date.now());
    return isNaN(t.getTime()) ? '' : t.toISOString().slice(0, 10);
  };

  const urls = [
    { loc: `${origin}/`, lastmod: day(Date.now()), priority: '1.0', freq: 'weekly' },
    { loc: `${origin}/register.html`, lastmod: day(Date.now()), priority: '0.6', freq: 'monthly' },
    { loc: `${origin}/privacy.html`, lastmod: day(Date.now()), priority: '0.3', freq: 'yearly' },
  ];

  try {
    for (const s of await db.listPublicShops()) {
      urls.push({ loc: `${origin}/s/${s.public_code}`, lastmod: day(s.updated_at), priority: '0.9', freq: 'weekly' });
    }
  } catch (err) {
    console.error('⚠️ สร้าง sitemap ไม่สำเร็จ (ดึงรายชื่อร้านไม่ได้):', err.message);
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => [
      '  <url>',
      `    <loc>${esc(u.loc)}</loc>`,
      u.lastmod ? `    <lastmod>${esc(u.lastmod)}</lastmod>` : '',
      `    <changefreq>${u.freq}</changefreq>`,
      `    <priority>${u.priority}</priority>`,
      '  </url>',
    ].filter(Boolean).join('\n')),
    '</urlset>',
    '',
  ].join('\n');

  res.type('application/xml').set('Cache-Control', 'public, max-age=600').send(xml);
});

module.exports = router;

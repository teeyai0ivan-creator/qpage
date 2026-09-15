/**
 * db.js — ฐานข้อมูล MySQL (ใช้ mysql2)
 *
 * API เดียวกับเวอร์ชัน SQLite เดิม — แต่ฟังก์ชันทั้งหมดเป็น async (คืน Promise)
 * caller ต้อง await ทุกครั้ง
 */
'use strict';

const mysql = require('mysql2/promise');

const DATABASE_URL = process.env.DATABASE_URL || process.env.MYSQL_URL || '';

if (!DATABASE_URL) {
  console.error('⚠️ ไม่พบ DATABASE_URL — ตั้งค่า MySQL connection URL ใน environment');
}

const pool = mysql.createPool({
  uri: DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: 'Z', // เก็บ/อ่านเวลาเป็น UTC ให้ตรงกับ nowSql() ใน server.js
  enableKeepAlive: true, // ส่ง TCP keepalive — ป้องกัน Railway proxy ตัด connection ที่ idle ทิ้ง
  keepAliveInitialDelay: 0,
  connectTimeout: 10000,
});

// บังคับทุก connection ให้ใช้ UTC — ไม่งั้น CURRENT_TIMESTAMP (เช่น created_at)
// จะบันทึกเป็นเวลาท้องถิ่นของเครื่อง MySQL แล้วตีความผิดเพี้ยน (VPS ตั้งเวลาไทย +07)
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'", (err) => {
    if (err) console.error('⚠️ ตั้ง time_zone ล้มเหลว:', err.message);
  });
});

// mysql2 pool ไม่ retry ให้อัตโนมัติ — ถ้า connection ถูกตัดกลางอากาศ (proxy หลุด/restart)
// คำสั่ง SELECT ที่เพิ่งส่งไปจะ error ทั้งที่ฐานข้อมูลพร้อมแล้ว ขอ retry 1 ครั้งเฉพาะคำสั่งอ่าน
// (คำสั่งเขียนไม่ retry เพื่อป้องกันการ insert ซ้ำ ถ้าคำสั่งแรกไปถึง DB แล้วแต่ connection หลุดตอนตอบกลับ)
const TRANSIENT_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'PROTOCOL_INCORRECT_PACKET_SEQUENCE',
  'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ER_SERVER_SHUTDOWN',
]);
const isTransient = (err) => !!(err && (TRANSIENT_CODES.has(err.code) || TRANSIENT_CODES.has(err.errno)));
const isReadQuery = (sql) => /^\s*(select|show|describe|explain)/i.test(String(sql));

const poolExecute = pool.execute.bind(pool);
pool.execute = async (sql, params) => {
  try {
    return await poolExecute(sql, params);
  } catch (err) {
    if (isReadQuery(sql) && isTransient(err)) {
      return await poolExecute(sql, params); // ลองใหม่ 1 ครั้ง (pool ทิ้ง connection ที่เสียไปแล้ว)
    }
    throw err;
  }
};

// ---------------------------------------------------------------------------
// Schema (รันตอน boot — ฝังคอลัมน์จาก migrations เดิมเข้าไปใน DDL แล้ว)
// ---------------------------------------------------------------------------
async function initSchema() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id                BIGINT AUTO_INCREMENT PRIMARY KEY,
      email             VARCHAR(255) NOT NULL UNIQUE,
      password_hash     VARCHAR(255) NOT NULL,
      phone             VARCHAR(30)  NOT NULL,
      status            VARCHAR(10)  NOT NULL DEFAULT 'pending',
      is_email_verified TINYINT(1)   NOT NULL DEFAULT 0,
      role              VARCHAR(10)  NOT NULL DEFAULT 'user',
      provider          VARCHAR(10)  NOT NULL DEFAULT 'email',
      google_id         VARCHAR(255) NULL,
      created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      token      CHAR(64) PRIMARY KEY,
      user_id    BIGINT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id    BIGINT NOT NULL,
      code_hash  CHAR(64) NOT NULL,
      phone      VARCHAR(255) NOT NULL,
      attempts   INT NOT NULL DEFAULT 0,
      used       TINYINT(1) NOT NULL DEFAULT 0,
      purpose    VARCHAR(20) NOT NULL DEFAULT 'signup',
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_otp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS email_tokens (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id    BIGINT NOT NULL,
      token_hash CHAR(64) NOT NULL,
      used       TINYINT(1) NOT NULL DEFAULT 0,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_emailtoken_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id    BIGINT NOT NULL,
      token_hash CHAR(64) NOT NULL,
      used       TINYINT(1) NOT NULL DEFAULT 0,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_pwreset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      \`key\`   VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // เพิ่มคอลัมน์ใหม่ให้ตารางที่สร้างไว้แล้ว (MySQL ไม่มี ADD COLUMN IF NOT EXISTS)
  await ensureColumn('otp_codes', 'code_visible', 'code_visible VARCHAR(10) NULL');
  await ensureColumn('otp_codes', 'note', 'note VARCHAR(255) NULL');
  await ensureColumn('otp_codes', 'replaced', 'replaced TINYINT(1) NOT NULL DEFAULT 0');
  await ensureColumn('users', 'gift_expires_at', 'gift_expires_at DATETIME NULL');
  // หลักฐานความยินยอมตาม PDPA: ยอมรับข้อกำหนด/นโยบายเมื่อไร และเวอร์ชันใด
  await ensureColumn('users', 'terms_accepted_at', 'terms_accepted_at DATETIME NULL');
  await ensureColumn('users', 'terms_version', "terms_version VARCHAR(20) NULL");

  // ประวัติการมอบของขวัญร้านค้า (owner มอบสิทธิ์เจ้าของร้านชั่วคราว)
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS shop_gifts (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id    BIGINT NOT NULL,
      granted_by BIGINT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_gift_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_gift_grantor FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ── ร้านค้า / เมนู (ระบบร้านอาหาร) ──────────────────────────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS shops (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id     BIGINT NOT NULL UNIQUE,
      public_code VARCHAR(20) NOT NULL UNIQUE,
      name        VARCHAR(120) NOT NULL,
      phone       VARCHAR(30) NOT NULL DEFAULT '',
      line_url    VARCHAR(255) NOT NULL DEFAULT '',
      logo_url    VARCHAR(255) NOT NULL DEFAULT '',
      maps_url    VARCHAR(500) NOT NULL DEFAULT '',
      status      VARCHAR(10) NOT NULL DEFAULT 'active',
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_shops_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS categories (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      shop_id    BIGINT NOT NULL,
      parent_id  BIGINT NULL,
      name       VARCHAR(120) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      station    VARCHAR(10) NOT NULL DEFAULT 'kitchen',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_categories_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
      CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS menus (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      shop_id     BIGINT NOT NULL,
      category_id BIGINT NULL,
      name        VARCHAR(150) NOT NULL,
      description VARCHAR(500) NOT NULL DEFAULT '',
      price       DECIMAL(10,2) NOT NULL DEFAULT 0,
      image_url   VARCHAR(255) NOT NULL DEFAULT '',
      available   TINYINT(1) NOT NULL DEFAULT 1,
      sort_order  INT NOT NULL DEFAULT 0,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_menus_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
      CONSTRAINT fk_menus_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS option_groups (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      shop_id    BIGINT NOT NULL,
      name       VARCHAR(120) NOT NULL,
      required   TINYINT(1) NOT NULL DEFAULT 0,
      multi      TINYINT(1) NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_optgrp_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS option_items (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      group_id    BIGINT NOT NULL,
      name        VARCHAR(120) NOT NULL,
      price_delta DECIMAL(10,2) NOT NULL DEFAULT 0,
      sort_order  INT NOT NULL DEFAULT 0,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_optitem_group FOREIGN KEY (group_id) REFERENCES option_groups(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS menu_option_groups (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      menu_id    BIGINT NOT NULL,
      group_id   BIGINT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      UNIQUE KEY uq_menu_group (menu_id, group_id),
      CONSTRAINT fk_mog_menu FOREIGN KEY (menu_id) REFERENCES menus(id) ON DELETE CASCADE,
      CONSTRAINT fk_mog_group FOREIGN KEY (group_id) REFERENCES option_groups(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS shop_purchases (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id    BIGINT NOT NULL,
      package    VARCHAR(30) NOT NULL DEFAULT 'basic',
      amount     DECIMAL(10,2) NOT NULL DEFAULT 0,
      status     VARCHAR(10) NOT NULL DEFAULT 'paid',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_purchase_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await ensureColumn('shop_purchases', 'package_id', 'package_id BIGINT NULL');
  await ensureColumn('shop_purchases', 'payment_id', 'payment_id BIGINT NULL');
  // สิทธิ์เป็น "รายรายการซื้อ" — แต่ละรายการมีช่วงเวลาของตัวเอง และถูกดึงสิทธิ์กลับเป็นรายรายการได้
  await ensureColumn('shop_purchases', 'start_at', 'start_at DATETIME NULL');
  await ensureColumn('shop_purchases', 'expires_at', 'expires_at DATETIME NULL');
  await ensureColumn('shop_purchases', 'revoked_at', 'revoked_at DATETIME NULL');
  await ensureColumn('shop_purchases', 'revoked_by', 'revoked_by BIGINT NULL');

  // เส้นทางแสดงผลของหมวดหมู่: 'kitchen' (ครัว) | 'cashier' (แคชเชียร์)
  await ensureColumn('categories', 'station', "station VARCHAR(10) NOT NULL DEFAULT 'kitchen'");

  // ── แพ็กเกจ (owner ตั้งขาย — ผู้ใช้ซื้อแล้วเปิดร้านได้) ─────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS packages (
      id              BIGINT AUTO_INCREMENT PRIMARY KEY,
      name            VARCHAR(120) NOT NULL,
      duration_months INT NOT NULL DEFAULT 1,
      price           DECIMAL(10,2) NOT NULL DEFAULT 0,
      details_json    TEXT NULL,
      active          TINYINT(1) NOT NULL DEFAULT 1,
      sort_order      INT NOT NULL DEFAULT 0,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ── การชำระเงินค่าแพ็กเกจ (ลูกค้าแจ้งโอน → owner ตรวจสอบยืนยัน) ────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS package_payments (
      id              BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id         BIGINT NOT NULL,
      package_id      BIGINT NULL,
      package_name    VARCHAR(120) NOT NULL,
      duration_months INT NOT NULL DEFAULT 1,
      amount          DECIMAL(10,2) NOT NULL DEFAULT 0,
      method          VARCHAR(20) NOT NULL DEFAULT 'promptpay',
      ref             VARCHAR(20) NOT NULL UNIQUE,
      status          VARCHAR(12) NOT NULL DEFAULT 'pending',
      notified        TINYINT(1) NOT NULL DEFAULT 0,
      note            VARCHAR(255) NOT NULL DEFAULT '',
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      confirmed_at    DATETIME NULL,
      confirmed_by    BIGINT NULL,
      CONSTRAINT fk_ppay_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_ppay_package FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE SET NULL,
      CONSTRAINT fk_ppay_confirmer FOREIGN KEY (confirmed_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // สลิปโอนเงิน + ผลการตรวจสลิปอัตโนมัติ (EasySlip)
  await ensureColumn('package_payments', 'slip_url', "slip_url VARCHAR(255) NOT NULL DEFAULT ''");
  await ensureColumn('package_payments', 'slip_status', "slip_status VARCHAR(24) NOT NULL DEFAULT ''");
  await ensureColumn('package_payments', 'slip_detail', "slip_detail VARCHAR(255) NOT NULL DEFAULT ''");
  // ลายนิ้วมือของไฟล์สลิป (sha256) — กันลูกค้าเอาสลิปเดิมมาอัพซ้ำกับรายการใหม่
  await ensureColumn('package_payments', 'slip_hash', "slip_hash CHAR(64) NOT NULL DEFAULT ''");

  // ── โต๊ะ + ออเดอร์ (ระบบสั่งอาหาร) ─────────────────────────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS \`tables\` (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      shop_id    BIGINT NOT NULL,
      code       VARCHAR(30) NOT NULL,
      token      CHAR(16) NOT NULL UNIQUE,
      retire_seq INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_tables_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
      KEY idx_tables_shop (shop_id),
      UNIQUE KEY uq_shop_table_code (shop_id, code, retire_seq)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS orders (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      shop_id    BIGINT NOT NULL,
      table_id   BIGINT NULL,
      table_code VARCHAR(30) NOT NULL DEFAULT '',
      status     VARCHAR(10) NOT NULL DEFAULT 'open',
      total      DECIMAL(12,2) NOT NULL DEFAULT 0,
      opened_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at  DATETIME NULL,
      CONSTRAINT fk_orders_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
      CONSTRAINT fk_orders_table FOREIGN KEY (table_id) REFERENCES \`tables\`(id) ON DELETE SET NULL,
      KEY idx_orders_open (shop_id, table_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS order_items (
      id           BIGINT AUTO_INCREMENT PRIMARY KEY,
      order_id     BIGINT NOT NULL,
      menu_id      BIGINT NULL,
      menu_name    VARCHAR(150) NOT NULL,
      unit_price   DECIMAL(10,2) NOT NULL DEFAULT 0,
      quantity     INT NOT NULL DEFAULT 1,
      options_json TEXT,
      line_total   DECIMAL(12,2) NOT NULL DEFAULT 0,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_orderitems_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // เลขที่บิล (รันต่อร้าน) — เพิ่มให้ตาราง orders ที่มีอยู่แล้ว
  await ensureColumn('orders', 'bill_no', 'bill_no INT NULL');
  // สถานะรายจานสำหรับครัว: pending (รอทำ) / cooking (กำลังทำ) / done (เสร็จแล้ว)
  await ensureColumn('order_items', 'status', "status VARCHAR(10) NOT NULL DEFAULT 'pending'");
  await ensureColumn('order_items', 'started_at', 'started_at DATETIME NULL');
  await ensureColumn('order_items', 'done_at', 'done_at DATETIME NULL');
  await ensureColumn('order_items', 'cancel_reason', 'cancel_reason VARCHAR(255) NULL');
  await ensureColumn('order_items', 'options_ids_json', 'options_ids_json TEXT NULL');
  // บิลต้องไม่หายไปพร้อมโต๊ะ/QR — เก็บชื่อโต๊ะไว้ในบิลตั้งแต่เปิดบิล (snapshot)
  // และให้ FK ของ table_id เป็น SET NULL เพื่อให้ประวัติ/ใบเสร็จของบิลที่เช็คบิลแล้วยังอยู่
  await ensureColumn('orders', 'table_code', "table_code VARCHAR(30) NOT NULL DEFAULT ''");
  // ถ้าขั้นตอนนี้ล้มเหลว (เช่น สิทธิ์ ALTER ไม่พอ) ไม่ควรทำให้เซิร์ฟเวอร์บูตไม่ขึ้น — แจ้งเตือนแล้วทำงานต่อ
  try {
    await backfillOrderTableCode();
    await relaxOrderTableForeignKey();
  } catch (err) {
    console.error('⚠️ ปรับโครงสร้างตาราง orders (table_code / FK SET NULL) ไม่สำเร็จ:', err.message);
    console.error('   ผลที่ตามมา: บิลที่เช็คบิลแล้วอาจถูกลบไปพร้อมโต๊ะเมื่อเปิดสวิตช์ "ลบ QR ทันทีเมื่อเช็คบิล"');
  }

  // ── รายชื่อโต๊ะ (แคตตาล็อกชื่อโต๊ะของร้าน) ──────────────────────────────
  // เก็บชื่อไว้ถาวร เพื่อให้สร้าง QR ใหม่โดยเลือกจากรายชื่อได้ แม้ตัวโต๊ะ/QR จะถูกลบไปแล้ว
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS table_names (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      shop_id    BIGINT NOT NULL,
      name       VARCHAR(30) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_tname_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
      UNIQUE KEY uq_shop_tname (shop_id, name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // โต๊ะแต่ละชื่อถูกจัดเข้าโซนใด (ว่างได้ = ยังไม่จัดเข้าโซน)
  await ensureColumn('table_names', 'zone_id', 'zone_id BIGINT NULL');

  // ── โซนของร้าน (จัดกลุ่มโต๊ะ เช่น "ในร้าน", "ริมระเบียง", "ชั้น 2") ──────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS zones (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      shop_id    BIGINT NOT NULL,
      name       VARCHAR(60) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_zones_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
      UNIQUE KEY uq_shop_zone (shop_id, name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ── โทเคน QR ที่ถูกลบไปแล้ว ────────────────────────────────────────────
  // เก็บไว้เป็นหลักฐาน/กันการใช้ซ้ำ: โทเคนที่เคยลบจะไม่ถูกออกให้โต๊ะใดอีกในอนาคต
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS retired_table_tokens (
      token      CHAR(16) PRIMARY KEY,
      shop_id    BIGINT NOT NULL,
      retired_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ตัวเลือกลบ QR ของโต๊ะทันทีเมื่อเช็คบิล (ปิดไว้เป็นค่าเริ่มต้น)
  // หมายเหตุ: ตัวเลือกนี้ "ปิดใช้งาน" QR ไม่ได้ลบทิ้ง — โต๊ะยังถูกเก็บไว้ในประวัติ (tables.retired_at)
  await ensureColumn('shops', 'delete_qr_on_checkout', 'delete_qr_on_checkout TINYINT(1) NOT NULL DEFAULT 0');
  // วันที่ปิดใช้งาน QR ของโต๊ะ (NULL = ยังใช้งานอยู่) — เก็บแถวไว้เป็นประวัติ/หลักฐาน ไม่ลบทิ้ง
  await ensureColumn('tables', 'retired_at', 'retired_at DATETIME NULL');
  // ตัวนับรุ่นของชื่อโต๊ะ: 0 = ยังใช้งานอยู่ · ตอนปิดใช้งานจะตั้งเป็น id ของแถว
  // เพื่อให้ชื่อเดิมถูกนำมาออก QR ใหม่ได้ แม้แถวเก่าจะยังอยู่เป็นประวัติ (UNIQUE เป็น shop_id+code+retire_seq)
  await ensureColumn('tables', 'retire_seq', 'retire_seq INT NOT NULL DEFAULT 0');
  await pool.execute('UPDATE `tables` SET retire_seq = id WHERE retired_at IS NOT NULL AND retire_seq = 0');
  await widenTableCodeUniqueKey();

  // โต๊ะที่มีอยู่ก่อนมีระบบรายชื่อ → เติมชื่อลงแคตตาล็อกให้ (ทำซ้ำได้ ไม่พัง)
  await pool.execute('INSERT IGNORE INTO table_names (shop_id, name) SELECT shop_id, code FROM `tables`');

  // ตัวเลือกที่ "มาร์คเป็นค่าเริ่มต้น" → เวลาลูกค้าเลือกเมนูที่ใช้กลุ่มนี้ ระบบจะติ๊กให้อัตโนมัติ
  await ensureColumn('option_items', 'is_default', 'is_default TINYINT(1) NOT NULL DEFAULT 0');

  // ── กลุ่มแจ้งเตือน (Telegram) ของแต่ละร้าน ─────────────────────────────
  // 1 ร้านมีได้หลายกลุ่ม แต่ละกลุ่มตั้งปลายทาง + เหตุการณ์ที่ต้องการรับเอง
  // (คอลัมน์ channel/line_token/line_target เป็นของเดิมสมัยรองรับ LINE — เก็บไว้ไม่ให้ข้อมูลเก่าหาย แต่ไม่ใช้แล้ว)
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS notify_groups (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      shop_id     BIGINT NOT NULL,
      name        VARCHAR(120) NOT NULL,
      channel     VARCHAR(16) NOT NULL DEFAULT 'line',
      active      TINYINT(1) NOT NULL DEFAULT 1,
      line_token  VARCHAR(255) NOT NULL DEFAULT '',
      line_target VARCHAR(120) NOT NULL DEFAULT '',
      tg_token    VARCHAR(255) NOT NULL DEFAULT '',
      tg_chat     VARCHAR(120) NOT NULL DEFAULT '',
      tg_thread   VARCHAR(40) NOT NULL DEFAULT '',
      events_json TEXT NULL,
      last_status VARCHAR(255) NOT NULL DEFAULT '',
      last_ok     TINYINT(1) NULL,
      last_at     DATETIME NULL,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_notify_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

// เพิ่มคอลัมน์ถ้ายังไม่มี (ใช้กับตารางที่สร้างจาก schema เก่า)
async function ensureColumn(table, column, ddl) {
  const [rows] = await pool.execute(
    'SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  );
  if (Number(rows[0].c) === 0) {
    await pool.execute(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
  }
}

// เปลี่ยน UNIQUE ของชื่อโต๊ะจาก (shop_id, code) เป็น (shop_id, code, retire_seq)
// เพื่อให้ปิดใช้งาน QR แล้วออก QR ชื่อเดิมใหม่ได้ (แถวเก่ายังอยู่เป็นประวัติ)
async function widenTableCodeUniqueKey() {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tables' AND INDEX_NAME = 'uq_shop_table_code'`
  );
  const cols = Number(rows[0].c) || 0;
  if (cols === 3) return; // อัปเดตแล้ว
  // FK (shop_id) อาจใช้ index นี้อยู่ → ต้องมี index ของตัวเองก่อน ไม่งั้น MySQL ไม่ให้ drop
  const [fkIdx] = await pool.execute(
    `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tables' AND INDEX_NAME = 'idx_tables_shop'`
  );
  if (Number(fkIdx[0].c) === 0) await pool.execute('ALTER TABLE `tables` ADD KEY idx_tables_shop (shop_id)');
  if (cols > 0) await pool.execute('ALTER TABLE `tables` DROP INDEX uq_shop_table_code');
  await pool.execute('ALTER TABLE `tables` ADD UNIQUE KEY uq_shop_table_code (shop_id, code, retire_seq)');
}

// เติมชื่อโต๊ะย้อนหลังให้บิลเก่าที่ยังไม่มี snapshot (ทำครั้งเดียวต่อบิล)
async function backfillOrderTableCode() {
  await pool.execute(
    "UPDATE orders o JOIN `tables` t ON t.id = o.table_id SET o.table_code = t.code WHERE o.table_code = '' AND o.table_id IS NOT NULL"
  );
}

// เปลี่ยน FK ของ orders.table_id จาก ON DELETE CASCADE เป็น ON DELETE SET NULL
// เหตุผล: ถ้าเปิดสวิตช์ "ลบ QR ทันทีเมื่อเช็คบิล" การเช็คบิลจะลบโต๊ะออก
// ถ้าเป็น CASCADE บิลที่เพิ่งเช็คบิลจะถูกลบตามไปด้วย → ใบเสร็จ/ประวัติขึ้น "ไม่พบบิลนี้"
async function relaxOrderTableForeignKey() {
  const [rows] = await pool.execute(
    `SELECT CONSTRAINT_NAME AS name, DELETE_RULE AS rule
       FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND REFERENCED_TABLE_NAME = 'tables'`
  );
  const cur = rows[0];
  if (cur && cur.rule === 'SET NULL') return;
  if (cur) await pool.execute(`ALTER TABLE orders DROP FOREIGN KEY \`${cur.name}\``);
  await pool.execute('ALTER TABLE orders MODIFY table_id BIGINT NULL');
  await pool.execute(
    'ALTER TABLE orders ADD CONSTRAINT fk_orders_table FOREIGN KEY (table_id) REFERENCES `tables`(id) ON DELETE SET NULL'
  );
}

// ---------------------------------------------------------------------------
// Settings — cache ในหน่วยความจำ (devMode/SMTP/SMS config ยังเป็น sync ได้)
// ---------------------------------------------------------------------------
const settingsCache = new Map();

async function loadSettingsCache() {
  settingsCache.clear();
  const [rows] = await pool.execute('SELECT `key`, value FROM settings');
  for (const r of rows) settingsCache.set(r.key, r.value);
}

async function initDb() {
  await initSchema();
  await loadSettingsCache();
  // ลบตาราง pages ของฟีเจอร์ SalePage เดิม (ทำครั้งเดียว) — ตั้ง flag กันไม่ให้ลบซ้ำในอนาคต
  if (getSetting('legacy_pages_dropped') !== 'true') {
    await pool.execute('DROP TABLE IF EXISTS pages');
    await setSetting('legacy_pages_dropped', 'true');
    console.log('🧹 ลบตาราง pages (ฟีเจอร์ SalePage เดิม) เรียบร้อย');
  }
  // เติมช่วงสิทธิ์ให้รายการซื้อเดิม (ครั้งเดียว) — ใช้สิทธิ์ที่ผู้ใช้มีอยู่จริงเป็นวันสิ้นสุด เพื่อไม่ให้สิทธิ์เปลี่ยน
  if (getSetting('legacy_purchases_backfilled') !== 'true') {
    const [r] = await pool.execute(
      `UPDATE shop_purchases sp JOIN users u ON u.id = sp.user_id
          SET sp.start_at = COALESCE(sp.start_at, sp.created_at),
              sp.expires_at = COALESCE(sp.expires_at, u.gift_expires_at, DATE_ADD(sp.created_at, INTERVAL 1 MONTH))
        WHERE sp.expires_at IS NULL`
    );
    await setSetting('legacy_purchases_backfilled', 'true');
    console.log(`🧾 เติมช่วงสิทธิ์ให้รายการซื้อเดิม ${r.affectedRows || 0} รายการ`);
  }

  // ยกระดับแอดมินคนแรกเป็นเจ้าของระบบ (ครั้งเดียว) — สำหรับฐานข้อมูลเดิมที่ยังไม่มีบทบาท owner
  if (getSetting('legacy_owner_promoted') !== 'true') {
    const [owners] = await pool.execute("SELECT id FROM users WHERE role = 'owner' LIMIT 1");
    if (!owners[0]) {
      const [admins] = await pool.execute("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1");
      if (admins[0]) {
        await pool.execute("UPDATE users SET role = 'owner' WHERE id = ?", [admins[0].id]);
        console.log('👑 ยกระดับแอดมินคนแรกเป็นเจ้าของระบบ (owner) เรียบร้อย');
      }
    }
    await setSetting('legacy_owner_promoted', 'true');
  }

  // ขยายคอลัมน์ผู้รับรหัส OTP ให้รองรับอีเมล (เดิม VARCHAR(30) ใส่อีเมลยาว ๆ ไม่ได้ ทำให้ส่ง OTP ทางอีเมลล้ม)
  if (getSetting('otp_contact_widened') !== 'true') {
    await pool.execute('ALTER TABLE otp_codes MODIFY phone VARCHAR(255) NOT NULL');
    await setSetting('otp_contact_widened', 'true');
    console.log('🔧 ขยายคอลัมน์ otp_codes.phone เป็น VARCHAR(255) เพื่อรองรับรหัส OTP ทางอีเมล');
  }
}

function getSetting(key) {
  return settingsCache.has(key) ? settingsCache.get(key) : null;
}

async function setSetting(key, value) {
  const v = String(value);
  await pool.execute(
    'INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [key, v]
  );
  settingsCache.set(key, v);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
async function findUserByEmail(email) {
  const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
  return rows[0] || null;
}

async function findUserById(id) {
  const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0] || null;
}

async function createUser({ email, passwordHash, phone }) {
  const [result] = await pool.execute(
    'INSERT INTO users (email, password_hash, phone) VALUES (?, ?, ?)',
    [email, passwordHash, phone]
  );
  return findUserById(result.insertId);
}

async function setUserStatus(id, status) {
  await pool.execute('UPDATE users SET status = ? WHERE id = ?', [status, id]);
}

async function createGooglePendingUser({ email, googleId }) {
  const [result] = await pool.execute(
    `INSERT INTO users (email, password_hash, phone, status, is_email_verified, provider, google_id)
     VALUES (?, '', '', 'pending', 1, 'google', ?)`,
    [email, googleId || null]
  );
  return findUserById(result.insertId);
}

async function linkGoogle(id, googleId) {
  await pool.execute(
    "UPDATE users SET provider = CASE WHEN provider = 'email' THEN 'google' ELSE provider END, google_id = ? WHERE id = ?",
    [googleId || null, id]
  );
}

async function completeGoogleSetup(id, { passwordHash, phone }) {
  await pool.execute(
    "UPDATE users SET password_hash = ?, phone = ?, status = 'active', is_email_verified = 1 WHERE id = ?",
    [passwordHash, phone, id]
  );
  return findUserById(id);
}

async function updatePendingUser(id, { phone, passwordHash }) {
  await pool.execute('UPDATE users SET phone = ?, password_hash = ? WHERE id = ?', [phone, passwordHash, id]);
  return findUserById(id);
}

async function setEmailVerified(id, verified = 1) {
  await pool.execute('UPDATE users SET is_email_verified = ? WHERE id = ?', [verified, id]);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
async function createSession({ token, userId, expiresAt }) {
  await pool.execute('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, userId, expiresAt]);
}

async function findSession(token) {
  const [rows] = await pool.execute('SELECT * FROM sessions WHERE token = ?', [token]);
  return rows[0] || null;
}

async function deleteSession(token) {
  await pool.execute('DELETE FROM sessions WHERE token = ?', [token]);
}

async function deleteExpiredSessions() {
  await pool.execute('DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP');
}

// ---------------------------------------------------------------------------
// OTP
// ---------------------------------------------------------------------------
async function createOtp({ userId, codeHash, contact, purpose = 'signup', expiresAt, codeVisible = null }) {
  // รหัสเก่าที่ยังไม่ใช้ → ตัดสิทธิ์ทันที (เก็บประวัติไว้ให้แอดมินดู — ไม่ลบ)
  // หมายเหตุ (ผลส่ง SMS) ของรหัสเก่าเก็บไว้ตามเดิม ไม่ทับ — สถานะ "ถูกแทนที่" ดูจากคอลัมน์สถานะ
  await pool.execute(
    `UPDATE otp_codes SET replaced = 1
        WHERE user_id = ? AND purpose = ? AND used = 0 AND replaced = 0`,
    [userId, purpose]
  );
  const [result] = await pool.execute(
    'INSERT INTO otp_codes (user_id, code_hash, phone, purpose, expires_at, code_visible) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, codeHash, contact, purpose, expiresAt, codeVisible]
  );
  return Number(result.insertId);
}

// บันทึกผลการส่ง (SMS/อีเมล) ลงรายการ OTP
async function setOtpNote(id, note) {
  await pool.execute('UPDATE otp_codes SET note = ? WHERE id = ?', [note, id]);
}

async function findLatestOtp(userId, purpose = 'signup') {
  const [rows] = await pool.execute(
    `SELECT * FROM otp_codes 
      WHERE user_id = ? AND purpose = ? AND used = 0 AND replaced = 0 
      ORDER BY id DESC LIMIT 1`,
    [userId, purpose]
  );
  return rows[0] || null;
}

async function markOtpUsed(id) {
  await pool.execute('UPDATE otp_codes SET used = 1 WHERE id = ?', [id]);
}

// เบอร์/อีเมลปลายทางจากรายการ OTP ล่าสุดของคนนี้ (ใช้กรณีบัญชียังไม่ได้บันทึกเบอร์)
async function findLatestOtpContact(userId, purpose = 'signup') {
  const [rows] = await pool.execute(
    `SELECT phone FROM otp_codes 
      WHERE user_id = ? AND purpose = ? AND phone <> '' 
      ORDER BY id DESC LIMIT 1`,
    [userId, purpose]
  );
  return rows[0] ? rows[0].phone : null;
}

async function incrementOtpAttempts(id) {
  await pool.execute('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// Email verification tokens
// ---------------------------------------------------------------------------
async function createEmailToken({ userId, tokenHash, expiresAt }) {
  const [result] = await pool.execute(
    'INSERT INTO email_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [userId, tokenHash, expiresAt]
  );
  return Number(result.insertId);
}

async function findEmailTokenByHash(tokenHash) {
  const [rows] = await pool.execute(
    `SELECT et.*, u.email
       FROM email_tokens et
       JOIN users u ON u.id = et.user_id
      WHERE et.token_hash = ?
      ORDER BY et.id DESC LIMIT 1`,
    [tokenHash]
  );
  return rows[0] || null;
}

async function markEmailTokenUsed(id) {
  await pool.execute('UPDATE email_tokens SET used = 1 WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------
async function updateUserPassword(id, passwordHash) {
  await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
}

/** บันทึกหลักฐานความยินยอม (PDPA): วันเวลา + เวอร์ชันนโยบายที่ผู้ใช้ยอมรับ */
async function recordTermsConsent(userId, version) {
  await pool.execute(
    'UPDATE users SET terms_accepted_at = UTC_TIMESTAMP(), terms_version = ? WHERE id = ?',
    [String(version || ''), Number(userId)]
  );
}

async function createPasswordReset({ userId, tokenHash, expiresAt }) {
  await pool.execute('DELETE FROM password_resets WHERE user_id = ?', [userId]);
  const [result] = await pool.execute(
    'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [userId, tokenHash, expiresAt]
  );
  return Number(result.insertId);
}

async function findPasswordResetByHash(tokenHash) {
  const [rows] = await pool.execute(
    `SELECT pr.*, u.email
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
      WHERE pr.token_hash = ?
      ORDER BY pr.id DESC LIMIT 1`,
    [tokenHash]
  );
  return rows[0] || null;
}

async function markPasswordResetUsed(id) {
  await pool.execute('UPDATE password_resets SET used = 1 WHERE id = ?', [id]);
}

async function deleteUserSessions(userId) {
  await pool.execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

async function deleteOtherSessions(userId, currentTokenHash) {
  await pool.execute('DELETE FROM sessions WHERE user_id = ? AND token != ?', [userId, currentTokenHash]);
}

// ---------------------------------------------------------------------------
// Owner (เจ้าของระบบ — บทบาทสูงสุด)
// ---------------------------------------------------------------------------
async function findOwner() {
  const [rows] = await pool.execute("SELECT * FROM users WHERE role = 'owner' LIMIT 1");
  return rows[0] || null;
}

async function createOwnerUser({ email, passwordHash }) {
  const [result] = await pool.execute(
    "INSERT INTO users (email, password_hash, phone, status, role) VALUES (?, ?, '0000000000', 'active', 'owner')",
    [email, passwordHash]
  );
  return findUserById(result.insertId);
}

// ---------------------------------------------------------------------------
// Admin — รายงาน OTP
// ---------------------------------------------------------------------------
async function listOtpLogs(limit = 50) {
  // MySQL ไม่รองรับ placeholder ใน LIMIT — ต้อง interpolate (limit เป็นตัวเลขแล้ว)
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
  const [rows] = await pool.execute(
    `SELECT o.id, o.user_id, o.phone AS contact, o.purpose,
            o.attempts, o.used, o.replaced, o.code_visible, o.note,
            o.expires_at, o.created_at, u.email
       FROM otp_codes o
       JOIN users u ON u.id = o.user_id
      ORDER BY o.id DESC LIMIT ${safeLimit}`
  );
  return rows;
}

async function countStats() {
  const [users] = await pool.execute('SELECT COUNT(*) AS c FROM users');
  const [activeUsers] = await pool.execute("SELECT COUNT(*) AS c FROM users WHERE status = 'active'");
  const [otpTotal] = await pool.execute('SELECT COUNT(*) AS c FROM otp_codes');
  const [otpValid] = await pool.execute(
    'SELECT COUNT(*) AS c FROM otp_codes WHERE used = 0 AND replaced = 0 AND expires_at > CURRENT_TIMESTAMP'
  );
  const [otpUsed] = await pool.execute('SELECT COUNT(*) AS c FROM otp_codes WHERE used = 1');
  const [otpExpired] = await pool.execute(
    'SELECT COUNT(*) AS c FROM otp_codes WHERE used = 0 AND replaced = 0 AND expires_at <= CURRENT_TIMESTAMP'
  );
  return {
    users: users[0].c,
    activeUsers: activeUsers[0].c,
    otpTotal: otpTotal[0].c,
    otpValid: otpValid[0].c,
    otpUsed: otpUsed[0].c,
    otpExpired: otpExpired[0].c,
  };
}

// ---------------------------------------------------------------------------
// Admin — จัดการผู้ใช้
// ---------------------------------------------------------------------------
async function listUsers({ search = '', limit = 100 } = {}) {
  const like = `%${search}%`;
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const [rows] = await pool.execute(
    `SELECT id, email, phone, status, role, provider, is_email_verified, google_id, gift_expires_at, created_at
       FROM users
      WHERE email LIKE ? OR phone LIKE ?
      ORDER BY id DESC LIMIT ${safeLimit}`,
    [like, like]
  );
  return rows;
}

async function countUsers(search = '') {
  if (!search) {
    const [rows] = await pool.execute('SELECT COUNT(*) AS c FROM users');
    return rows[0].c;
  }
  const like = `%${search}%`;
  const [rows] = await pool.execute(
    'SELECT COUNT(*) AS c FROM users WHERE email LIKE ? OR phone LIKE ?',
    [like, like]
  );
  return rows[0].c;
}

async function countOwners() {
  const [rows] = await pool.execute("SELECT COUNT(*) AS c FROM users WHERE role = 'owner'");
  return rows[0].c;
}

async function updateUserByAdmin(id, fields) {
  const sets = [];
  const params = [];
  if (fields.email !== undefined) { sets.push('email = ?'); params.push(fields.email); }
  if (fields.phone !== undefined) { sets.push('phone = ?'); params.push(fields.phone); }
  if (fields.status !== undefined) { sets.push('status = ?'); params.push(fields.status); }
  if (fields.role !== undefined) { sets.push('role = ?'); params.push(fields.role); }
  if (fields.isEmailVerified !== undefined) { sets.push('is_email_verified = ?'); params.push(fields.isEmailVerified ? 1 : 0); }
  if (fields.passwordHash !== undefined) { sets.push('password_hash = ?'); params.push(fields.passwordHash); }
  if (sets.length) {
    await pool.execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  }
  return findUserById(id);
}

async function deleteUser(id) {
  await pool.execute('DELETE FROM users WHERE id = ?', [id]);
}

async function setUserRole(id, role) {
  await pool.execute('UPDATE users SET role = ? WHERE id = ?', [role, id]);
}

// ---------------------------------------------------------------------------
// ของขวัญร้านค้า (owner มอบสิทธิ์เจ้าของร้านชั่วคราว)
// ---------------------------------------------------------------------------
async function setShopGift({ userId, grantedBy = null, expiresAt }) {
  await pool.execute("UPDATE users SET role = 'shop', gift_expires_at = ? WHERE id = ?", [expiresAt, userId]);
  await pool.execute('INSERT INTO shop_gifts (user_id, granted_by, expires_at) VALUES (?, ?, ?)', [userId, grantedBy, expiresAt]);
}

/** กำหนดวันหมดอายุการใช้งานร้านให้ผู้ใช้ (ใช้ทั้งของขวัญจาก owner และการซื้อแพ็กเกจ) */
async function setUserShopExpiry(userId, expiresAt) {
  await pool.execute('UPDATE users SET gift_expires_at = ? WHERE id = ?', [expiresAt, userId]);
}

/** ถอนสิทธิ์ของขวัญของผู้ใช้คนหนึ่ง (คืนบทบาทเป็น user) */
async function expireShopGift(userId) {
  await pool.execute("UPDATE users SET role = 'user', gift_expires_at = NULL WHERE id = ? AND role = 'shop'", [userId]);
}

/** ถอนสิทธิ์ของขวัญที่หมดอายุทั้งหมด — คืนจำนวนที่ถูกถอน */
async function clearExpiredGifts() {
  const [result] = await pool.execute(
    "UPDATE users SET role = 'user', gift_expires_at = NULL WHERE role = 'shop' AND gift_expires_at IS NOT NULL AND gift_expires_at <= UTC_TIMESTAMP()"
  );
  return result.affectedRows || 0;
}

/** หาร้านสาธารณะที่ยังใช้งานได้ (เจ้าของยังเป็น shop และของขวัญไม่หมดอายุ) */
async function findPublicShopByCode(code) {
  const [rows] = await pool.execute(
    `SELECT s.* FROM shops s
       JOIN users u ON u.id = s.user_id
      WHERE s.public_code = ? AND s.status = 'active' AND u.role = 'shop'
        AND (u.gift_expires_at IS NULL OR u.gift_expires_at > UTC_TIMESTAMP())
      LIMIT 1`,
    [code]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Shops (ร้านค้า) — 1 บัญชี = 1 ร้าน
// ---------------------------------------------------------------------------
async function findShopByUserId(userId) {
  const [rows] = await pool.execute('SELECT * FROM shops WHERE user_id = ? LIMIT 1', [userId]);
  return rows[0] || null;
}

async function createShop({ userId, publicCode, name, phone = '', lineUrl = '', logoUrl = '', mapsUrl = '' }) {
  const [result] = await pool.execute(
    'INSERT INTO shops (user_id, public_code, name, phone, line_url, logo_url, maps_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, publicCode, name, phone, lineUrl, logoUrl, mapsUrl]
  );
  const [rows] = await pool.execute('SELECT * FROM shops WHERE id = ?', [result.insertId]);
  return rows[0] || null;
}

async function updateShop(id, fields) {
  const map = {
    name: 'name', phone: 'phone', lineUrl: 'line_url', logoUrl: 'logo_url', mapsUrl: 'maps_url',
    deleteQrOnCheckout: 'delete_qr_on_checkout',
  };
  const sets = [];
  const params = [];
  for (const key of Object.keys(map)) {
    if (fields[key] === undefined) continue;
    sets.push(`${map[key]} = ?`);
    // ค่าบูลีนในตารางเก็บเป็น 0/1
    params.push(key === 'deleteQrOnCheckout' ? (fields[key] ? 1 : 0) : fields[key]);
  }
  if (!sets.length) return;
  sets.push('updated_at = CURRENT_TIMESTAMP');
  await pool.execute(`UPDATE shops SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

// ---------------------------------------------------------------------------
// Categories (หมวดหมู่/หมวดหมู่ย่อย) — parent_id NULL = หมวดหลัก
// ---------------------------------------------------------------------------
async function listCategories(shopId) {
  const [rows] = await pool.execute(
    'SELECT * FROM categories WHERE shop_id = ? ORDER BY sort_order ASC, id ASC',
    [shopId]
  );
  return rows;
}

async function findCategoryById(id, shopId) {
  const [rows] = await pool.execute('SELECT * FROM categories WHERE id = ? AND shop_id = ?', [id, shopId]);
  return rows[0] || null;
}

async function createCategory({ shopId, parentId = null, name, sortOrder = 0, station = 'kitchen' }) {
  const [result] = await pool.execute(
    'INSERT INTO categories (shop_id, parent_id, name, sort_order, station) VALUES (?, ?, ?, ?, ?)',
    [shopId, parentId, name, sortOrder, station === 'cashier' ? 'cashier' : 'kitchen']
  );
  return Number(result.insertId);
}

async function updateCategory(id, shopId, fields) {
  const sets = [];
  const params = [];
  if (fields.name !== undefined) { sets.push('name = ?'); params.push(fields.name); }
  if (fields.parentId !== undefined) { sets.push('parent_id = ?'); params.push(fields.parentId); }
  if (fields.sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(fields.sortOrder); }
  if (fields.station !== undefined) { sets.push('station = ?'); params.push(fields.station === 'cashier' ? 'cashier' : 'kitchen'); }
  if (sets.length) await pool.execute(`UPDATE categories SET ${sets.join(', ')} WHERE id = ? AND shop_id = ?`, [...params, id, shopId]);
}

async function deleteCategory(id, shopId) {
  await pool.execute('DELETE FROM categories WHERE id = ? AND shop_id = ?', [id, shopId]);
}

// ---------------------------------------------------------------------------
// Menus (เมนูสินค้า)
// ---------------------------------------------------------------------------
async function listMenus(shopId) {
  const [rows] = await pool.execute(
    'SELECT * FROM menus WHERE shop_id = ? ORDER BY sort_order ASC, id ASC',
    [shopId]
  );
  return rows;
}

async function findMenuById(id, shopId) {
  const [rows] = await pool.execute('SELECT * FROM menus WHERE id = ? AND shop_id = ?', [id, shopId]);
  return rows[0] || null;
}

async function createMenu({ shopId, categoryId = null, name, description = '', price = 0, imageUrl = '', sortOrder = 0 }) {
  const [result] = await pool.execute(
    'INSERT INTO menus (shop_id, category_id, name, description, price, image_url, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [shopId, categoryId, name, description, price, imageUrl, sortOrder]
  );
  return Number(result.insertId);
}

async function updateMenu(id, shopId, fields) {
  const map = { categoryId: 'category_id', name: 'name', description: 'description', price: 'price', imageUrl: 'image_url', available: 'available', sortOrder: 'sort_order' };
  const sets = [];
  const params = [];
  for (const key of Object.keys(map)) {
    if (fields[key] !== undefined) { sets.push(`${map[key]} = ?`); params.push(fields[key]); }
  }
  if (!sets.length) return;
  sets.push('updated_at = CURRENT_TIMESTAMP');
  await pool.execute(`UPDATE menus SET ${sets.join(', ')} WHERE id = ? AND shop_id = ?`, [...params, id, shopId]);
}

async function deleteMenu(id, shopId) {
  await pool.execute('DELETE FROM menus WHERE id = ? AND shop_id = ?', [id, shopId]);
}

// ---------------------------------------------------------------------------
// Option groups / items (ตัวเลือกในเมนู เช่น ระดับความเผ็ด, ทานที่ร้าน/ห่อกลับ)
// ---------------------------------------------------------------------------
async function listOptionGroups(shopId) {
  const [rows] = await pool.execute(
    'SELECT * FROM option_groups WHERE shop_id = ? ORDER BY sort_order ASC, id ASC',
    [shopId]
  );
  return rows;
}

async function findOptionGroupById(id, shopId) {
  const [rows] = await pool.execute('SELECT * FROM option_groups WHERE id = ? AND shop_id = ?', [id, shopId]);
  return rows[0] || null;
}

async function createOptionGroup({ shopId, name, required = 0, multi = 0, sortOrder = 0 }) {
  const [result] = await pool.execute(
    'INSERT INTO option_groups (shop_id, name, required, multi, sort_order) VALUES (?, ?, ?, ?, ?)',
    [shopId, name, required ? 1 : 0, multi ? 1 : 0, sortOrder]
  );
  return Number(result.insertId);
}

async function updateOptionGroup(id, shopId, fields) {
  const sets = [];
  const params = [];
  if (fields.name !== undefined) { sets.push('name = ?'); params.push(fields.name); }
  if (fields.required !== undefined) { sets.push('required = ?'); params.push(fields.required ? 1 : 0); }
  if (fields.multi !== undefined) { sets.push('multi = ?'); params.push(fields.multi ? 1 : 0); }
  if (fields.sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(fields.sortOrder); }
  if (sets.length) await pool.execute(`UPDATE option_groups SET ${sets.join(', ')} WHERE id = ? AND shop_id = ?`, [...params, id, shopId]);
}

async function deleteOptionGroup(id, shopId) {
  await pool.execute('DELETE FROM option_groups WHERE id = ? AND shop_id = ?', [id, shopId]);
}

async function listOptionItems(shopId) {
  const [rows] = await pool.execute(
    `SELECT oi.* FROM option_items oi
       JOIN option_groups g ON g.id = oi.group_id
      WHERE g.shop_id = ?
      ORDER BY oi.sort_order ASC, oi.id ASC`,
    [shopId]
  );
  return rows;
}

async function createOptionItem({ groupId, name, priceDelta = 0, sortOrder = 0, isDefault = 0 }) {
  const [result] = await pool.execute(
    'INSERT INTO option_items (group_id, name, price_delta, sort_order, is_default) VALUES (?, ?, ?, ?, ?)',
    [groupId, name, priceDelta, sortOrder, isDefault ? 1 : 0]
  );
  return Number(result.insertId);
}

/**
 * มาร์ค/ยกเลิกค่าเริ่มต้นของตัวเลือก
 * กลุ่มที่ "เลือกได้อย่างเดียว" มีค่าเริ่มต้นได้ทีละตัว — มาร์คตัวใหม่จะยกเลิกตัวเดิมในกลุ่มเดียวกันให้
 * @returns {Promise<{id:number, group_id:number, multi:number}|null>} null ถ้าไม่พบตัวเลือกในร้านนี้
 */
async function setOptionItemDefault(id, shopId, isDefault) {
  const [rows] = await pool.execute(
    `SELECT oi.id, oi.group_id, g.multi FROM option_items oi
       JOIN option_groups g ON g.id = oi.group_id
      WHERE oi.id = ? AND g.shop_id = ?`,
    [id, shopId]
  );
  const item = rows[0];
  if (!item) return null;
  if (isDefault && Number(item.multi) !== 1) {
    await pool.execute(
      'UPDATE option_items oi JOIN option_groups g ON g.id = oi.group_id SET oi.is_default = 0 WHERE oi.group_id = ? AND g.shop_id = ?',
      [item.group_id, shopId]
    );
  }
  await pool.execute(
    'UPDATE option_items oi JOIN option_groups g ON g.id = oi.group_id SET oi.is_default = ? WHERE oi.id = ? AND g.shop_id = ?',
    [isDefault ? 1 : 0, id, shopId]
  );
  return item;
}

async function findOptionItemOwned(id, shopId) {
  const [rows] = await pool.execute(
    `SELECT oi.* FROM option_items oi
       JOIN option_groups g ON g.id = oi.group_id
      WHERE oi.id = ? AND g.shop_id = ?`,
    [id, shopId]
  );
  return rows[0] || null;
}

async function updateOptionItem(id, shopId, fields) {
  const sets = [];
  const params = [];
  if (fields.name !== undefined) { sets.push('name = ?'); params.push(fields.name); }
  if (fields.priceDelta !== undefined) { sets.push('price_delta = ?'); params.push(fields.priceDelta); }
  if (fields.sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(fields.sortOrder); }
  if (!sets.length) return;
  await pool.execute(
    `UPDATE option_items oi JOIN option_groups g ON g.id = oi.group_id
        SET ${sets.join(', ')} WHERE oi.id = ? AND g.shop_id = ?`,
    [...params, id, shopId]
  );
}

async function deleteOptionItem(id, shopId) {
  await pool.execute(
    `DELETE oi FROM option_items oi JOIN option_groups g ON g.id = oi.group_id
      WHERE oi.id = ? AND g.shop_id = ?`,
    [id, shopId]
  );
}

// ผูกกลุ่มตัวเลือกกับเมนู
async function listMenuOptionGroups(shopId) {
  const [rows] = await pool.execute(
    `SELECT mog.menu_id, mog.group_id, mog.sort_order FROM menu_option_groups mog
       JOIN menus m ON m.id = mog.menu_id
      WHERE m.shop_id = ?`,
    [shopId]
  );
  return rows;
}

async function setMenuOptionGroups(menuId, groupIds) {
  await pool.execute('DELETE FROM menu_option_groups WHERE menu_id = ?', [menuId]);
  for (let i = 0; i < groupIds.length; i++) {
    await pool.execute(
      'INSERT INTO menu_option_groups (menu_id, group_id, sort_order) VALUES (?, ?, ?)',
      [menuId, groupIds[i], i]
    );
  }
}

// ---------------------------------------------------------------------------
// Shop purchases (บันทึกการซื้อแพ็กเกจ — จำลอง)
// ---------------------------------------------------------------------------
async function createShopPurchase({ userId, packageName = 'basic', packageId = null, paymentId = null, amount = 0, status = 'paid', startAt = null, expiresAt = null }) {
  const [result] = await pool.execute(
    'INSERT INTO shop_purchases (user_id, package, package_id, payment_id, amount, status, start_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, packageName, packageId, paymentId, amount, status, startAt, expiresAt]
  );
  return Number(result.insertId);
}

async function findShopPurchaseById(id) {
  const [rows] = await pool.execute('SELECT * FROM shop_purchases WHERE id = ?', [id]);
  return rows[0] || null;
}

/** วันสิ้นสุดสิทธิ์ที่ยังใช้งานได้ล่าสุดของผู้ใช้ (ไม่นับรายการที่ถูกดึงสิทธิ์กลับ/หมดอายุแล้ว) */
async function maxActiveEntitlement(userId) {
  const [rows] = await pool.execute(
    `SELECT MAX(expires_at) AS max_exp FROM shop_purchases
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at > UTC_TIMESTAMP()`,
    [userId]
  );
  return rows[0] && rows[0].max_exp ? rows[0].max_exp : null;
}

/** ดึงสิทธิ์กลับเฉพาะรายการซื้อนั้น (ไม่กระทบสิทธิ์จากรายการอื่น) */
async function revokeShopPurchase(id, revokedBy = null) {
  const [res] = await pool.execute(
    'UPDATE shop_purchases SET revoked_at = UTC_TIMESTAMP(), revoked_by = ? WHERE id = ? AND revoked_at IS NULL',
    [revokedBy, id]
  );
  return (res.affectedRows || 0) > 0;
}

async function findLatestShopPurchase(userId) {
  const [rows] = await pool.execute(
    'SELECT * FROM shop_purchases WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [userId]
  );
  return rows[0] || null;
}

/** ประวัติการซื้อแพ็กเกจของผู้ใช้รายหนึ่ง (ใช้ตอนผู้ใช้ขอสำเนาข้อมูลของตัวเองตาม PDPA) */
async function listPurchasesByUser(userId) {
  const [rows] = await pool.execute(
    `SELECT id, package, package_id, amount, status, start_at, expires_at, created_at
       FROM shop_purchases WHERE user_id = ? ORDER BY id DESC`,
    [userId]
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount) || 0 }));
}

/**
 * ประวัติการซื้อแพ็กเกจของลูกค้า (เฉพาะรายการที่ได้สิทธิ์แล้ว)
 * รองรับรายการเก่าที่ซื้อตอนยังไม่เปิดระบบชำระเงิน (ไม่มี payment_id → ถือเป็นโหมดทดลอง)
 */
async function listPurchaseHistory({ q = null, from = null, to = null, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (q) { where.push('u.email LIKE ?'); args.push('%' + q + '%'); }
  if (from) { where.push('sp.created_at >= ?'); args.push(from); }
  if (to) { where.push('sp.created_at <= ?'); args.push(to); }
  const n = Math.min(Math.max(Math.trunc(Number(limit)) || 200, 1), 500);
  const [rows] = await pool.execute(
    `SELECT sp.id, sp.user_id, sp.payment_id, sp.package AS package_name, sp.amount, sp.created_at,
            sp.start_at, sp.expires_at, sp.revoked_at,
            u.email AS user_email, u.role AS user_role, u.gift_expires_at AS user_expires,
            pp.ref, pp.method, pp.status AS pay_status, pp.confirmed_at, pp.duration_months AS pay_months,
            pp.slip_status, pp.notified,
            p.duration_months AS pkg_months
       FROM shop_purchases sp
       JOIN users u ON u.id = sp.user_id
       LEFT JOIN package_payments pp ON pp.id = sp.payment_id
       LEFT JOIN packages p ON p.id = sp.package_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY sp.id DESC LIMIT ${n}`,
    args
  );
  return rows;
}

/** สรุปยอดขายสำหรับหน้าประวัติ */
async function summarizePurchases() {
  const [all] = await pool.execute(
    'SELECT COUNT(id) AS count, COALESCE(SUM(amount), 0) AS total, COUNT(DISTINCT user_id) AS customers FROM shop_purchases'
  );
  const [month] = await pool.execute(
    "SELECT COUNT(id) AS count, COALESCE(SUM(amount), 0) AS total FROM shop_purchases WHERE created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')"
  );
  return {
    count: Number(all[0].count),
    total: Number(all[0].total),
    customers: Number(all[0].customers),
    monthCount: Number(month[0].count),
    monthTotal: Number(month[0].total),
  };
}

// ---------------------------------------------------------------------------
// Packages (แพ็กเกจร้านค้า) — owner สร้าง/แก้ไข แล้วผู้ใช้ทั่วไปซื้อเพื่อเปิดร้าน
// ---------------------------------------------------------------------------
function mapPackage(row) {
  if (!row) return null;
  let details = [];
  try { details = row.details_json ? JSON.parse(row.details_json) : []; } catch (err) { details = []; }
  if (!Array.isArray(details)) details = [];
  return { ...row, details };
}

async function listPackages() {
  const [rows] = await pool.execute('SELECT * FROM packages ORDER BY sort_order ASC, id ASC');
  return rows.map(mapPackage);
}

/** แพ็กเกจที่เปิดขาย (ใช้แสดงในหน้าซื้อแพ็กเกจของผู้ใช้) */
async function listActivePackages() {
  const [rows] = await pool.execute('SELECT * FROM packages WHERE active = 1 ORDER BY sort_order ASC, id ASC');
  return rows.map(mapPackage);
}

async function findPackageById(id) {
  const [rows] = await pool.execute('SELECT * FROM packages WHERE id = ?', [id]);
  return mapPackage(rows[0]);
}

async function createPackage({ name, durationMonths = 1, price = 0, details = [], active = true, sortOrder = 0 }) {
  const [result] = await pool.execute(
    'INSERT INTO packages (name, duration_months, price, details_json, active, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    [name, durationMonths, price, JSON.stringify(details), active ? 1 : 0, sortOrder]
  );
  return Number(result.insertId);
}

async function updatePackage(id, { name, durationMonths, price, details, active, sortOrder }) {
  await pool.execute(
    `UPDATE packages SET name = ?, duration_months = ?, price = ?, details_json = ?, active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [name, durationMonths, price, JSON.stringify(details), active ? 1 : 0, sortOrder, id]
  );
}

async function deletePackage(id) {
  await pool.execute('DELETE FROM packages WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// Package payments (การชำระเงินค่าแพ็กเกจ)
// ---------------------------------------------------------------------------
async function createPackagePayment({ userId, packageId, packageName, durationMonths = 1, amount = 0, method = 'promptpay', ref, note = '' }) {
  const [result] = await pool.execute(
    `INSERT INTO package_payments (user_id, package_id, package_name, duration_months, amount, method, ref, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, packageId, packageName, durationMonths, amount, method, ref, note]
  );
  return Number(result.insertId);
}

/** นาทีที่ลูกค้าต้องชำระเงินก่อนรายการหมดอายุ (ค่าเริ่มต้น 5 นาที) */
function getPaymentExpireMinutes() {
  const v = Number(getSetting('pay_expire_minutes'));
  return Number.isFinite(v) && v > 0 ? Math.min(Math.trunc(v), 60) : 5;
}

/** คอลัมน์เวลาที่เหลือก่อนหมดอายุ — คิดใน SQL เพื่อไม่ให้มีปัญหาเขตเวลา */
function secondsLeftSql(alias = '') {
  const col = alias ? alias + '.created_at' : 'created_at';
  return `TIMESTAMPDIFF(SECOND, NOW(), DATE_ADD(${col}, INTERVAL ${getPaymentExpireMinutes()} MINUTE))`;
}

/**
 * ยกเลิกรายการที่หมดเวลาและยังไม่ได้แจ้งโอน (ลูกค้าแนบสลิปไม่ทัน)
 * รายการที่แจ้งโอนแล้ว (notified = 1) จะไม่ถูกแตะ — ให้เจ้าของระบบตรวจเอง
 */
async function expireStalePayments() {
  const mins = getPaymentExpireMinutes();
  // ใช้สถานะ 'expired' แยกจาก 'rejected' — เจ้าของระบบยังกดยืนยันยอดได้ถ้าเงินเข้าจริง
  const [res] = await pool.execute(
    `UPDATE package_payments
        SET status = 'expired',
            note = 'หมดเวลาชำระเงิน (${mins} นาที) — ถ้าโอนแล้วแต่แนบสลิปไม่ทัน ผู้ดูแลระบบสามารถตรวจสลิปและเปิดสิทธิ์ให้ได้'
      WHERE status = 'pending' AND notified = 0
        AND created_at < DATE_SUB(NOW(), INTERVAL ${mins} MINUTE)`
  );
  return res.affectedRows || 0;
}

async function findPackagePaymentById(id) {
  const [rows] = await pool.execute(
    `SELECT pp.*, ${secondsLeftSql('pp')} AS seconds_left FROM package_payments pp WHERE pp.id = ?`,
    [id]
  );
  return rows[0] || null;
}

/** รายการที่ยังรอตรวจสอบของผู้ใช้คนหนึ่ง (กันสร้างซ้ำ) */
async function findPendingPackagePaymentByUser(userId) {
  const [rows] = await pool.execute(
    `SELECT pp.*, ${secondsLeftSql('pp')} AS seconds_left
       FROM package_payments pp
      WHERE pp.user_id = ? AND pp.status = 'pending' ORDER BY pp.id DESC LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function listPackagePayments({ status = null, userId = null, limit = 100 } = {}) {
  const where = [];
  const args = [];
  if (Array.isArray(status) && status.length) {
    where.push(`status IN (${status.map(() => '?').join(', ')})`);
    args.push(...status);
  } else if (status) { where.push('status = ?'); args.push(status); }
  if (userId) { where.push('user_id = ?'); args.push(userId); }
  // LIMIT ต้องใส่เป็นตัวเลขในสตริง — MySQL ไม่รับค่า ? ใน prepared statement (ER_WRONG_ARGUMENTS)
  const n = Math.min(Math.max(Math.trunc(Number(limit)) || 100, 1), 500);
  const [rows] = await pool.execute(
    `SELECT pp.*, ${secondsLeftSql('pp')} AS seconds_left FROM package_payments pp
      ${where.length ? 'WHERE ' + where.map((w) => 'pp.' + w).join(' AND ') : ''}
      ORDER BY pp.id DESC LIMIT ${n}`,
    args
  );
  return rows;
}

/**
 * ประวัติการชำระเงินของลูกค้าหนึ่งคน — ทุกสถานะ
 * ต่อกับ shop_purchases ผ่าน payment_id เพื่อบอกว่าแต่ละครั้งได้สิทธิ์ช่วงใด
 */
async function listMyPayments(userId, limit = 100) {
  const n = Math.min(Math.max(Math.trunc(Number(limit)) || 100, 1), 500);
  const [rows] = await pool.execute(
    `SELECT pp.id, pp.ref, pp.package_name, pp.duration_months, pp.amount, pp.method,
            pp.status, pp.notified, pp.created_at, pp.confirmed_at, pp.note,
            pp.slip_url, pp.slip_status,
            sp.id AS purchase_id, sp.start_at, sp.expires_at, sp.revoked_at
       FROM package_payments pp
       LEFT JOIN shop_purchases sp ON sp.payment_id = pp.id
      WHERE pp.user_id = ?
      ORDER BY pp.id DESC LIMIT ${n}`,
    [userId]
  );
  return rows;
}

/** แพ็กเกจที่ลูกค้าได้สิทธิ์โดยไม่มีรายการชำระเงิน (เช่น ผู้ดูแลระบบเปิดให้) */
async function listMyGrants(userId, limit = 50) {
  const n = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), 200);
  const [rows] = await pool.execute(
    `SELECT sp.id, sp.package AS package_name, sp.amount, sp.created_at,
            sp.start_at, sp.expires_at, sp.revoked_at
       FROM shop_purchases sp
      WHERE sp.user_id = ? AND sp.payment_id IS NULL
      ORDER BY sp.id DESC LIMIT ${n}`,
    [userId]
  );
  return rows;
}

/** หาเจ้าของไฟล์สลิปจากชื่อไฟล์ (รองรับทั้งรูปแบบใหม่ /api/payments/slip/x และข้อมูลเก่า /uploads/slips/x) */
async function findPaymentBySlipFile(name) {
  const file = String(name || '').trim();
  if (!file) return null;
  const [rows] = await pool.execute(
    'SELECT id, user_id FROM package_payments WHERE slip_url IN (?, ?) LIMIT 1',
    ['/api/payments/slip/' + file, '/uploads/slips/' + file]
  );
  return rows[0] || null;
}

async function markPackagePaymentNotified(id, { slipUrl = '', slipStatus = '', slipDetail = '', slipHash = '' } = {}) {  await pool.execute(
    `UPDATE package_payments
        SET notified = 1,
            slip_url = COALESCE(NULLIF(?, ''), slip_url),
            slip_status = ?, slip_detail = ?, slip_hash = COALESCE(NULLIF(?, ''), slip_hash)
      WHERE id = ? AND status = 'pending'`,
    [slipUrl, slipStatus, slipDetail, slipHash, id]
  );
}

/** หารายการอื่นที่ใช้ไฟล์สลิปเดียวกันไปแล้ว (กันอัพสลิปซ้ำข้ามรายการ) */
async function findPaymentBySlipHash(hash, excludeId = 0) {
  if (!hash) return null;
  const [rows] = await pool.execute(
    'SELECT id, ref, status FROM package_payments WHERE slip_hash = ? AND id <> ? LIMIT 1',
    [hash, excludeId]
  );
  return rows[0] || null;
}

/** เก็บไฟล์สลิป + ผลตรวจ (ใช้เมื่อเจ้าของระบบแนบสลิปแทนลูกค้า — ไม่แตะสถานะ notified) */
async function setPackagePaymentSlip(id, { slipUrl = '', slipStatus = '', slipDetail = '', slipHash = '' }) {
  await pool.execute(
    `UPDATE package_payments
        SET slip_url = COALESCE(NULLIF(?, ''), slip_url),
            slip_status = ?, slip_detail = ?, slip_hash = COALESCE(NULLIF(?, ''), slip_hash)
      WHERE id = ?`,
    [slipUrl, slipStatus, slipDetail, slipHash, id]
  );
}

async function setPackagePaymentStatus(id, status, { confirmedBy = null, note = null } = {}) {
  const sets = ['status = ?'];
  const args = [status];
  if (confirmedBy) { sets.push('confirmed_by = ?'); args.push(confirmedBy); }
  if (confirmedBy) sets.push('confirmed_at = CURRENT_TIMESTAMP');
  if (note !== null) { sets.push('note = ?'); args.push(note); }
  args.push(id);
  await pool.execute(`UPDATE package_payments SET ${sets.join(', ')} WHERE id = ?`, args);
}

// ---------------------------------------------------------------------------
// Tables (โต๊ะ) + Orders (บิล/ออเดอร์) — ระบบสั่งอาหาร
// ---------------------------------------------------------------------------
// เฉพาะโต๊ะที่ใช้งานอยู่ (ยังไม่ถูกปิดใช้งาน) — โต๊ะที่ปิดแล้วยังอยู่ในฐานข้อมูลเพื่อเป็นประวัติ/หลักฐาน
async function listTables(shopId) {
  const [rows] = await pool.execute(
    'SELECT * FROM `tables` WHERE shop_id = ? AND retired_at IS NULL ORDER BY code ASC',
    [shopId]
  );
  return rows;
}

/** โต๊ะที่ยังใช้งานอยู่ (ใช้กับทุกคำสั่งของร้าน: เปลี่ยนชื่อ/รับออเดอร์/เช็คบิล) */
async function findTableById(id, shopId) {
  const [rows] = await pool.execute(
    'SELECT * FROM `tables` WHERE id = ? AND shop_id = ? AND retired_at IS NULL',
    [id, shopId]
  );
  return rows[0] || null;
}

/** โต๊ะทุกสถานะ รวมที่ปิดใช้งานแล้ว (ใช้ดูประวัติ/ดึงรูป QR ย้อนหลัง) */
async function findTableByIdAny(id, shopId) {
  const [rows] = await pool.execute('SELECT * FROM `tables` WHERE id = ? AND shop_id = ?', [id, shopId]);
  return rows[0] || null;
}

async function findTableByCode(shopId, code) {
  const [rows] = await pool.execute(
    'SELECT * FROM `tables` WHERE shop_id = ? AND code = ? AND retired_at IS NULL',
    [shopId, code]
  );
  return rows[0] || null;
}

/** โต๊ะที่สั่งอาหารได้ (เจ้าของร้านยังเป็น shop และของขวัญไม่หมดอายุ) + ข้อมูลร้าน
 *  โต๊ะที่ถูกปิดใช้งานแล้วจะสั่งไม่ได้ (แม้แถวยังอยู่เพื่อเก็บประวัติ) */
async function findOrderableTableByToken(token) {
  const [rows] = await pool.execute(
    `SELECT t.id, t.shop_id, t.code, t.token,
            s.name AS shop_name, s.public_code, s.logo_url, s.phone, s.line_url, s.maps_url
       FROM \`tables\` t
       JOIN shops s ON s.id = t.shop_id
       JOIN users u ON u.id = s.user_id
      WHERE t.token = ? AND t.retired_at IS NULL AND s.status = 'active' AND u.role = 'shop'
        AND (u.gift_expires_at IS NULL OR u.gift_expires_at > UTC_TIMESTAMP())
      LIMIT 1`,
    [token]
  );
  return rows[0] || null;
}

async function createTable({ shopId, code, token }) {
  const [result] = await pool.execute('INSERT INTO `tables` (shop_id, code, token) VALUES (?, ?, ?)', [shopId, code, token]);
  return Number(result.insertId);
}

async function updateTableCode(id, shopId, code) {
  await pool.execute('UPDATE `tables` SET code = ? WHERE id = ? AND shop_id = ?', [code, id, shopId]);
  // บิลที่ยังเปิดอยู่ของโต๊ะนี้ให้ใช้ชื่อใหม่ด้วย (บิลที่ปิดแล้วเก็บชื่อเดิมไว้เป็นประวัติ)
  await pool.execute(
    "UPDATE orders SET table_code = ? WHERE shop_id = ? AND table_id = ? AND status = 'open'",
    [code, shopId, id]
  );
}

/** ปิดใช้งาน QR ของโต๊ะ (soft): ไม่ลบแถวทิ้ง เพื่อเก็บไว้เป็นประวัติ/หลักฐาน
 *  โต๊ะที่ปิดแล้วจะไม่ขึ้นในรายการโต๊ะ และสแกน QR เดิมก็สั่งอาหารไม่ได้อีก */
async function retireTable(id, shopId) {
  await pool.execute(
    'UPDATE `tables` SET retired_at = UTC_TIMESTAMP(), retire_seq = id WHERE id = ? AND shop_id = ? AND retired_at IS NULL',
    [id, shopId]
  );
}

/** โต๊ะ/QR ที่ถูกปิดใช้งานแล้ว (ประวัติ) พร้อมยอดขายที่เคยเกิดขึ้นบนโต๊ะนั้น */
async function listRetiredTables(shopId) {
  const [rows] = await pool.execute(
    `SELECT t.id, t.code, t.token, t.created_at, t.retired_at,
            COALESCE(z.name, '') AS zone_name,
            (SELECT COUNT(*) FROM orders o WHERE o.table_id = t.id AND o.status = 'closed') AS bill_count,
            (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.table_id = t.id AND o.status = 'closed') AS total_sales
       FROM \`tables\` t
       LEFT JOIN table_names n ON n.shop_id = t.shop_id AND n.name = t.code
       LEFT JOIN zones z ON z.id = n.zone_id
      WHERE t.shop_id = ? AND t.retired_at IS NOT NULL
      ORDER BY t.retired_at DESC, t.id DESC`,
    [shopId]
  );
  return rows.map((r) => ({
    ...r,
    bill_count: Number(r.bill_count) || 0,
    total_sales: Number(r.total_sales) || 0,
  }));
}

// ---------------------------------------------------------------------------
// รายชื่อโต๊ะ (แคตตาล็อกชื่อโต๊ะ) + โทเคน QR ที่ถูกยกเลิก
// ---------------------------------------------------------------------------
/** ชื่อโต๊ะทั้งหมด พร้อมโซนและบอกว่าตอนนี้มี QR (โต๊ะ) ที่ใช้งานอยู่แล้วหรือยัง */
async function listTableNamesWithQr(shopId) {
  const [rows] = await pool.execute(
    `SELECT n.id, n.name, n.sort_order, n.zone_id, z.name AS zone_name,
            COALESCE(z.sort_order, 9999) AS zone_sort, t.id AS table_id
       FROM table_names n
       LEFT JOIN zones z ON z.id = n.zone_id
       LEFT JOIN \`tables\` t ON t.shop_id = n.shop_id AND t.code = n.name AND t.retired_at IS NULL
      WHERE n.shop_id = ?
      ORDER BY COALESCE(z.sort_order, 9999) ASC, n.sort_order ASC, n.id ASC`,
    [shopId]
  );
  return rows;
}

/** กำหนดโซนให้ชื่อโต๊ะ (null = ไม่ระบุโซน) */
async function setTableNameZone(id, shopId, zoneId) {
  await pool.execute('UPDATE table_names SET zone_id = ? WHERE id = ? AND shop_id = ?', [zoneId || null, id, shopId]);
}

/** ตั้งลำดับการแสดงของชื่อโต๊ะตามรายการ id ที่ส่งมา (ลำดับที่ 1,2,3, ...) */
async function reorderTableNames(shopId, ids) {
  for (let i = 0; i < ids.length; i++) {
    await pool.execute('UPDATE table_names SET sort_order = ? WHERE id = ? AND shop_id = ?', [i + 1, Number(ids[i]) || 0, shopId]);
  }
}

// ---------------------------------------------------------------------------
// โซน (จัดกลุ่มโต๊ะ)
// ---------------------------------------------------------------------------
async function listZones(shopId) {
  const [rows] = await pool.execute(
    `SELECT z.id, z.name, z.sort_order,
            (SELECT COUNT(*) FROM table_names n WHERE n.zone_id = z.id) AS table_count
       FROM zones z
      WHERE z.shop_id = ?
      ORDER BY z.sort_order ASC, z.id ASC`,
    [shopId]
  );
  return rows.map((z) => ({ ...z, table_count: Number(z.table_count) || 0 }));
}

async function findZoneById(id, shopId) {
  const [rows] = await pool.execute('SELECT * FROM zones WHERE id = ? AND shop_id = ?', [id, shopId]);
  return rows[0] || null;
}

async function findZoneByName(shopId, name) {
  const [rows] = await pool.execute('SELECT * FROM zones WHERE shop_id = ? AND name = ?', [shopId, name]);
  return rows[0] || null;
}

async function createZone({ shopId, name }) {
  const [rows] = await pool.execute('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM zones WHERE shop_id = ?', [shopId]);
  const [result] = await pool.execute('INSERT INTO zones (shop_id, name, sort_order) VALUES (?, ?, ?)', [shopId, name, Number(rows[0].n) || 1]);
  return Number(result.insertId);
}

async function renameZone(id, shopId, name) {
  await pool.execute('UPDATE zones SET name = ? WHERE id = ? AND shop_id = ?', [name, id, shopId]);
}

async function deleteZone(id, shopId) {
  // ชื่อโต๊ะในโซนนี้จะกลายเป็น "ไม่ระบุโซน" (ไม่ลบชื่อทิ้ง)
  await pool.execute('UPDATE table_names SET zone_id = NULL WHERE zone_id = ? AND shop_id = ?', [id, shopId]);
  await pool.execute('DELETE FROM zones WHERE id = ? AND shop_id = ?', [id, shopId]);
}

async function reorderZones(shopId, ids) {
  for (let i = 0; i < ids.length; i++) {
    await pool.execute('UPDATE zones SET sort_order = ? WHERE id = ? AND shop_id = ?', [i + 1, Number(ids[i]) || 0, shopId]);
  }
}


async function findTableNameById(id, shopId) {
  const [rows] = await pool.execute('SELECT * FROM table_names WHERE id = ? AND shop_id = ?', [id, shopId]);
  return rows[0] || null;
}

async function findTableNameByName(shopId, name) {
  const [rows] = await pool.execute('SELECT * FROM table_names WHERE shop_id = ? AND name = ?', [shopId, name]);
  return rows[0] || null;
}

/** เพิ่มชื่อโต๊ะเข้ารายชื่อ (ถ้ามีอยู่แล้วไม่ต้องทำอะไร) */
async function ensureTableName({ shopId, name }) {
  await pool.execute('INSERT IGNORE INTO table_names (shop_id, name) VALUES (?, ?)', [shopId, name]);
}

async function deleteTableName(id, shopId) {
  await pool.execute('DELETE FROM table_names WHERE id = ? AND shop_id = ?', [id, shopId]);
}

/** บันทึกว่าโทเคนนี้ถูกยกเลิกแล้ว — จะไม่ถูกนำกลับมาใช้กับโต๊ะใดอีก */
async function retireTableToken(token, shopId) {
  if (!token) return;
  await pool.execute('INSERT IGNORE INTO retired_table_tokens (token, shop_id) VALUES (?, ?)', [token, shopId]);
}

/** โทเคนนี้ถูกใช้อยู่ หรือเคยถูกยกเลิกไปแล้วหรือยัง */
async function isTableTokenTaken(token) {
  const [rows] = await pool.execute(
    'SELECT 1 FROM `tables` WHERE token = ? UNION ALL SELECT 1 FROM retired_table_tokens WHERE token = ? LIMIT 1',
    [token, token]
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// กลุ่มแจ้งเตือน (LINE / Telegram)
// ---------------------------------------------------------------------------
async function listNotifyGroups(shopId) {
  const [rows] = await pool.execute(
    'SELECT * FROM notify_groups WHERE shop_id = ? ORDER BY id ASC',
    [shopId]
  );
  return rows;
}

/** เฉพาะกลุ่มที่เปิดใช้งาน (ใช้ตอนยิงแจ้งเตือนจริง) */
async function listActiveNotifyGroups(shopId) {
  const [rows] = await pool.execute(
    'SELECT * FROM notify_groups WHERE shop_id = ? AND active = 1 ORDER BY id ASC',
    [shopId]
  );
  return rows;
}

async function findNotifyGroupById(id, shopId) {
  const [rows] = await pool.execute('SELECT * FROM notify_groups WHERE id = ? AND shop_id = ?', [id, shopId]);
  return rows[0] || null;
}

// ระบบนี้แจ้งเตือนทาง Telegram เท่านั้น — คอลัมน์ channel/line_* ยังอยู่ในตารางเดิม
// (ไม่ drop เพื่อไม่ให้ข้อมูลเก่าหาย) แต่ไม่ถูกใช้แล้ว จึงบันทึก channel เป็น 'telegram' เสมอ
async function createNotifyGroup(g) {
  const [result] = await pool.execute(
    `INSERT INTO notify_groups
       (shop_id, name, channel, active, tg_token, tg_chat, tg_thread, events_json)
     VALUES (?, ?, 'telegram', ?, ?, ?, ?, ?)`,
    [
      g.shopId, g.name, g.active ? 1 : 0,
      g.tgToken || '', g.tgChat || '', g.tgThread || '',
      g.eventsJson || null,
    ]
  );
  return Number(result.insertId);
}

async function updateNotifyGroup(id, shopId, fields) {
  const sets = [];
  const params = [];
  const map = {
    name: 'name', active: 'active',
    tgToken: 'tg_token', tgChat: 'tg_chat', tgThread: 'tg_thread',
    eventsJson: 'events_json',
  };
  for (const [key, column] of Object.entries(map)) {
    if (fields[key] !== undefined) { sets.push(`${column} = ?`); params.push(key === 'active' ? (fields[key] ? 1 : 0) : fields[key]); }
  }
  if (!sets.length) return;
  sets.push('updated_at = UTC_TIMESTAMP()');
  await pool.execute(`UPDATE notify_groups SET ${sets.join(', ')} WHERE id = ? AND shop_id = ?`, [...params, id, shopId]);
}

async function deleteNotifyGroup(id, shopId) {
  await pool.execute('DELETE FROM notify_groups WHERE id = ? AND shop_id = ?', [id, shopId]);
}

/** เก็บผลการส่งล่าสุดไว้โชว์บนหน้าเว็บ (ไม่ให้ล้มเหลวแล้วพังการบันทึก) */
async function setNotifyGroupResult(id, ok, status) {
  await pool.execute(
    'UPDATE notify_groups SET last_ok = ?, last_status = ?, last_at = UTC_TIMESTAMP() WHERE id = ?',
    [ok ? 1 : 0, String(status || '').slice(0, 255), id]
  );
}

async function findOpenOrder(shopId, tableId) {
  const [rows] = await pool.execute(
    "SELECT * FROM orders WHERE shop_id = ? AND table_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
    [shopId, tableId]
  );
  return rows[0] || null;
}

async function findOrderById(id, shopId) {
  const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ? AND shop_id = ?', [id, shopId]);
  return rows[0] || null;
}

async function createOrder({ shopId, tableId }) {
  // เลขที่บิลรันต่อร้าน (เริ่มที่ 1)
  const [rows] = await pool.execute('SELECT COALESCE(MAX(bill_no),0)+1 AS n FROM orders WHERE shop_id = ?', [shopId]);
  const billNo = Number(rows[0].n) || 1;
  // เก็บชื่อโต๊ะไว้ในบิลด้วย เพื่อให้ใบเสร็จ/ประวัติยังแสดงชื่อได้แม้โต๊ะและ QR ถูกลบไปแล้ว
  const [t] = await pool.execute('SELECT code FROM `tables` WHERE id = ? AND shop_id = ?', [tableId, shopId]);
  const tableCode = t[0] ? t[0].code : '';
  const [result] = await pool.execute(
    "INSERT INTO orders (shop_id, table_id, table_code, status, bill_no) VALUES (?, ?, ?, 'open', ?)",
    [shopId, tableId, tableCode, billNo]
  );
  return Number(result.insertId);
}

async function listOrderItems(orderId) {
  const [rows] = await pool.execute('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [orderId]);
  return rows;
}

async function recalcOrderTotal(orderId) {
  await pool.execute(
    "UPDATE orders SET total = (SELECT COALESCE(SUM(line_total),0) FROM order_items WHERE order_id = ? AND status <> 'cancelled') WHERE id = ?",
    [orderId, orderId]
  );
}

async function addOrderItems(orderId, items) {
  for (const it of items) {
    await pool.execute(
      'INSERT INTO order_items (order_id, menu_id, menu_name, unit_price, quantity, options_json, options_ids_json, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [orderId, it.menuId || null, it.menuName, it.unitPrice, it.quantity, it.optionsJson || null, it.optionsIdsJson || null, it.lineTotal]
    );
  }
  await recalcOrderTotal(orderId);
}

/** รายการอาหารของบิลที่ยังเปิดอยู่ทั้งหมด (สำหรับหน้าครัว) — ไม่รวมรายการที่ถูกยกเลิก */
/** รายการในบิลที่เปิดอยู่ แยกตามจุดแสดงผล: station = 'kitchen' (ครัว) | 'cashier' (แคชเชียร์)
 *  เรียงตามลำดับที่ลูกค้าสั่ง (คิวก่อน-หลัง) — เปลี่ยนสถานะแล้วตำแหน่งไม่ขยับ
 *  ยกเว้นรายการที่ "เสร็จแล้ว" จะจมไปล่างสุดเสมอ และรายการใหม่ต่อท้ายคิว (เหนือกลุ่มที่เสร็จแล้ว) */
async function listKitchenItems(shopId, station = 'kitchen') {
  const st = station === 'cashier' ? 'cashier' : 'kitchen';
  const [rows] = await pool.execute(
    `SELECT oi.id, oi.order_id, oi.menu_id, oi.menu_name, oi.quantity, oi.options_json, oi.status,
            oi.created_at, oi.started_at, oi.done_at, o.bill_no,
            COALESCE(NULLIF(o.table_code,''), t.code, '') AS table_code,
            m.image_url, COALESCE(c.station, 'kitchen') AS station
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN \`tables\` t ON t.id = o.table_id
       LEFT JOIN menus m ON m.id = oi.menu_id
       LEFT JOIN categories c ON c.id = m.category_id
      WHERE o.shop_id = ? AND o.status = 'open' AND oi.status <> 'cancelled'
        AND COALESCE(c.station, 'kitchen') = ?
      ORDER BY (oi.status = 'done') ASC, oi.id ASC`,
    [shopId, st]
  );
  return rows;
}

async function findOrderItemOwned(id, shopId) {
  const [rows] = await pool.execute(
    `SELECT oi.*, o.status AS order_status, COALESCE(NULLIF(o.table_code,''), t.code, '') AS table_code
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN \`tables\` t ON t.id = o.table_id
      WHERE oi.id = ? AND o.shop_id = ?`,
    [id, shopId]
  );
  return rows[0] || null;
}

/** เปลี่ยนสถานะรายจาน (เฉพาะบิลที่ยังเปิดอยู่) */
async function setOrderItemStatus(id, shopId, status) {
  const sets = ['oi.status = ?'];
  const params = [status];
  if (status === 'cooking') sets.push('oi.started_at = COALESCE(oi.started_at, UTC_TIMESTAMP())');
  if (status === 'done') sets.push('oi.done_at = COALESCE(oi.done_at, UTC_TIMESTAMP())');
  await pool.execute(
    `UPDATE order_items oi JOIN orders o ON o.id = oi.order_id
        SET ${sets.join(', ')}
      WHERE oi.id = ? AND o.shop_id = ? AND o.status = 'open'`,
    [...params, id, shopId]
  );
}

/** ยกเลิกรายการ (ไม่ลบ แต่ทำเครื่องหมาย cancelled + เก็บสาเหตุ) แล้วคิดยอดใหม่ */
async function cancelOrderItem(id, orderId, reason) {
  await pool.execute(
    "UPDATE order_items SET status = 'cancelled', cancel_reason = ? WHERE id = ? AND order_id = ?",
    [reason ? String(reason).slice(0, 255) : null, id, orderId]
  );
  await recalcOrderTotal(orderId);
}

/** ลบรายการออกจากบิลจริง ๆ (ใช้ตอนแคชเชียร์ลบ) แล้วคิดยอดใหม่ */
async function deleteOrderItem(id, orderId) {
  await pool.execute('DELETE FROM order_items WHERE id = ? AND order_id = ?', [id, orderId]);
  await recalcOrderTotal(orderId);
}

async function closeOrder(orderId) {
  await pool.execute("UPDATE orders SET status = 'closed', closed_at = UTC_TIMESTAMP() WHERE id = ?", [orderId]);
}

/** ลบบิลที่ยังเปิดอยู่และยังไม่มีรายการ (ตั๋วเปล่าของโต๊ะที่ถูกลบไปแล้ว)
 *  บิลที่มีรายการแล้วต้อง "เช็คบิล" เท่านั้น เพื่อไม่ให้ประวัติหาย */
async function deleteOrder(id, shopId) {
  await pool.execute(
    `DELETE o FROM orders o
      WHERE o.id = ? AND o.shop_id = ? AND o.status = 'open'
        AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id)`,
    [id, shopId]
  );
}

async function listOpenOrders(shopId) {
  const [rows] = await pool.execute(
    `SELECT o.id, o.table_id, o.total, o.opened_at, o.bill_no, COALESCE(NULLIF(o.table_code,''), t.code, '') AS table_code,
            (SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi WHERE oi.order_id = o.id AND oi.status <> 'cancelled') AS item_count
       FROM orders o LEFT JOIN \`tables\` t ON t.id = o.table_id
      WHERE o.shop_id = ? AND o.status = 'open'
      ORDER BY table_code ASC`,
    [shopId]
  );
  // SUM() ของ MySQL คืนค่าเป็นสตริง (เช่น "0") — แปลงเป็นตัวเลขก่อน ไม่งั้นเงื่อนไข if ฝั่งหน้าเว็บจะเห็นเป็นจริง
  return rows.map((r) => ({ ...r, item_count: Number(r.item_count) || 0 }));
}

// ประวัติบิลที่ปิดแล้ว (ดูย้อนหลัง) — กรองตามโต๊ะได้
// หมายเหตุ: ใช้ชื่อโต๊ะที่เก็บไว้ในบิล (o.table_code) เพราะบิลที่เช็คบิลแล้วต้องอยู่ต่อแม้โต๊ะ/QR ถูกลบ
async function listClosedOrders(shopId, { tableId = null, limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  let sql = `SELECT o.id, o.table_id, o.bill_no, o.total, o.opened_at, o.closed_at,
                    COALESCE(NULLIF(o.table_code,''), t.code, '') AS table_code,
                    (SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi WHERE oi.order_id = o.id AND oi.status <> 'cancelled') AS item_count
               FROM orders o LEFT JOIN \`tables\` t ON t.id = o.table_id
              WHERE o.shop_id = ? AND o.status = 'closed'`;
  const params = [shopId];
  if (tableId) { sql += ' AND o.table_id = ?'; params.push(tableId); }
  sql += ` ORDER BY o.closed_at DESC, o.id DESC LIMIT ${safeLimit}`;
  const [rows] = await pool.execute(sql, params);
  return rows.map((r) => ({ ...r, item_count: Number(r.item_count) || 0 }));
}

// รายการของหลายบิลพร้อมกัน (สำหรับหน้าประวัติ)
async function listItemsForOrders(orderIds) {
  if (!Array.isArray(orderIds) || !orderIds.length) return [];
  const ph = orderIds.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT * FROM order_items WHERE order_id IN (${ph}) ORDER BY id ASC`,
    orderIds.map(Number)
  );
  return rows;
}

module.exports = {
  initDb,
  getSetting,
  setSetting,
  findUserByEmail,
  findUserById,
  createUser,
  setUserStatus,
  updatePendingUser,
  createGooglePendingUser,
  linkGoogle,
  completeGoogleSetup,
  setEmailVerified,
  createSession,
  findSession,
  deleteSession,
  deleteExpiredSessions,
  createOtp,
  setOtpNote,
  findLatestOtp,
  findLatestOtpContact,
  markOtpUsed,
  incrementOtpAttempts,
  createEmailToken,
  findEmailTokenByHash,
  markEmailTokenUsed,
  updateUserPassword,
  recordTermsConsent,
  createPasswordReset,
  findPasswordResetByHash,
  markPasswordResetUsed,
  deleteUserSessions,
  deleteOtherSessions,
  findOwner,
  createOwnerUser,
  listOtpLogs,
  countStats,
  listUsers,
  countUsers,
  countOwners,
  updateUserByAdmin,
  deleteUser,
  setUserRole,
  setShopGift,
  setUserShopExpiry,
  expireShopGift,
  clearExpiredGifts,
  findPublicShopByCode,
  findShopByUserId,
  createShop,
  updateShop,
  listCategories,
  findCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  listMenus,
  findMenuById,
  createMenu,
  updateMenu,
  deleteMenu,
  listOptionGroups,
  findOptionGroupById,
  createOptionGroup,
  updateOptionGroup,
  deleteOptionGroup,
  listOptionItems,
  createOptionItem,
  findOptionItemOwned,
  updateOptionItem,
  setOptionItemDefault,
  deleteOptionItem,
  listMenuOptionGroups,
  setMenuOptionGroups,
  createShopPurchase,
  findLatestShopPurchase,
  listPurchasesByUser,
  findShopPurchaseById,
  maxActiveEntitlement,
  revokeShopPurchase,
  listPurchaseHistory,
  summarizePurchases,
  listPackages,
  listActivePackages,
  findPackageById,
  createPackage,
  updatePackage,
  deletePackage,
  createPackagePayment,
  findPackagePaymentById,
  findPendingPackagePaymentByUser,
  listPackagePayments,
  listMyPayments,
  listMyGrants,
  markPackagePaymentNotified,
  findPaymentBySlipFile,
  findPaymentBySlipHash,
  setPackagePaymentSlip,
  setPackagePaymentStatus,
  getPaymentExpireMinutes,
  expireStalePayments,
  listTables,
  findTableById,
  findTableByIdAny,
  findTableByCode,
  findOrderableTableByToken,
  createTable,
  updateTableCode,
  retireTable,
  listRetiredTables,
  listTableNamesWithQr,
  setTableNameZone,
  reorderTableNames,
  listZones,
  findZoneById,
  findZoneByName,
  createZone,
  renameZone,
  deleteZone,
  reorderZones,
  findTableNameById,
  findTableNameByName,
  ensureTableName,
  deleteTableName,
  retireTableToken,
  isTableTokenTaken,
  listNotifyGroups,
  listActiveNotifyGroups,
  findNotifyGroupById,
  createNotifyGroup,
  updateNotifyGroup,
  deleteNotifyGroup,
  setNotifyGroupResult,
  findOpenOrder,
  findOrderById,
  createOrder,
  listOrderItems,
  addOrderItems,
  closeOrder,
  deleteOrder,
  listOpenOrders,
  listClosedOrders,
  listItemsForOrders,
  recalcOrderTotal,
  listKitchenItems,
  findOrderItemOwned,
  setOrderItemStatus,
  cancelOrderItem,
  deleteOrderItem,
};

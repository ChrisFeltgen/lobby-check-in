'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { resolveAvailability, isScheduleActiveAt } = require('./availability');
const catalog = require('./catalog');
const { seedCatalog, seedAddedWording } = require('./catalog-seed');
// Services are shown in kiosk rows, and in order within a row. One with no row yet goes last.
const SERVICE_ORDER = 'kiosk_row IS NULL, kiosk_row, sort_order, name';
const { UI_STRINGS } = require('./ui-strings');

// All database access lives in this file so the rest of the app stays engine-agnostic.
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE) || 10,
  charset: 'utf8mb4',
});

function toTicket(row) {
  return {
    id: row.id,
    serviceCode: row.service_code,
    customerName: row.customer_name,
    ticketNumber: row.ticket_number,
    status: row.status,
    counter: row.counter,
    createdAt: row.created_at,
    calledAt: row.called_at,
    completedAt: row.completed_at,
    appointmentWith: row.appointment_with || null,
    appointmentTime: row.appointment_time || null,
    calledBy: row.called_by || null,
  };
}

// Adds a column that older installs lack. MySQL 8 has no ADD COLUMN IF NOT EXISTS, so check first.
async function ensureColumn(conn, table, column, definition) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (row.n) return false;
  await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  return true;
}

// Settings values were first stored in VARCHAR(255), which cut off a logo. Widen the column if it is still that size.
async function ensureSettingValueType(conn) {
  const [[row]] = await conn.query(
    `SELECT DATA_TYPE AS t FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'app_settings' AND COLUMN_NAME = 'setting_value'`
  );
  if (row && row.t !== 'mediumtext') {
    await conn.query('ALTER TABLE app_settings MODIFY setting_value MEDIUMTEXT NOT NULL');
  }
}

// Adds 'serving' to the ticket status enum for installs created before the Start action existed.
async function ensureServingStatus(conn) {
  const [[row]] = await conn.query(
    `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tickets' AND COLUMN_NAME = 'status'`
  );
  if (row && !row.t.includes("'serving'")) {
    await conn.query(
      `ALTER TABLE tickets MODIFY COLUMN status ENUM('waiting','called','serving','served','removed') NOT NULL DEFAULT 'waiting'`
    );
  }
}

// Runs db/schema.sql. Every statement is idempotent, so this is safe on each startup.
// CREATE statements run first, then any columns newer than the table are added, then the seed data.
// Splits schema.sql into single statements. The file must not put a semicolon inside a comment,
// because this split doesn't know about comments (tests/schema.test.js checks for that).
function splitStatements(sql) {
  return sql.split(';').map((s) => s.trim()).filter(Boolean);
}

// The statements in schema.sql that put the default services in place. They belong to the first start only:
// once the catalogue has been set up, an admin may delete a default service or reuse a retired code, and a
// later restart must not undo that.
function isDefaultServiceStatement(statement) {
  const code = statement.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n').trim();
  return /^(INSERT\s+(IGNORE\s+)?INTO|UPDATE)\s+services\b/i.test(code);
}

// Gives every service without a row one, so the kiosk looks as it did before rows could be chosen: the active
// services in their order, at most 4 to a row. Turned-off services go on the last row. Only services with no row
// are touched, so this does nothing once rows have been set.
async function backfillKioskRows(conn) {
  const [missing] = await conn.query('SELECT code, active FROM services WHERE kiosk_row IS NULL ORDER BY active DESC, sort_order, name');
  if (!missing.length) return;
  const [[last]] = await conn.query('SELECT COALESCE(MAX(kiosk_row), 0) AS m FROM services');
  const active = missing.filter((s) => s.active);
  const sizes = catalog.layoutRows(active.length);
  let row = Number(last.m);
  let index = 0;
  for (const size of sizes) {
    row += 1;
    for (const s of active.slice(index, index + size)) await conn.query('UPDATE services SET kiosk_row = ? WHERE code = ?', [row, s.code]);
    index += size;
  }
  const lastRow = Math.max(row, 1);
  for (const s of missing.filter((x) => !x.active)) await conn.query('UPDATE services SET kiosk_row = ? WHERE code = ?', [lastRow, s.code]);
}

async function init() {
  const sql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  const statements = splitStatements(sql);
  const conn = await pool.getConnection();
  try {
    for (const stmt of statements.filter((s) => s.startsWith('CREATE'))) {
      await conn.query(stmt);
    }
    await ensureColumn(conn, 'services', 'route', 'VARCHAR(100) NULL');
    await ensureColumn(conn, 'tickets', 'appointment_with', 'VARCHAR(100) NULL');
    await ensureColumn(conn, 'tickets', 'appointment_time', 'VARCHAR(20) NULL');
    await ensureColumn(conn, 'tickets', 'called_by', 'VARCHAR(100) NULL');
    await ensureColumn(conn, 'services', 'manual_override', "ENUM('none','closed','open') NOT NULL DEFAULT 'none'");
    await ensureColumn(conn, 'services', 'manual_message', 'VARCHAR(200) NULL');
    await ensureColumn(conn, 'services', 'manual_override_expires_at', 'DATETIME NULL');
    await ensureColumn(conn, 'users', 'must_change_password', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumn(conn, 'users', 'default_queues', 'TEXT NULL');
    await ensureColumn(conn, 'users', 'sessions_revoked_at', 'BIGINT NULL');
    await ensureSettingValueType(conn);
    await ensureColumn(conn, 'services', 'description', 'VARCHAR(255) NULL');
    await ensureColumn(conn, 'services', 'icon', 'VARCHAR(40) NULL');
    await ensureColumn(conn, 'services', 'color', 'VARCHAR(7) NULL');
    await ensureColumn(conn, 'services', 'group_id', 'VARCHAR(40) NULL');
    await ensureColumn(conn, 'services', 'kiosk_row', 'INT NULL');
    // Before these two columns, the appointment questions and the pinned queue belonged to the code AC alone.
    // An install that already has that service keeps both behaviours; a new one gets them when the catalogue is seeded.
    const addedAppointment = await ensureColumn(conn, 'services', 'asks_appointment', 'TINYINT(1) NOT NULL DEFAULT 0');
    const addedPinned = await ensureColumn(conn, 'services', 'pinned', 'TINYINT(1) NOT NULL DEFAULT 0');
    if (addedAppointment || addedPinned) await conn.query("UPDATE services SET asks_appointment = 1, pinned = 1 WHERE code = 'AC'");
    await ensureServingStatus(conn);
    const [[seeded]] = await conn.query("SELECT COUNT(*) AS n FROM app_settings WHERE setting_key = 'catalog_seeded'");
    for (const stmt of statements.filter((s) => !s.startsWith('CREATE'))) {
      if (seeded.n && isDefaultServiceStatement(stmt)) continue;
      await conn.query(stmt);
    }
    await seedCatalog(conn);
    await seedAddedWording(conn);
    await backfillKioskRows(conn);
  } finally {
    conn.release();
  }
}

// Availability (open/closed right now) for every active service, keyed by code. Used by
// listServices and queueSnapshot so both reflect manual overrides and schedules consistently.
async function serviceAvailabilityMap() {
  const [services] = await pool.query('SELECT * FROM services WHERE active = 1');
  const [schedules] = await pool.query('SELECT * FROM service_schedules WHERE active = 1');
  const now = new Date();
  const map = {};
  services.forEach((s) => {
    const mine = schedules.filter((sch) => sch.service_code === s.code);
    map[s.code] = resolveAvailability(s, mine, now);
  });
  return map;
}

// Translated text for one language, keyed by item key (for example 'service.BPI.name').
async function getTranslations(lang) {
  const [rows] = await pool.query('SELECT item_key, value FROM translations WHERE lang = ?', [lang]);
  const map = {};
  rows.forEach((r) => { map[r.item_key] = r.value; });
  return map;
}

async function groupLabel(id) {
  const [[g]] = await pool.query('SELECT label FROM service_groups WHERE id = ?', [id]);
  return g ? g.label : null;
}

// Active services for the kiosk and the public screens. With a language, names and descriptions are
// translated where a translation exists; anything missing falls back to English.
async function listServices(lang) {
  const tr = lang && lang !== 'en' ? await getTranslations(lang) : {};
  const [rows] = await pool.query(
    'SELECT code, name, description, icon, color, route, group_id, kiosk_row, asks_appointment, pinned FROM services WHERE active = 1 ORDER BY ' + SERVICE_ORDER
  );
  const avail = await serviceAvailabilityMap();
  return rows.map((s) => ({
    code: s.code,
    name: tr[catalog.keys.serviceName(s.code)] || s.name,
    description: tr[catalog.keys.serviceDescription(s.code)] || s.description || '',
    icon: s.icon,
    color: s.color,
    route: s.route,
    groupId: s.group_id,
    row: s.kiosk_row,
    asksAppointment: !!s.asks_appointment,
    pinned: !!s.pinned,
    available: avail[s.code] ? avail[s.code].available : true,
    unavailableMessage: avail[s.code] && !avail[s.code].available ? avail[s.code].message : null,
  }));
}

// Every service, including inactive ones, for the Services & languages page. English only.
async function listCatalogServices() {
  const [rows] = await pool.query(
    `SELECT s.code, s.name, s.description, s.icon, s.color, s.route, s.group_id, s.active, s.sort_order, s.kiosk_row, s.asks_appointment, s.pinned,
            (SELECT COUNT(*) FROM tickets t WHERE t.service_code = s.code) AS ticket_count,
            (SELECT COUNT(*) FROM tickets t WHERE t.service_code = s.code AND t.created_at >= CURDATE()
               AND t.status IN ('waiting','called','serving')) AS open_count
     FROM services s ORDER BY s.active DESC, s.kiosk_row IS NULL, s.kiosk_row, s.sort_order, s.name`
  );
  return rows.map((s) => ({
    code: s.code,
    name: s.name,
    description: s.description || '',
    icon: s.icon,
    color: s.color,
    route: s.route,
    groupId: s.group_id,
    active: !!s.active,
    asksAppointment: !!s.asks_appointment,
    pinned: !!s.pinned,
    row: s.kiosk_row,
    sortOrder: s.sort_order,
    hasTickets: Number(s.ticket_count) > 0,
    openCount: Number(s.open_count),
  }));
}

// A new service goes at the end of the last kiosk row, or on a new row when that one is full, unless a row
// and position are given. A given row puts it at the end of that row unless a position is given too.
async function createService(v) {
  const group = v.groupId ? await groupLabel(v.groupId) : null;
  let row = v.row;
  if (row === undefined) {
    const [[lastRow]] = await pool.query(
      'SELECT kiosk_row AS r, COUNT(*) AS n FROM services WHERE active = 1 AND kiosk_row IS NOT NULL GROUP BY kiosk_row ORDER BY kiosk_row DESC LIMIT 1'
    );
    row = !lastRow ? 1 : Number(lastRow.n) < catalog.ROW_TILES ? Number(lastRow.r) : Math.min(Number(lastRow.r) + 1, catalog.MAX_ROW);
  }
  let order = v.sortOrder;
  if (order === undefined) {
    const [[max]] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM services WHERE kiosk_row = ?', [row]);
    order = Math.min(Number(max.m) + 1, 999);
  }
  await pool.query(
    'INSERT INTO services (code, name, description, icon, color, group_id, route, kiosk_row, sort_order, asks_appointment, pinned, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
    [v.code, v.name, v.description || null, v.icon || null, v.color || null, v.groupId || null, group, row, order, v.asksAppointment ? 1 : 0, v.pinned ? 1 : 0]
  );
}

// Changes only the fields that were sent. Choosing a group also sets the older department name (route).
async function updateService(code, v) {
  const map = {
    name: 'name', description: 'description', icon: 'icon', color: 'color', groupId: 'group_id', active: 'active',
    asksAppointment: 'asks_appointment', pinned: 'pinned', row: 'kiosk_row', sortOrder: 'sort_order',
  };
  const sets = [];
  const params = [];
  for (const [field, column] of Object.entries(map)) {
    if (v[field] === undefined) continue;
    sets.push(column + ' = ?');
    params.push(typeof v[field] === 'boolean' ? (v[field] ? 1 : 0) : v[field]);
  }
  if (v.groupId !== undefined) {
    sets.push('route = ?');
    params.push(v.groupId ? await groupLabel(v.groupId) : null);
  }
  if (!sets.length) return false;
  params.push(code);
  const [result] = await pool.query(`UPDATE services SET ${sets.join(', ')} WHERE code = ?`, params);
  return result.affectedRows > 0;
}

// Deletes a service that has never taken a customer. A service with tickets can only be turned off,
// because its tickets must keep pointing at it for the reports.
async function deleteService(code) {
  const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM tickets WHERE service_code = ?', [code]);
  if (c.n > 0) return { ok: false, reason: 'tickets' };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM service_schedules WHERE service_code = ?', [code]);
    await conn.query('DELETE FROM service_counters WHERE service_code = ?', [code]);
    await conn.query('DELETE FROM translations WHERE item_key IN (?, ?)', [catalog.keys.serviceName(code), catalog.keys.serviceDescription(code)]);
    await conn.query('DELETE FROM services WHERE code = ?', [code]);
    await conn.commit();
    return { ok: true };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Puts the services in the rows and order given: a list of rows, each a list of codes. A service's row is its
// place in the list, counting from 1, and so is its position in the row. Services that are turned off are left as
// they are. All or nothing.
async function setLayout(rows) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (let r = 0; r < rows.length; r++) {
      for (let p = 0; p < rows[r].length; p++) {
        await conn.query('UPDATE services SET kiosk_row = ?, sort_order = ? WHERE code = ?', [r + 1, p + 1, rows[r][p]]);
      }
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Department groups, with the codes of their active services. The label is translated when a language is given.
async function listGroups(lang) {
  const tr = lang && lang !== 'en' ? await getTranslations(lang) : {};
  const [groups] = await pool.query('SELECT * FROM service_groups ORDER BY sort_order, label');
  const [members] = await pool.query('SELECT code, group_id FROM services WHERE active = 1 AND group_id IS NOT NULL ORDER BY ' + SERVICE_ORDER);
  return groups.map((g) => ({
    id: g.id,
    label: tr[catalog.keys.groupLabel(g.id)] || g.label,
    englishLabel: g.label,
    icon: g.icon,
    color: g.color,
    sortOrder: g.sort_order,
    codes: members.filter((m) => m.group_id === g.id).map((m) => m.code),
  }));
}

async function createGroup(v) {
  const [[max]] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM service_groups');
  await pool.query(
    'INSERT INTO service_groups (id, label, icon, color, sort_order) VALUES (?, ?, ?, ?, ?)',
    [v.id, v.label, v.icon || null, v.color || null, v.sortOrder !== undefined ? v.sortOrder : Number(max.m) + 1]
  );
}

// Changing a group's name also updates the department name on its services.
async function updateGroup(id, v) {
  const sets = [];
  const params = [];
  if (v.label !== undefined) { sets.push('label = ?'); params.push(v.label); }
  if (v.icon !== undefined) { sets.push('icon = ?'); params.push(v.icon); }
  if (v.color !== undefined) { sets.push('color = ?'); params.push(v.color); }
  if (v.sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(v.sortOrder); }
  if (!sets.length) return false;
  params.push(id);
  const [result] = await pool.query(`UPDATE service_groups SET ${sets.join(', ')} WHERE id = ?`, params);
  if (v.label !== undefined) await pool.query('UPDATE services SET route = ? WHERE group_id = ?', [v.label, id]);
  return result.affectedRows > 0;
}

// A group that still has services cannot be deleted. Move or delete those services first.
async function deleteGroup(id) {
  const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM services WHERE group_id = ?', [id]);
  if (c.n > 0) return { ok: false, reason: 'services' };
  await pool.query('DELETE FROM translations WHERE item_key = ?', [catalog.keys.groupLabel(id)]);
  await pool.query('DELETE FROM service_groups WHERE id = ?', [id]);
  return { ok: true };
}

async function listLanguages() {
  const [rows] = await pool.query('SELECT code, name, enabled, sort_order FROM languages ORDER BY sort_order, name');
  return rows.map((l) => ({ code: l.code, name: l.name, enabled: !!l.enabled }));
}

async function createLanguage(v) {
  const [[max]] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM languages');
  await pool.query('INSERT INTO languages (code, name, enabled, sort_order) VALUES (?, ?, ?, ?)', [v.code, v.name, v.enabled === false ? 0 : 1, Number(max.m) + 1]);
}

async function updateLanguage(code, v) {
  const sets = [];
  const params = [];
  if (v.name !== undefined) { sets.push('name = ?'); params.push(v.name); }
  if (v.enabled !== undefined) { sets.push('enabled = ?'); params.push(v.enabled ? 1 : 0); }
  if (!sets.length) return false;
  params.push(code);
  const [result] = await pool.query(`UPDATE languages SET ${sets.join(', ')} WHERE code = ?`, params);
  return result.affectedRows > 0;
}

// Removes a language and everything translated into it. English cannot be removed.
async function deleteLanguage(code) {
  if (code === 'en') return false;
  await pool.query('DELETE FROM translations WHERE lang = ?', [code]);
  const [result] = await pool.query('DELETE FROM languages WHERE code = ?', [code]);
  return result.affectedRows > 0;
}

// Saves translations for one language. An empty text removes that translation, so English is used again.
async function setTranslations(lang, changes) {
  for (const [key, value] of Object.entries(changes)) {
    if (value === '') {
      await pool.query('DELETE FROM translations WHERE lang = ? AND item_key = ?', [lang, key]);
    } else {
      await pool.query(
        'INSERT INTO translations (lang, item_key, value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
        [lang, key, value]
      );
    }
  }
}

// Every item key that can be translated: service names and descriptions, group labels, and the kiosk wording.
async function knownTranslationKeys() {
  const [services] = await pool.query('SELECT code FROM services');
  const [groups] = await pool.query('SELECT id FROM service_groups');
  return [
    ...services.flatMap((s) => [catalog.keys.serviceName(s.code), catalog.keys.serviceDescription(s.code)]),
    ...groups.map((g) => catalog.keys.groupLabel(g.id)),
    ...Object.keys(UI_STRINGS.en).map((k) => catalog.keys.ui(k)),
  ];
}


// Whether one service is open right now, with the database row (not the API shape). Used to
// reject check-ins server-side, not just hide the tile client-side.
async function getServiceAvailability(code) {
  const [[svc]] = await pool.query('SELECT * FROM services WHERE code = ? AND active = 1', [code]);
  if (!svc) return null;
  const [schedules] = await pool.query('SELECT * FROM service_schedules WHERE service_code = ? AND active = 1', [code]);
  return { ...resolveAvailability(svc, schedules), asksAppointment: !!svc.asks_appointment };
}

async function createTicket(serviceCode, customerName, appointment) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[svc]] = await conn.query(
      'SELECT code FROM services WHERE code = ? AND active = 1',
      [serviceCode]
    );
    if (!svc) {
      await conn.rollback();
      return null;
    }

    // Per-service, per-day sequence number. The upsert locks the row, so concurrent kiosks cannot share a number.
    await conn.query(
      `INSERT INTO service_counters (service_code, day, seq) VALUES (?, CURDATE(), 1)
       ON DUPLICATE KEY UPDATE seq = seq + 1`,
      [serviceCode]
    );
    const [[counter]] = await conn.query(
      'SELECT seq FROM service_counters WHERE service_code = ? AND day = CURDATE()',
      [serviceCode]
    );
    const ticketNumber = `${serviceCode}-${String(counter.seq).padStart(3, '0')}`;

    const [result] = await conn.query(
      `INSERT INTO tickets (service_code, customer_name, ticket_number, status, created_at, appointment_with, appointment_time)
       VALUES (?, ?, ?, 'waiting', NOW(), ?, ?)`,
      [serviceCode, customerName, ticketNumber, appointment ? appointment.with : null, appointment ? appointment.time : null]
    );

    const [[ahead]] = await conn.query(
      `SELECT COUNT(*) AS n FROM tickets
       WHERE service_code = ? AND status = 'waiting' AND created_at >= CURDATE() AND id < ?`,
      [serviceCode, result.insertId]
    );

    await conn.commit();
    return {
      id: result.insertId,
      serviceCode,
      customerName,
      ticketNumber,
      peopleAhead: ahead.n,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Today's waiting and called tickets, grouped by service. Used by the monitor and queue portal.
async function queueSnapshot() {
  const [services] = await pool.query(
    'SELECT code, name, description, icon, color, group_id, route, asks_appointment, pinned FROM services WHERE active = 1 ORDER BY ' + SERVICE_ORDER
  );
  const [rows] = await pool.query(
    `SELECT * FROM tickets
     WHERE status IN ('waiting','called','serving') AND created_at >= CURDATE()
     ORDER BY id`
  );
  const tickets = rows.map(toTicket);
  const avail = await serviceAvailabilityMap();
  return services.map((s) => {
    const mine = tickets.filter((t) => t.serviceCode === s.code);
    return {
      code: s.code,
      name: s.name,
      description: s.description || '',
      icon: s.icon,
      color: s.color,
      groupId: s.group_id,
      route: s.route,
      asksAppointment: !!s.asks_appointment,
      pinned: !!s.pinned,
      available: avail[s.code] ? avail[s.code].available : true,
      unavailableMessage: avail[s.code] && !avail[s.code].available ? avail[s.code].message : null,
      waiting: mine.filter((t) => t.status === 'waiting'),
      // Grabbing a customer now starts their service in one step, so this is effectively just
      // "being helped". 'called' is included only for any ticket already in that state from
      // before this change; nothing new is set to it.
      serving: mine.filter((t) => t.status === 'serving' || t.status === 'called'),
    };
  });
}

async function callNext(serviceCode, counter, calledBy) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[next]] = await conn.query(
      `SELECT id FROM tickets
       WHERE service_code = ? AND status = 'waiting' AND created_at >= CURDATE()
       ORDER BY id LIMIT 1 FOR UPDATE`,
      [serviceCode]
    );
    if (!next) {
      await conn.rollback();
      return null;
    }
    await conn.query(
      `UPDATE tickets SET status = 'serving', counter = ?, called_at = NOW(), called_by = ? WHERE id = ?`,
      [counter, calledBy || null, next.id]
    );
    const [[row]] = await conn.query('SELECT * FROM tickets WHERE id = ?', [next.id]);
    await conn.commit();
    return toTicket(row);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

const TICKET_ACTIONS = {
  // 'called' is no longer set by anything, but complete/remove still accept it so any ticket
  // already in that state (from before this change) isn't stranded.
  complete: `UPDATE tickets SET status = 'served', completed_at = NOW() WHERE id = ? AND status IN ('called','serving')`,
  remove: `UPDATE tickets SET status = 'removed', completed_at = NOW() WHERE id = ? AND status IN ('waiting','called','serving')`,
  // Puts a customer back in the lobby — e.g. the wrong person was grabbed, or they stepped away.
  // Clearing counter/called_at/called_by and going back to 'waiting' restores their original
  // place in line, since the waiting list orders by id (when they first checked in), not by
  // when they were called.
  return: `UPDATE tickets SET status = 'waiting', counter = NULL, called_at = NULL, called_by = NULL WHERE id = ? AND status IN ('called','serving')`,
};

// Calls a specific waiting ticket to a counter, starting their service immediately — grabbing
// someone and beginning to help them is one step, not two.
async function updateTicket(id, action, counter, calledBy) {
  if (action === 'call') {
    const [called] = await pool.query(
      `UPDATE tickets SET status = 'serving', counter = ?, called_at = NOW(), called_by = ? WHERE id = ? AND status = 'waiting'`,
      [counter, calledBy || null, id]
    );
    return called.affectedRows > 0;
  }
  const [result] = await pool.query(TICKET_ACTIONS[action], [id]);
  return result.affectedRows > 0;
}

// Moves a waiting or called ticket to another active queue. A customer being helped returns to that queue's waiting list.
async function transferTicket(id, serviceCode) {
  const [[svc]] = await pool.query('SELECT code FROM services WHERE code = ? AND active = 1', [serviceCode]);
  if (!svc) return false;
  const [result] = await pool.query(
    `UPDATE tickets SET service_code = ?, status = 'waiting', counter = NULL, called_at = NULL
     WHERE id = ? AND status IN ('waiting', 'called', 'serving')`,
    [serviceCode, id]
  );
  return result.affectedRows > 0;
}

// Customers called and completed today, most recent first.
async function completedToday() {
  const [rows] = await pool.query(
    `SELECT * FROM tickets WHERE status = 'served' AND completed_at >= CURDATE() ORDER BY completed_at DESC LIMIT 300`
  );
  return rows.map(toTicket);
}

// Every ticket created on one calendar day (YYYY-MM-DD), whatever its status. Feeds the Reports
// dialog, which works out its summaries from these rows.
async function ticketsForRange(from, to) {
  const [rows] = await pool.query(
    `SELECT * FROM tickets WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY) ORDER BY created_at`,
    [from, to]
  );
  return rows.map(toTicket);
}

// ---- Audit log ----
// Records who changed what. The server writes these after each change, and only admins read them.
async function logAudit(actorName, action, target, detail) {
  await pool.query(
    'INSERT INTO audit_log (created_at, actor_name, action, target, detail) VALUES (NOW(), ?, ?, ?, ?)',
    [String(actorName || 'System').slice(0, 100), action, target ? String(target).slice(0, 200) : null, detail ? String(detail).slice(0, 500) : null]
  );
}

// Optional search text matches who acted, the target account, the action code, or the details.
async function listAudit(limit, search) {
  const term = String(search || '').trim();
  if (!term) {
    const [all] = await pool.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', [limit]);
    return mapAudit(all);
  }
  const pattern = '%' + term.replace(/[\\%_]/g, '\\$&') + '%';
  const [rows] = await pool.query(
    'SELECT * FROM audit_log WHERE actor_name LIKE ? OR target LIKE ? OR action LIKE ? OR detail LIKE ? ORDER BY id DESC LIMIT ?',
    [pattern, pattern, pattern, pattern, limit]
  );
  return mapAudit(rows);
}

// Failed sign-ins for one User ID since its last successful sign-in, within the last `minutes`.
// A successful sign-in starts the count again, so a person who gets their password right is not locked out later.
async function countRecentLoginFailures(username, minutes) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM audit_log
     WHERE action = 'auth.login_failed' AND LOWER(target) = LOWER(?)
       AND created_at > NOW() - INTERVAL ? MINUTE
       AND created_at > COALESCE((SELECT MAX(created_at) FROM audit_log WHERE action = 'auth.login' AND LOWER(target) = LOWER(?)), '1970-01-01')`,
    [username, minutes, username]
  );
  return Number(row.n) || 0;
}

// Removes audit rows older than `days`. The caller makes sure the window is long enough for lockouts.
// Moves every ticket still waiting, called or being served to removed. Used by the end-of-day close.
async function closeOpenTickets() {
  const [result] = await pool.query("UPDATE tickets SET status = 'removed', completed_at = NOW() WHERE status IN ('waiting', 'called', 'serving')");
  return result.affectedRows;
}

async function cleanupAudit(days) {
  const [result] = await pool.query('DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL ? DAY', [days]);
  return result.affectedRows;
}

function mapAudit(rows) {
  return rows.map((r) => ({
    id: r.id, createdAt: r.created_at, actorName: r.actor_name, action: r.action, target: r.target, detail: r.detail,
  }));
}

// ---- App settings ----
async function getSettings() {
  const [rows] = await pool.query('SELECT setting_key, setting_value FROM app_settings');
  const out = {};
  rows.forEach((r) => { out[r.setting_key] = r.setting_value; });
  return out;
}

async function setSetting(key, value) {
  await pool.query(
    'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
    [key, String(value)]
  );
}

// ---- Old-record cleanup ----
// Only finished tickets (served or removed, both of which have a completed time) are touched.
// Waiting and in-progress tickets never are. 'anonymize' keeps each row for the statistics but
// blanks the customer's name; 'delete' removes the row, so reports lose those tickets for good.
async function cleanupOldTickets(days, action) {
  if (action === 'delete') {
    const [result] = await pool.query(
      'DELETE FROM tickets WHERE completed_at IS NOT NULL AND completed_at < NOW() - INTERVAL ? DAY',
      [days]
    );
    return result.affectedRows;
  }
  const [result] = await pool.query(
    `UPDATE tickets SET customer_name = 'Removed', appointment_with = NULL
     WHERE completed_at IS NOT NULL AND completed_at < NOW() - INTERVAL ? DAY AND customer_name <> 'Removed'`,
    [days]
  );
  return result.affectedRows;
}

// ---- Database check ----
// The tables and columns the app depends on. A missing one usually means an upload was incomplete
// or the database user lacked the privileges to create it on startup.
const REQUIRED_TABLES = ['services', 'service_counters', 'tickets', 'service_schedules', 'users', 'audit_log', 'app_settings', 'service_groups', 'languages', 'translations'];
const REQUIRED_COLUMNS = {
  services: ['code', 'name', 'manual_override', 'manual_override_expires_at', 'description', 'icon', 'color', 'group_id', 'kiosk_row', 'asks_appointment', 'pinned'],
  tickets: ['service_code', 'status', 'created_at', 'called_by', 'completed_at'],
  users: ['username', 'display_name', 'password_hash', 'role', 'active', 'must_change_password', 'default_queues', 'last_login_at'],
  audit_log: ['created_at', 'actor_name', 'action'],
  app_settings: ['setting_key', 'setting_value'],
};

// Runs a set of checks against the database and returns one result per check, each with a plain
// description. It never changes real data: the write check uses a temporary table that is dropped.
async function databaseCheck() {
  const checks = [];
  const started = Date.now();
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    checks.push({ name: 'Connection', ok: false, detail: 'Could not connect: ' + (err.code || err.message) });
    return checks;
  }
  checks.push({ name: 'Connection', ok: true, detail: 'Connected in ' + (Date.now() - started) + ' ms' });

  const [tableRows] = await pool.query('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
  const tables = new Set(tableRows.map((r) => r.t));
  const missingTables = REQUIRED_TABLES.filter((t) => !tables.has(t));
  checks.push({
    name: 'Tables',
    ok: !missingTables.length,
    detail: missingTables.length ? 'Missing: ' + missingTables.join(', ') : 'All ' + REQUIRED_TABLES.length + ' tables present',
  });

  const [columnRows] = await pool.query('SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()');
  const columns = new Set(columnRows.map((r) => r.t + '.' + r.c));
  const missingColumns = [];
  Object.keys(REQUIRED_COLUMNS).forEach((t) => REQUIRED_COLUMNS[t].forEach((c) => {
    if (!columns.has(t + '.' + c)) missingColumns.push(t + '.' + c);
  }));
  checks.push({
    name: 'Columns',
    ok: !missingColumns.length,
    detail: missingColumns.length ? 'Missing: ' + missingColumns.join(', ') : 'All expected columns present',
  });

  // Uses one connection, because a temporary table only exists on the connection that created it.
  const conn = await pool.getConnection();
  try {
    await conn.query('CREATE TEMPORARY TABLE vq_write_check (id INT)');
    await conn.query('INSERT INTO vq_write_check (id) VALUES (1)');
    await conn.query('DROP TEMPORARY TABLE vq_write_check');
    checks.push({ name: 'Write access', ok: true, detail: 'Can create and write temporary tables' });
  } catch (err) {
    checks.push({ name: 'Write access', ok: false, detail: 'Could not write: ' + (err.code || err.message) });
  } finally {
    conn.release();
  }

  const [[size]] = await pool.query(
    'SELECT ROUND(SUM(data_length + index_length) / 1048576, 1) AS mb FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()'
  );
  checks.push({ name: 'Size', ok: true, detail: (Number(size.mb) || 0) + ' MB on disk' });

  const [[counts]] = await pool.query(
    'SELECT (SELECT COUNT(*) FROM tickets) AS tickets, (SELECT COUNT(*) FROM audit_log) AS audit, (SELECT COUNT(*) FROM users) AS users'
  );
  checks.push({ name: 'Records', ok: true, detail: counts.tickets + ' tickets, ' + counts.users + ' accounts, ' + counts.audit + ' audit entries' });

  return checks;
}

// ---- Health ----
// Checks the database is reachable and how long it takes, and reports today's queue numbers.
async function healthSnapshot() {
  const started = Date.now();
  const [[clock]] = await pool.query('SELECT NOW() AS now');
  const dbLatencyMs = Date.now() - started;
  const [[counts]] = await pool.query(
    `SELECT SUM(status = 'waiting') AS waiting, SUM(status IN ('called', 'serving')) AS serving
     FROM tickets WHERE created_at >= CURDATE()`
  );
  const [[admins]] = await pool.query(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1`);
  return {
    dbLatencyMs,
    dbTime: clock.now,
    waiting: Number(counts.waiting || 0),
    serving: Number(counts.serving || 0),
    activeAdmins: admins.n,
  };
}

// The saved default watched queues: a JSON list of service codes, or null when none is saved.
function parseQueueList(text) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : null;
  } catch (e) {
    return null;
  }
}

function toUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    active: !!row.active,
    mustChangePassword: !!row.must_change_password,
    defaultQueues: parseQueueList(row.default_queues),
    sessionsRevokedAt: row.sessions_revoked_at ? Number(row.sessions_revoked_at) : null,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

async function countActiveAdmins() {
  const [[row]] = await pool.query(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1`);
  return row.n;
}

// Includes the password hash. Only used for login and the bootstrap admin check.
async function findUserByUsername(username) {
  const [[row]] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
  return row || null;
}

async function getUser(id) {
  const [[row]] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
  return row ? toUser(row) : null;
}

// Managers only ever see staff accounts; admins see everyone. Filtering happens here, not just in the UI.
async function listUsers(roleFilter) {
  const rows = roleFilter
    ? (await pool.query('SELECT * FROM users WHERE role = ? ORDER BY username', [roleFilter]))[0]
    : (await pool.query('SELECT * FROM users ORDER BY FIELD(role, \'admin\',\'manager\',\'staff\'), username'))[0];
  return rows.map(toUser);
}

async function createUser(username, displayName, passwordHash, role, mustChangePassword) {
  const [result] = await pool.query(
    `INSERT INTO users (username, display_name, password_hash, role, active, created_at, must_change_password)
     VALUES (?, ?, ?, ?, 1, NOW(), ?)`,
    [username, displayName, passwordHash, role, mustChangePassword ? 1 : 0]
  );
  return getUser(result.insertId);
}

async function updateUser(id, patch) {
  const sets = [];
  const params = [];
  if (patch.username !== undefined) { sets.push('username = ?'); params.push(patch.username); }
  if (patch.displayName !== undefined) { sets.push('display_name = ?'); params.push(patch.displayName); }
  if (patch.role !== undefined) { sets.push('role = ?'); params.push(patch.role); }
  if (patch.active !== undefined) { sets.push('active = ?'); params.push(patch.active ? 1 : 0); }
  if (patch.passwordHash !== undefined) { sets.push('password_hash = ?'); params.push(patch.passwordHash); }
  if (patch.mustChangePassword !== undefined) { sets.push('must_change_password = ?'); params.push(patch.mustChangePassword ? 1 : 0); }
  if (patch.sessionsRevokedAt !== undefined) { sets.push('sessions_revoked_at = ?'); params.push(patch.sessionsRevokedAt); }
  if (patch.defaultQueues !== undefined) { sets.push('default_queues = ?'); params.push(patch.defaultQueues ? JSON.stringify(patch.defaultQueues) : null); }
  if (!sets.length) return getUser(id);
  params.push(id);
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  return getUser(id);
}

// Removes the account row. Tickets record the staff name as text, not a foreign key, so past
// history is kept as it was. Disabling an account is the option that keeps it sign-in-able later.
async function deleteUser(id) {
  const [result] = await pool.query('DELETE FROM users WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

async function touchLastLogin(id) {
  await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [id]);
}

function toSchedule(row) {
  return {
    id: row.id,
    serviceCode: row.service_code,
    message: row.message,
    recurrence: row.recurrence,
    weekday: row.weekday,
    nthWeeks: row.nth_weeks,
    startTime: row.start_time,
    endTime: row.end_time,
    active: !!row.active,
    createdAt: row.created_at,
  };
}

async function listSchedules(serviceCode) {
  const [rows] = serviceCode
    ? await pool.query('SELECT * FROM service_schedules WHERE service_code = ? ORDER BY weekday, start_time', [serviceCode])
    : await pool.query('SELECT * FROM service_schedules ORDER BY service_code, weekday, start_time');
  return rows.map(toSchedule);
}

async function createSchedule(serviceCode, data) {
  const [result] = await pool.query(
    `INSERT INTO service_schedules (service_code, message, recurrence, weekday, nth_weeks, start_time, end_time, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW())`,
    [serviceCode, data.message, data.recurrence, data.weekday, data.nthWeeks || null, data.startTime, data.endTime]
  );
  const [[row]] = await pool.query('SELECT * FROM service_schedules WHERE id = ?', [result.insertId]);
  return toSchedule(row);
}

async function updateSchedule(id, patch) {
  const sets = [];
  const params = [];
  if (patch.active !== undefined) { sets.push('active = ?'); params.push(patch.active ? 1 : 0); }
  if (patch.message !== undefined) { sets.push('message = ?'); params.push(patch.message); }
  if (patch.recurrence !== undefined) { sets.push('recurrence = ?'); params.push(patch.recurrence); }
  if (patch.weekday !== undefined) { sets.push('weekday = ?'); params.push(patch.weekday); }
  if (patch.nthWeeks !== undefined) { sets.push('nth_weeks = ?'); params.push(patch.nthWeeks || null); }
  if (patch.startTime !== undefined) { sets.push('start_time = ?'); params.push(patch.startTime); }
  if (patch.endTime !== undefined) { sets.push('end_time = ?'); params.push(patch.endTime); }
  if (!sets.length) {
    const [[row]] = await pool.query('SELECT * FROM service_schedules WHERE id = ?', [id]);
    return row ? toSchedule(row) : null;
  }
  params.push(id);
  await pool.query(`UPDATE service_schedules SET ${sets.join(', ')} WHERE id = ?`, params);
  const [[row]] = await pool.query('SELECT * FROM service_schedules WHERE id = ?', [id]);
  return row ? toSchedule(row) : null;
}

async function deleteSchedule(id) {
  const [result] = await pool.query('DELETE FROM service_schedules WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

// The recurring closure (if any) that's actively closing a service right now — used to cap a
// "Reopen now" override at the end of just this occurrence, so it doesn't also swallow the
// service's next scheduled closure.
async function findActiveSchedule(serviceCode, now) {
  now = now || new Date();
  const [schedules] = await pool.query(
    'SELECT * FROM service_schedules WHERE service_code = ? AND active = 1',
    [serviceCode]
  );
  return schedules.find((s) => isScheduleActiveAt(s, now)) || null;
}

// Manual override: 'closed' force-closes with a message, 'open' force-opens through an active
// schedule, 'none' clears it and falls back to whatever the schedules say.
async function setManualOverride(serviceCode, override, message, expiresAt) {
  const [result] = await pool.query(
    'UPDATE services SET manual_override = ?, manual_message = ?, manual_override_expires_at = ? WHERE code = ? AND active = 1',
    [override, message || null, expiresAt || null, serviceCode]
  );
  return result.affectedRows > 0;
}

// Full detail for the Manage Services page: every active service with its current status,
// override state, and its schedules.
async function listServicesAdmin() {
  const [services] = await pool.query('SELECT * FROM services WHERE active = 1 ORDER BY ' + SERVICE_ORDER);
  const [groups] = await pool.query('SELECT id, label FROM service_groups');
  const groupLabels = {};
  groups.forEach((g) => { groupLabels[g.id] = g.label; });
  const [schedules] = await pool.query('SELECT * FROM service_schedules ORDER BY weekday, start_time');
  const now = new Date();
  return services.map((s) => {
    const mine = schedules.filter((sch) => sch.service_code === s.code);
    const availability = resolveAvailability(s, mine, now);
    return {
      code: s.code,
      name: s.name,
      route: s.route,
      groupId: s.group_id,
      groupLabel: s.group_id ? groupLabels[s.group_id] || null : null,
      manualOverride: s.manual_override,
      manualMessage: s.manual_message,
      manualOverrideExpiresAt: s.manual_override_expires_at,
      available: availability.available,
      currentMessage: availability.available ? null : availability.message,
      source: availability.source,
      schedules: mine.map(toSchedule),
    };
  });
}

module.exports = {
  init, listServices, createTicket, queueSnapshot, callNext, updateTicket, transferTicket, completedToday, ticketsForRange,
  countActiveAdmins, findUserByUsername, getUser, listUsers, createUser, updateUser, deleteUser, touchLastLogin,
  getServiceAvailability, listSchedules, createSchedule, updateSchedule, deleteSchedule, setManualOverride, listServicesAdmin,
  findActiveSchedule, isDefaultServiceStatement,
  listCatalogServices, createService, updateService, deleteService, setLayout,
  listGroups, createGroup, updateGroup, deleteGroup,
  listLanguages, createLanguage, updateLanguage, deleteLanguage,
  getTranslations, setTranslations, knownTranslationKeys,
  logAudit, listAudit, countRecentLoginFailures, cleanupAudit, closeOpenTickets, getSettings, setSetting, cleanupOldTickets, healthSnapshot, databaseCheck, splitStatements,
};

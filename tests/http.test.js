// Runs the real routes in server.js against an in-memory stand-in for the database, so the access rules,
// sign-in, sessions, settings, check-in limit, logo and error handling are all tested without MySQL.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
process.env.SESSION_SECRET = 'test-only-secret-0123456789abcdefghijklmnopqrstuvwxyz';
// These tests describe the app at the root of a domain with no proxy in front, whatever the machine running them has set.
// The live site serves it under a sub-path, behind a proxy, and "Run tests" on the Health and Audit tab hands that setting to
// the tests. With a base path the live connection moves to <base>/socket.io, and the tests would look for it in the wrong place.
process.env.BASE_PATH = '';
process.env.TRUST_PROXY = '';

// ---- in-memory stand-in for db.js ----
const users = [];
const audit = [];
const settings = {};
const tickets = [];
let nextId = 1;
let settingValueLimit = 0; // when set, saved settings are cut to this length, as the old VARCHAR(255) column did
let failAudit = false; // makes the audit list fail, to test the error handler
let openTicketsToClose = 0; // how many open tickets the end-of-day close finds
let lastAuditLimit = null; // the row limit the audit route last asked the database for
const addedServices = []; // services added through the routes while rememberAddedServices is on
let rememberAddedServices = false;
const savedTranslations = {}; // language code -> { item key -> text }
const screenLinks = []; // access links for the kiosk and monitor, kept like the real table (only a hash of each key)
let nextLinkId = 1;
const shownLink = (l) => l && ({ id: l.id, name: l.name, scope: l.scope, panel: l.panel, createdAt: l.createdAt, createdBy: l.createdBy, lastUsedAt: l.lastUsedAt, revokedAt: l.revokedAt });

function camel(r) {
  return r && {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    active: !!r.active,
    mustChangePassword: !!r.must_change_password,
    defaultQueues: r.default_queues ? JSON.parse(r.default_queues) : null,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at || null,
    sessionsRevokedAt: r.sessions_revoked_at ? Number(r.sessions_revoked_at) : null,
  };
}

// Counts failed sign-ins since the last successful one. The real query also limits this to a time window;
// the stand-in ignores the window, which the lockout test does not depend on.
function failuresSinceLastSuccess(username) {
  const u = String(username).toLowerCase();
  let lastSuccess = -1;
  audit.forEach((a, i) => { if (a.action === 'auth.login' && String(a.target).toLowerCase() === u) lastSuccess = i; });
  return audit.filter((a, i) => i > lastSuccess && a.action === 'auth.login_failed' && String(a.target).toLowerCase() === u).length;
}

const mockDb = {
  init: async () => {},
  getSettings: async () => ({ ...settings }),
  setSetting: async (k, v) => {
    const text = String(v);
    settings[k] = settingValueLimit ? text.slice(0, settingValueLimit) : text;
  },
  findUserByUsername: async (u) => users.find((x) => x.username === String(u).toLowerCase()) || null,
  getUser: async (id) => camel(users.find((x) => x.id === id)),
  listUsers: async (role) => users.filter((x) => !role || x.role === role).map(camel),
  createUser: async (username, displayName, hash, role, mustChange) => {
    const row = { id: nextId++, username, display_name: displayName, password_hash: hash, role, active: 1, must_change_password: mustChange ? 1 : 0, created_at: new Date() };
    users.push(row);
    return camel(row);
  },
  updateUser: async (id, patch) => {
    const row = users.find((x) => x.id === id);
    if (patch.displayName !== undefined) row.display_name = patch.displayName;
    if (patch.username !== undefined) row.username = patch.username;
    if (patch.role !== undefined) row.role = patch.role;
    if (patch.active !== undefined) row.active = patch.active ? 1 : 0;
    if (patch.passwordHash !== undefined) row.password_hash = patch.passwordHash;
    if (patch.mustChangePassword !== undefined) row.must_change_password = patch.mustChangePassword ? 1 : 0;
    if (patch.defaultQueues !== undefined) row.default_queues = patch.defaultQueues ? JSON.stringify(patch.defaultQueues) : null;
    if (patch.sessionsRevokedAt !== undefined) row.sessions_revoked_at = patch.sessionsRevokedAt;
    return camel(row);
  },
  countActiveAdmins: async () => users.filter((x) => x.role === 'admin' && x.active).length,
  touchLastLogin: async () => {},
  logAudit: async (who, action, target, detail) => { audit.push({ who, action, target, detail }); },
  countRecentLoginFailures: async (u) => failuresSinceLastSuccess(u),
  listAudit: async (limit) => {
    lastAuditLimit = limit;
    if (failAudit) throw new Error('simulated failure in a late route');
    return audit.map((a) => ({ actorName: a.who, action: a.action, target: a.target, detail: a.detail }));
  },
  listServices: async () => [
    { code: 'BPI', name: 'Building Permits & Inspections', route: null, available: true, unavailableMessage: null },
    { code: 'ZD', name: 'Zoning', route: null, available: true, unavailableMessage: null },
  ],
  listServicesAdmin: async () => [],
  listSchedules: async () => [],
  // Like the real one: a service that does not exist gets no schedule
  createSchedule: async (code, data) => (code === 'NOPE' ? null : { id: 1, serviceCode: code, message: data.message, recurrence: data.recurrence, weekday: data.weekday, nthWeeks: data.nthWeeks, startTime: data.startTime, endTime: data.endTime, active: true }),
  listGroups: async () => [
    { id: 'building', label: 'Building Dept.', englishLabel: 'Building Dept.', icon: 'building', color: '#2f6fd6', sortOrder: 1, codes: ['BPI'] },
  ],
  listLanguages: async () => [
    { code: 'en', name: 'English', enabled: true },
    { code: 'es', name: 'Español', enabled: true },
  ],
  listCatalogServices: async () => [
    { code: 'BPI', name: 'Building Permits & Inspections', description: 'Permits', icon: 'building', color: null, route: 'Building Dept.', groupId: 'building', active: true, sortOrder: 1, hasTickets: false },
    ...addedServices,
  ],
  // Saved translations by language, kept like the real table: an empty text removes the translation
  getTranslations: async (lang) => ({ ...(savedTranslations[lang] || {}) }),
  setTranslations: async (lang, changes) => {
    savedTranslations[lang] = savedTranslations[lang] || {};
    for (const [key, value] of Object.entries(changes)) {
      if (value === '') delete savedTranslations[lang][key]; else savedTranslations[lang][key] = value;
    }
  },
  knownTranslationKeys: async () => ['service.BPI.name', 'service.BPI.description', 'group.building.label', 'ui.btn_join']
    .concat(...addedServices.map((s) => ['service.' + s.code + '.name', 'service.' + s.code + '.description'])),
  // Remembers a new service only while a test asks it to, so the other tests still see the one service
  createService: async (v) => {
    if (rememberAddedServices) {
      addedServices.push({ code: v.code, name: v.name, description: v.description || '', icon: v.icon || null, color: null, route: null, groupId: v.groupId || null, active: true, sortOrder: 2, row: 1, hasTickets: false, openCount: 0, asksAppointment: false, pinned: false });
    }
  },
  updateService: async () => true,
  // A service with customers on record cannot be deleted, as in the real database
  deleteService: async (code) => (code === 'BPI' ? { ok: false, reason: 'tickets' } : { ok: true }),
  createGroup: async () => {},
  updateGroup: async () => true,
  deleteGroup: async () => ({ ok: true }),
  setLayout: async () => {},
  ticketsForRange: async () => [],
  createLanguage: async () => {},
  updateLanguage: async () => true,
  deleteLanguage: async () => true,
  queueSnapshot: async () => [
    {
      code: 'BPI', name: 'Building Permits & Inspections', route: null, available: true, unavailableMessage: null,
      waiting: [{ id: 7, serviceCode: 'BPI', customerName: 'Jane Smith', ticketNumber: 'BPI-007', status: 'waiting', appointmentWith: 'Lee Chen', appointmentTime: '9:30 AM', calledBy: null }],
      serving: [{ id: 8, serviceCode: 'BPI', customerName: 'Ana Maria Ruiz', ticketNumber: 'BPI-008', status: 'serving', counter: '2', calledBy: 'Sam Staff', appointmentWith: null }],
    },
  ],
  // ZD stands in for an appointment service, which asks who the visitor is seeing and the time
  getServiceAvailability: async (code) => ({ available: true, message: null, asksAppointment: code === 'ZD' }),
  createTicket: async (serviceCode, name) => {
    const t = { id: tickets.length + 1, serviceCode, customerName: name, status: 'waiting' };
    tickets.push(t);
    return t;
  },
  listScreenLinks: async () => screenLinks.map(shownLink),
  getScreenLink: async (id) => shownLink(screenLinks.find((l) => l.id === id)),
  findScreenLink: async (hash) => shownLink(screenLinks.find((l) => l.hash === hash)),
  createScreenLink: async (name, scope, panel, hash, createdBy) => {
    const link = { id: nextLinkId++, name, scope, panel, hash, createdAt: new Date(), createdBy, lastUsedAt: null, revokedAt: null };
    screenLinks.push(link);
    return link.id;
  },
  touchScreenLink: async (id) => { const l = screenLinks.find((x) => x.id === id); if (l) l.lastUsedAt = new Date(); },
  revokeScreenLink: async (id) => { const l = screenLinks.find((x) => x.id === id); if (!l) return false; l.revokedAt = l.revokedAt || new Date(); return true; },
  replaceScreenLinkKey: async (id, hash) => { const l = screenLinks.find((x) => x.id === id); if (!l) return false; l.hash = hash; l.revokedAt = null; l.lastUsedAt = null; return true; },
  deleteScreenLink: async (id) => { const i = screenLinks.findIndex((l) => l.id === id); if (i < 0) return false; screenLinks.splice(i, 1); return true; },
  closeOpenTickets: async () => { const n = openTicketsToClose; openTicketsToClose = 0; return n; },
  cleanupOldTickets: async () => 0,
  cleanupAudit: async () => 0,
};
const dbPath = require.resolve(path.join(ROOT, 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const auth = require(path.join(ROOT, 'lib', 'auth.js'));
const { app, server: liveServer, checkAutoClose, withoutBasePath, trustProxySetting } = require(path.join(ROOT, 'server.js'));
const WebSocket = require('ws');

function seed(username, role, password, extra) {
  users.push({
    id: nextId++, username, display_name: username, password_hash: auth.hashPassword(password), role,
    active: 1, must_change_password: 0, created_at: new Date(), ...(extra || {}),
  });
}
seed('admin', 'admin', 'AdminPass123');
seed('mgr', 'manager', 'ManagerPass123');
seed('staffer', 'staff', 'StaffPass123');
seed('newbie', 'staff', 'NewbiePass123', { must_change_password: 1 });
seed('lockme', 'staff', 'LockPass123');

let base;
let srv;
before(async () => {
  srv = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => srv.once('listening', resolve));
  base = 'http://127.0.0.1:' + srv.address().port;
});
after(() => {
  srv.closeAllConnections();
  return new Promise((resolve) => srv.close(resolve));
});

async function req(method, url, opts) {
  const o = opts || {};
  const headers = { 'Content-Type': 'application/json' };
  if (o.cookie) headers.Cookie = o.cookie;
  let body;
  if (o.raw !== undefined) body = o.raw;
  else if (o.body !== undefined) body = JSON.stringify(o.body);
  const res = await fetch(base + url, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  const setCookie = res.headers.get('set-cookie') || '';
  return { status: res.status, headers: res.headers, text, json, setCookie, cookie: setCookie.split(';')[0] };
}

function signIn(username, password) {
  return req('POST', '/api/auth/login', { body: { username, password } });
}

async function adminSession() {
  return (await signIn('admin', 'AdminPass123')).cookie;
}

// ---- sign-in and cookies ----

test('a successful sign-in sets a 12-hour session cookie that scripts cannot read', async () => {
  const r = await signIn('admin', 'AdminPass123');
  assert.equal(r.status, 200);
  assert.match(r.setCookie, /HttpOnly/);
  assert.match(r.setCookie, /SameSite=Lax/);
  assert.match(r.setCookie, /Max-Age=43200/);
});

test('logout clears the session cookie', async () => {
  const r = await req('POST', '/api/auth/logout');
  assert.match(r.setCookie, /Max-Age=0/);
});

test('repeated failed sign-ins lock the User ID, even with the right password', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await signIn('lockme', 'wrong-password');
    assert.equal(r.status, 401);
  }
  const locked = await signIn('lockme', 'LockPass123');
  assert.equal(locked.status, 429);
  assert.match(locked.json.error, /Too many failed sign-in attempts/);
});

// ---- access rules ----

test('admin routes refuse people who are not signed in (401)', async () => {
  const r = await req('GET', '/api/admin/settings');
  assert.equal(r.status, 401);
});

test('a signed-in person without the right role gets 403, not a sign-in prompt', async () => {
  const mgr = (await signIn('mgr', 'ManagerPass123')).cookie;
  const r = await req('GET', '/api/admin/settings', { cookie: mgr });
  assert.equal(r.status, 403);
});

test('a manager cannot create or edit admin accounts, but can create staff', async () => {
  const mgr = (await signIn('mgr', 'ManagerPass123')).cookie;
  let r = await req('POST', '/api/users', { cookie: mgr, body: { username: 'sneaky', displayName: 'Sneaky', password: 'LongEnough1', role: 'admin' } });
  assert.equal(r.status, 403);
  r = await req('PATCH', '/api/users/1', { cookie: mgr, body: { displayName: 'Changed' } });
  assert.equal(r.status, 403);
  r = await req('POST', '/api/users', { cookie: mgr, body: { username: 'newstaff1', displayName: 'New Staff', password: 'StaffLong1', role: 'staff' } });
  assert.equal(r.status, 201);
});

test('staff cannot list accounts', async () => {
  const staff = (await signIn('staffer', 'StaffPass123')).cookie;
  const r = await req('GET', '/api/users', { cookie: staff });
  assert.equal(r.status, 403);
});

test('a forced password change blocks queue routes but not My account', async () => {
  const newbie = (await signIn('newbie', 'NewbiePass123')).cookie;
  let r = await req('GET', '/api/staff/history', { cookie: newbie });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'PASSWORD_CHANGE_REQUIRED');
  r = await req('GET', '/api/auth/me', { cookie: newbie });
  assert.equal(r.status, 200);
});

// ---- sessions after password changes ----

test('an admin password reset ends the account\'s earlier sessions', async () => {
  const admin = await adminSession();
  const mgrOld = (await signIn('mgr', 'ManagerPass123')).cookie;
  const mgrId = users.find((x) => x.username === 'mgr').id;
  const r = await req('PATCH', '/api/users/' + mgrId, { cookie: admin, body: { password: 'ResetPass123' } });
  assert.equal(r.status, 200);
  assert.equal((await req('GET', '/api/auth/me', { cookie: mgrOld })).status, 401);
  assert.equal((await signIn('mgr', 'ResetPass123')).status, 200);
});

test('changing your own password ends every other session, and keeps this browser signed in', async () => {
  const first = (await signIn('staffer', 'StaffPass123')).cookie;
  const second = (await signIn('staffer', 'StaffPass123')).cookie;
  const r = await req('POST', '/api/account/password', { cookie: first, body: { currentPassword: 'StaffPass123', newPassword: 'FreshStaff456' } });
  assert.equal(r.status, 200);
  assert.equal((await req('GET', '/api/auth/me', { cookie: second })).status, 401, 'the other browser must be signed out');
  assert.equal((await req('GET', '/api/auth/me', { cookie: first })).status, 401, 'the old session in this browser must be replaced');
  assert.ok(r.cookie, 'this browser must receive a new session');
  assert.equal((await req('GET', '/api/auth/me', { cookie: r.cookie })).status, 200, 'the new session must work');
  assert.equal((await signIn('staffer', 'FreshStaff456')).status, 200);
});

// ---- settings ----

test('public settings: sent with no-store, carry the colour choices, and leave out the check-in limit', async () => {
  const r = await req('GET', '/api/public-settings');
  assert.match(r.headers.get('cache-control') || '', /no-store/);
  assert.ok(['light', 'dark'].includes(r.json.kiosk_theme));
  assert.ok(['light', 'dark'].includes(r.json.monitor_theme));
  assert.equal(r.json.checkin_rate_per_minute, undefined);
});

test('admin can save settings, and invalid values are refused and not kept', async () => {
  const admin = await adminSession();
  let r = await req('PUT', '/api/admin/app-settings', { cookie: admin, body: { kiosk_idle_seconds: 5 } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /from 15 to 300/);
  r = await req('PUT', '/api/admin/app-settings', { cookie: admin, body: { kiosk_idle_seconds: 90, kiosk_theme: 'dark' } });
  assert.equal(r.status, 200);
  const pub = await req('GET', '/api/public-settings');
  assert.equal(pub.json.kiosk_idle_seconds, 90);
  assert.equal(pub.json.kiosk_theme, 'dark');
});

test('only admins can change settings', async () => {
  const mgr = (await signIn('mgr', 'ResetPass123')).cookie;
  const r = await req('PUT', '/api/admin/app-settings', { cookie: mgr, body: { kiosk_idle_seconds: 90 } });
  assert.equal(r.status, 403);
});

test('an unknown setting name is refused', async () => {
  const admin = await adminSession();
  const r = await req('PUT', '/api/admin/app-settings', { cookie: admin, body: { made_up_setting: 1 } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Unknown setting/);
});

// ---- check-ins and the rate limit ----

test('an invalid service is refused at check-in', async () => {
  const r = await req('POST', '/api/tickets', { body: { serviceId: 'bad code!', name: 'Jane Smith' } });
  assert.equal(r.status, 400);
});

test('check-ins are limited per minute from one address, and a limit of 0 means no limit', async () => {
  const admin = await adminSession();
  await req('PUT', '/api/admin/app-settings', { cookie: admin, body: { checkin_rate_per_minute: 3 } });
  const codes = [];
  for (let i = 0; i < 4; i++) {
    codes.push((await req('POST', '/api/tickets', { body: { serviceId: 'BPI', name: 'Jane Smith' } })).status);
  }
  // The invalid check-in in the test above also counts: the limit applies before validation.
  assert.deepEqual(codes, [201, 201, 429, 429]);
  await req('PUT', '/api/admin/app-settings', { cookie: admin, body: { checkin_rate_per_minute: 0 } });
  assert.equal((await req('POST', '/api/tickets', { body: { serviceId: 'BPI', name: 'Jane Smith' } })).status, 201);
});

test('the queue data the monitor reads is available to the public', async () => {
  const r = await req('GET', '/api/queue');
  assert.equal(r.status, 200);
  assert.equal(r.json[0].code, 'BPI');
});

test('the public queue shows customers as first name and last initial, and nothing about their appointment', async () => {
  const r = await req('GET', '/api/queue');
  const waiting = r.json[0].waiting[0];
  const serving = r.json[0].serving[0];
  assert.equal(waiting.customerName, 'Jane S.');
  assert.equal(serving.customerName, 'Ana R.');
  assert.equal(serving.calledBy, 'Sam Staff', 'the monitor says who will be with you');
  assert.ok(!('appointmentWith' in waiting) && !('appointmentTime' in waiting), 'appointment details stay private');
  assert.ok(!r.text.includes('Jane Smith') && !r.text.includes('Lee Chen'));
});

test('signed-in staff get the full queue, and the public cannot', async () => {
  assert.equal((await req('GET', '/api/staff/queue')).status, 401);
  const staff = await adminSession();
  const r = await req('GET', '/api/staff/queue', { cookie: staff });
  assert.equal(r.status, 200);
  assert.equal(r.json[0].waiting[0].customerName, 'Jane Smith');
  assert.equal(r.json[0].waiting[0].appointmentWith, 'Lee Chen');
});

// ---- logo ----

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngDataUrl(kb) {
  const bytes = Buffer.concat([PNG_HEADER, Buffer.alloc(kb * 1024, 7)]);
  return 'data:image/png;base64,' + bytes.toString('base64');
}

test('a logo must really be a PNG, JPEG or WebP image', async () => {
  const admin = await adminSession();
  const notImage = 'data:image/png;base64,' + Buffer.from('this is plain text, not an image').toString('base64');
  const r = await req('PUT', '/api/admin/logo', { cookie: admin, body: { dataUrl: notImage } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /not a PNG, JPEG or WebP/);
});

test('a PNG logo is saved, served as an image, and can be removed', async () => {
  const admin = await adminSession();
  let r = await req('PUT', '/api/admin/logo', { cookie: admin, body: { dataUrl: pngDataUrl(2) } });
  assert.equal(r.status, 200);
  const pub = await req('GET', '/api/public-settings');
  assert.match(pub.json.logoUrl, /^api\/branding\/logo\?v=/);
  const img = await req('GET', '/api/branding/logo');
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  r = await req('DELETE', '/api/admin/logo', { cookie: admin });
  assert.equal(r.status, 200);
  assert.equal((await req('GET', '/api/public-settings')).json.logoUrl, null);
  assert.equal((await req('GET', '/api/branding/logo')).status, 404);
});

test('a logo the database cannot store in full is refused, not kept as a broken image', async () => {
  const admin = await adminSession();
  settingValueLimit = 255; // what the old VARCHAR(255) column did to a logo
  const r = await req('PUT', '/api/admin/logo', { cookie: admin, body: { dataUrl: pngDataUrl(2) } });
  settingValueLimit = 0;
  assert.equal(r.status, 500);
  assert.match(r.json.error, /could not be saved in full/);
  assert.equal((await req('GET', '/api/public-settings')).json.logoUrl, null);
});

test('a logo too large to upload gets a clear message', async () => {
  const admin = await adminSession();
  const r = await req('PUT', '/api/admin/logo', { cookie: admin, body: { dataUrl: pngDataUrl(600) } });
  assert.equal(r.status, 413);
  assert.match(r.json.error, /too large/);
});

// ---- errors and headers ----

test('an error in a late route returns a JSON 500, not an HTML stack trace', async () => {
  const admin = await adminSession();
  failAudit = true;
  const r = await req('GET', '/api/admin/audit', { cookie: admin });
  failAudit = false;
  assert.equal(r.status, 500);
  assert.equal(r.json.error, 'Server error');
});

test('responses are sent with nosniff and same-origin framing protection', async () => {
  const r = await req('GET', '/api/public-settings');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
});

test('an unknown ticket action is refused', async () => {
  const staff = (await signIn('staffer', 'FreshStaff456')).cookie;
  const r = await req('POST', '/api/staff/tickets/1/explode', { cookie: staff, body: {} });
  assert.equal(r.status, 400);
});

test('the end-of-day close runs once a day, closes open tickets, and records how many', async () => {
  const admin = await adminSession();
  await req('PUT', '/api/admin/app-settings', { cookie: admin, body: { auto_close_time: '00:00' } });
  openTicketsToClose = 2;
  await checkAutoClose();
  const closed = audit.filter((a) => a.action === 'tickets.auto_close');
  assert.equal(closed.length, 1);
  assert.match(closed[0].detail, /2 open ticket\(s\) closed at 00:00/);
  // Same day again: nothing is closed, so the next batch of open tickets is left alone.
  openTicketsToClose = 5;
  await checkAutoClose();
  assert.equal(openTicketsToClose, 5);
  assert.equal(audit.filter((a) => a.action === 'tickets.auto_close').length, 1);
  await req('PUT', '/api/admin/app-settings', { cookie: admin, body: { auto_close_time: '' } });
});

// ---- services, groups, languages and translations ----

test('the public catalogue lists department groups and the languages switched on', async () => {
  const r = await req('GET', '/api/catalog');
  assert.equal(r.status, 200);
  assert.equal(r.json.groups[0].id, 'building');
  assert.ok(r.json.languages.some((l) => l.code === 'en'));
});

test('the kiosk wording falls back to English for a language that is not set up', async () => {
  const r = await req('GET', '/api/i18n/fr');
  assert.equal(r.status, 200);
  assert.equal(r.json.lang, 'en');
  assert.equal(r.json.strings.brand, 'Check In');
});

test('services can be requested in a language', async () => {
  const r = await req('GET', '/api/services?lang=es');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json));
});

test('an admin can add a service, and a code that is not valid is refused', async () => {
  const admin = await adminSession();
  let r = await req('POST', '/api/admin/services', { cookie: admin, body: { code: 'x', name: 'Bad' } });
  assert.equal(r.status, 400);
  r = await req('POST', '/api/admin/services', { cookie: admin, body: { code: 'PRM', name: 'Permits', icon: 'building' } });
  assert.equal(r.status, 201);
});

test('a service with customers on record cannot be deleted, and one without can', async () => {
  const admin = await adminSession();
  let r = await req('DELETE', '/api/admin/services/BPI', { cookie: admin });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /Turn it off instead/);
  r = await req('DELETE', '/api/admin/services/ZD', { cookie: admin });
  assert.equal(r.status, 200);
});

test('English cannot be turned off, and translations must match known items', async () => {
  const admin = await adminSession();
  let r = await req('PATCH', '/api/admin/languages/en', { cookie: admin, body: { enabled: false } });
  assert.equal(r.status, 400);
  r = await req('PUT', '/api/admin/translations', { cookie: admin, body: { lang: 'es', values: { 'service.XX.name': 'Nope' } } });
  assert.equal(r.status, 400);
  r = await req('PUT', '/api/admin/translations', { cookie: admin, body: { lang: 'es', values: { 'ui.btn_join': 'Unirse' } } });
  assert.equal(r.status, 200);
});

test('managers cannot use the Service Configuration admin routes', async () => {
  const mgr = (await signIn('mgr', 'ResetPass123')).cookie;
  assert.equal((await req('GET', '/api/admin/catalog', { cookie: mgr })).status, 403);
  assert.equal((await req('POST', '/api/admin/groups', { cookie: mgr, body: { id: 'permits', label: 'Permits' } })).status, 403);
});

test('a group id that is not valid is refused', async () => {
  const admin = await adminSession();
  const r = await req('POST', '/api/admin/groups', { cookie: admin, body: { id: 'Bad Id', label: 'Permits' } });
  assert.equal(r.status, 400);
});

test('deleting a department group that does not exist is a 404, and a group can be given an order', async () => {
  const admin = await adminSession();
  let r = await req('DELETE', '/api/admin/groups/nowhere', { cookie: admin });
  assert.equal(r.status, 404);
  r = await req('PATCH', '/api/admin/groups/building', { cookie: admin, body: { sortOrder: 3 } });
  assert.equal(r.status, 200);
  r = await req('PATCH', '/api/admin/groups/building', { cookie: admin, body: { sortOrder: '' } });
  assert.equal(r.status, 400);
});

test('an admin can move a service to a row, and a row that is not valid is refused', async () => {
  const admin = await adminSession();
  let r = await req('PATCH', '/api/admin/services/BPI', { cookie: admin, body: { row: 2, sortOrder: 1 } });
  assert.equal(r.status, 200);
  r = await req('PATCH', '/api/admin/services/BPI', { cookie: admin, body: { row: 0 } });
  assert.equal(r.status, 400);
  r = await req('POST', '/api/admin/services', { cookie: admin, body: { code: 'ROWY', name: 'Row test', row: 99 } });
  assert.equal(r.status, 400);
});

test('an admin can save the kiosk layout, but it must list every service that is on exactly once', async () => {
  const admin = await adminSession();
  let r = await req('PUT', '/api/admin/layout', { cookie: admin, body: { rows: [['BPI']] } });
  assert.equal(r.status, 200);
  r = await req('PUT', '/api/admin/layout', { cookie: admin, body: { rows: [[], ['BPI'], []] } });
  assert.equal(r.status, 200, 'empty rows are dropped');
  r = await req('PUT', '/api/admin/layout', { cookie: admin, body: { rows: [['BPI', 'NOPE']] } });
  assert.equal(r.status, 400);
  r = await req('PUT', '/api/admin/layout', { cookie: admin, body: { rows: [] } });
  assert.equal(r.status, 400, 'a layout that leaves a service out is refused');
  r = await req('PUT', '/api/admin/layout', { cookie: admin, body: { rows: [['BPI'], ['BPI']] } });
  assert.equal(r.status, 400);
  const mgr = (await signIn('mgr', 'ResetPass123')).cookie;
  assert.equal((await req('PUT', '/api/admin/layout', { cookie: mgr, body: { rows: [['BPI']] } })).status, 403);
});

test('a service set to ask for an appointment needs who and when; one that is not needs neither', async () => {
  let r = await req('POST', '/api/tickets', { body: { serviceId: 'BPI', name: 'Pat' } });
  assert.equal(r.status, 201);
  r = await req('POST', '/api/tickets', { body: { serviceId: 'ZD', name: 'Pat' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /who you are here to see/);
  r = await req('POST', '/api/tickets', { body: { serviceId: 'ZD', name: 'Pat', appointment: { with: 'Lee', time: '99:99' } } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /appointment time/);
  r = await req('POST', '/api/tickets', { body: { serviceId: 'ZD', name: 'Pat', appointment: { with: 'Lee', time: '9:30 AM' } } });
  assert.equal(r.status, 201);
});

test('an admin can switch the appointment and pinned behaviours on a service, and only with yes or no', async () => {
  const admin = await adminSession();
  let r = await req('PATCH', '/api/admin/services/BPI', { cookie: admin, body: { asksAppointment: true, pinned: true } });
  assert.equal(r.status, 200);
  r = await req('PATCH', '/api/admin/services/BPI', { cookie: admin, body: { pinned: 'yes' } });
  assert.equal(r.status, 400);
  r = await req('POST', '/api/admin/services', { cookie: admin, body: { code: 'APPT2', name: 'Inspection', asksAppointment: true } });
  assert.equal(r.status, 201);
});

test('a report comes with the names of every service, including ones turned off', async () => {
  const admin = await adminSession();
  const r = await req('GET', '/api/reports/range?from=2026-01-01&to=2026-01-02', { cookie: admin });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.services) && r.json.services.some((s) => s.code === 'BPI' && s.name));
});

test('deleting a service or a group takes it out of the monitor panels, and an empty panel goes back to its default', async () => {
  const admin = await adminSession();
  let r = await req('PUT', '/api/admin/app-settings', { cookie: admin, body: { monitor_left: ['building', 'ZD'] } });
  assert.equal(r.status, 200);
  r = await req('DELETE', '/api/admin/services/ZD', { cookie: admin });
  assert.equal(r.status, 200);
  r = await req('GET', '/api/admin/app-settings', { cookie: admin });
  assert.deepEqual(r.json.values.monitor_left, ['building']);
  r = await req('DELETE', '/api/admin/groups/building', { cookie: admin });
  assert.equal(r.status, 200);
  r = await req('GET', '/api/admin/app-settings', { cookie: admin });
  assert.deepEqual(r.json.values.monitor_left, ['planning', 'CE', 'BTD'], 'an empty panel returns to its default');
});

test('an admin can delete a language other than English, and English cannot be deleted', async () => {
  const admin = await adminSession();
  let r = await req('DELETE', '/api/admin/languages/en', { cookie: admin });
  assert.equal(r.status, 400);
  r = await req('DELETE', '/api/admin/languages/xx', { cookie: admin });
  assert.equal(r.status, 404);
  r = await req('DELETE', '/api/admin/languages/es', { cookie: admin });
  assert.equal(r.status, 200);
  const mgr = (await signIn('mgr', 'ResetPass123')).cookie;
  assert.equal((await req('DELETE', '/api/admin/languages/es', { cookie: mgr })).status, 403);
});

// Other sites and apps on the same domain set cookies this app never reads, and the browser sends them all. One with a
// stray % in it used to make every request fail, pages included.
test('a cookie from another app that is not valid percent-encoding does not break pages or sign-in', async () => {
  const stray = 'other=100%; broken=%E0%A4%A';
  assert.equal((await req('GET', '/index.html', { cookie: stray })).status, 200);
  assert.equal((await req('GET', '/api/public-settings', { cookie: stray })).status, 200);
  const admin = await adminSession();
  const r = await req('GET', '/api/auth/me', { cookie: stray + '; ' + admin });
  assert.equal(r.status, 200);
  assert.equal(r.json.username, 'admin');
});

test('a request body that is not valid JSON is a 400 the sender can read, not a server error', async () => {
  const r = await req('POST', '/api/auth/login', { raw: '{"username": "admin", ' });
  assert.equal(r.status, 400);
  assert.ok(r.json && r.json.error);
});

test('a recurring closure needs real clock times and a service that exists', async () => {
  const admin = await adminSession();
  const body = { message: 'Special Magistrate Hearing', recurrence: 'weekly', weekday: 3, startTime: '12:00', endTime: '16:00' };
  let r = await req('POST', '/api/services/BPI/schedules', { cookie: admin, body });
  assert.equal(r.status, 201);
  // Two digits either side of the colon is not enough: these used to reach the database and fail there with a 500.
  for (const endTime of ['99:99', '24:30', '12:60', '9:30']) {
    r = await req('POST', '/api/services/BPI/schedules', { cookie: admin, body: { ...body, endTime } });
    assert.equal(r.status, 400, endTime + ' should be refused');
  }
  r = await req('POST', '/api/services/NOPE/schedules', { cookie: admin, body });
  assert.equal(r.status, 404);
});

// The host serves these files straight from the folder, and an updated page can use a script it shares with other
// pages, so pages, scripts and styles are all re-checked on every use.
test('pages, scripts and styles are re-checked on every use', async () => {
  for (const file of ['/index.html', '/icons.js', '/app-settings.js', '/app.css']) {
    const r = await req('GET', file);
    assert.equal(r.status, 200, file);
    assert.match(r.headers.get('cache-control') || '', /no-cache/, file);
  }
});

test('the last active admin is protected, but an admin who is already switched off is not', async () => {
  const admin = await adminSession();
  const adminId = users.find((x) => x.username === 'admin').id;
  // Another admin who has been switched off: changing it cannot leave the system without an admin it still has.
  seed('retired', 'admin', 'RetiredPass123', { active: 0 });
  const retiredId = users.find((x) => x.username === 'retired').id;
  let r = await req('PATCH', '/api/users/' + retiredId, { cookie: admin, body: { role: 'staff' } });
  assert.equal(r.status, 200, 'an admin that is switched off can be changed to staff');
  seed('second', 'admin', 'SecondPass123');
  const secondId = users.find((x) => x.username === 'second').id;
  // With two active admins, one may be demoted; the other is then the last, and cannot be.
  r = await req('PATCH', '/api/users/' + secondId, { cookie: admin, body: { role: 'staff' } });
  assert.equal(r.status, 200);
  r = await req('PATCH', '/api/users/' + adminId, { cookie: admin, body: { active: false } });
  assert.equal(r.status, 403, 'nobody can disable their own account');
  users.splice(users.findIndex((x) => x.username === 'retired'), 1);
  users.splice(users.findIndex((x) => x.username === 'second'), 1);
});

test('the sub-path the app is served under is taken off the address, with or without a query', () => {
  assert.equal(withoutBasePath('/virtual-queue/api/queue', '/virtual-queue'), '/api/queue');
  assert.equal(withoutBasePath('/virtual-queue/', '/virtual-queue'), '/');
  assert.equal(withoutBasePath('/virtual-queue', '/virtual-queue'), '/');
  // This one used to become "?tab=reports", which no route matches, so the page was a 404.
  assert.equal(withoutBasePath('/virtual-queue?tab=reports', '/virtual-queue'), '/?tab=reports');
  assert.equal(withoutBasePath('/virtual-queue/manage.html?tab=staff', '/virtual-queue'), '/manage.html?tab=staff');
  // An address outside the sub-path, or a longer name that merely starts the same way, is left alone.
  assert.equal(withoutBasePath('/other/api/queue', '/virtual-queue'), '/other/api/queue');
  assert.equal(withoutBasePath('/virtual-queue-old/x', '/virtual-queue'), '/virtual-queue-old/x');
  assert.equal(withoutBasePath('/api/queue', ''), '/api/queue');
});

test('TRUST_PROXY: unset trusts every hop as before; a number counts proxies; false trusts none', () => {
  assert.equal(trustProxySetting(undefined), true);
  assert.equal(trustProxySetting(''), true);
  assert.equal(trustProxySetting('true'), true);
  assert.equal(trustProxySetting('1'), 1);
  assert.equal(trustProxySetting(' 2 '), 2);
  assert.equal(trustProxySetting('FALSE'), false);
  assert.equal(trustProxySetting('loopback, 10.0.0.0/8'), 'loopback, 10.0.0.0/8');
});

test('with TRUST_PROXY set to one proxy, a forged X-Forwarded-For does not change the address the check-in limit sees', async () => {
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const probe = express();
  probe.set('trust proxy', trustProxySetting('1'));
  probe.get('/ip', (req, res) => res.json({ ip: req.ip }));
  const listener = probe.listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));
  try {
    // A proxy that appends the address it saw: "what the visitor claimed, what the proxy saw".
    const res = await fetch('http://127.0.0.1:' + listener.address().port + '/ip', { headers: { 'X-Forwarded-For': '6.6.6.6, 203.0.113.9' } });
    assert.equal((await res.json()).ip, '203.0.113.9');
  } finally {
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
  }
});

// What an admin asks: when a service is added, is it added to the translations? It is in the list at once, with
// nothing translated, the kiosk shows its English text until it is, and the page is told what is still to do.
test('a service that is added shows up in the translations untranslated, and is counted until it is translated', async () => {
  const admin = await adminSession();
  rememberAddedServices = true;
  try {
    let r = await req('GET', '/api/admin/catalog', { cookie: admin });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.services.map((s) => s.untranslated), [['es']], 'BPI has no Spanish yet');
    const before = r.json.languages.find((l) => l.code === 'es').untranslated;
    assert.ok(before > 0, 'Spanish has items still to translate');
    assert.equal(r.json.languages.find((l) => l.code === 'en').untranslated, undefined, 'English is the base, so nothing is counted for it');

    r = await req('POST', '/api/admin/services', { cookie: admin, body: { code: 'TAXX', name: 'Tax Help', description: 'Questions about tax receipts' } });
    assert.equal(r.status, 201);

    // It is in the list for Spanish straight away, with its English text beside it and nothing translated.
    r = await req('GET', '/api/admin/translations?lang=es', { cookie: admin });
    const name = r.json.items.find((i) => i.key === 'service.TAXX.name');
    const description = r.json.items.find((i) => i.key === 'service.TAXX.description');
    assert.ok(name && description, 'both its name and its description are listed');
    assert.equal(name.english, 'Tax Help');
    assert.equal(name.value, '');
    assert.equal(description.value, '');

    // And the catalogue says it needs translating, and counts the two new items.
    r = await req('GET', '/api/admin/catalog', { cookie: admin });
    assert.deepEqual(r.json.services.find((s) => s.code === 'TAXX').untranslated, ['es']);
    assert.equal(r.json.languages.find((l) => l.code === 'es').untranslated, before + 2);

    // Translating the name alone is not enough while it has a description; both clears it.
    await req('PUT', '/api/admin/translations', { cookie: admin, body: { lang: 'es', values: { 'service.TAXX.name': 'Ayuda con impuestos' } } });
    r = await req('GET', '/api/admin/catalog', { cookie: admin });
    assert.deepEqual(r.json.services.find((s) => s.code === 'TAXX').untranslated, ['es']);
    await req('PUT', '/api/admin/translations', { cookie: admin, body: { lang: 'es', values: { 'service.TAXX.description': 'Preguntas sobre recibos de impuestos' } } });
    r = await req('GET', '/api/admin/catalog', { cookie: admin });
    assert.deepEqual(r.json.services.find((s) => s.code === 'TAXX').untranslated, []);
    assert.equal(r.json.languages.find((l) => l.code === 'es').untranslated, before);
  } finally {
    rememberAddedServices = false;
    addedServices.length = 0;
    delete savedTranslations.es;
  }
});

test('a service with no description is not left with a description to translate', async () => {
  const admin = await adminSession();
  rememberAddedServices = true;
  try {
    await req('POST', '/api/admin/services', { cookie: admin, body: { code: 'NODESC', name: 'No Description' } });
    const r = await req('GET', '/api/admin/translations?lang=es', { cookie: admin });
    assert.ok(r.json.items.some((i) => i.key === 'service.NODESC.name'));
    assert.ok(!r.json.items.some((i) => i.key === 'service.NODESC.description'), 'no description, so nothing to translate');
  } finally {
    rememberAddedServices = false;
    addedServices.length = 0;
  }
});

test('the kiosk wording list includes the messages that used to be fixed in English', async () => {
  const admin = await adminSession();
  const r = await req('GET', '/api/admin/translations?lang=es', { cookie: admin });
  const wording = r.json.items.filter((i) => i.section === 'Kiosk wording').map((i) => i.label);
  for (const key of ['choose_language', 'err_rate', 'offline_title', 'offline_message', 'offline_help']) {
    assert.ok(wording.includes(key), key + ' is in the list');
  }
  const i18n = await req('GET', '/api/i18n/en');
  assert.equal(i18n.json.strings.err_rate.length > 0 && i18n.json.strings.offline_help.length > 0, true);
});

// ---- The kiosk and monitor can be locked to a staff sign-in or an access link ----

async function setScreenLock(on) {
  const r = await req('PUT', '/api/admin/app-settings', { cookie: await adminSession(), body: { restrict_screens: on } });
  assert.equal(r.status, 200);
}
const isLocked = (r) => r.status === 401 && !!r.json && r.json.code === 'ACCESS_LOCKED';
async function makeLink(scope, name, panel) {
  const r = await req('POST', '/api/admin/screen-links', { cookie: await adminSession(), body: { name: name || scope + ' screen', scope, panel } });
  assert.equal(r.status, 201);
  return r.json; // { id, name, scope, panel, key }
}
const redeem = (key) => req('POST', '/api/access/redeem', { body: { key } });
const madeUpKey = () => require('node:crypto').randomBytes(32).toString('base64url');

test('the lock is an admin setting, and it is off until an admin turns it on', async () => {
  const admin = await adminSession();
  const mgr = (await signIn('mgr', 'ResetPass123')).cookie;
  const r = await req('GET', '/api/admin/app-settings', { cookie: admin });
  assert.equal(r.json.values.restrict_screens, false);
  assert.equal(r.json.definitions.restrict_screens.type, 'bool');
  assert.equal((await req('PUT', '/api/admin/app-settings', { cookie: mgr, body: { restrict_screens: true } })).status, 403);
  assert.equal((await req('PUT', '/api/admin/app-settings', { cookie: admin, body: { restrict_screens: 'yes' } })).status, 400);
  assert.equal((await req('GET', '/api/public-settings')).json.restrict_screens, undefined, 'the public settings do not say');
});

test('with the lock off, the kiosk and monitor are open to anyone, as they always were', async () => {
  await req('PUT', '/api/admin/app-settings', { cookie: await adminSession(), body: { checkin_rate_per_minute: 0 } });
  for (const url of ['/api/services', '/api/catalog', '/api/i18n/en', '/api/queue']) assert.equal((await req('GET', url)).status, 200, url);
  assert.equal((await req('POST', '/api/tickets', { body: { serviceId: 'BPI', name: 'Walk In' } })).status, 201);
  assert.deepEqual((await req('GET', '/api/access/status?screen=kiosk')).json, { restricted: false, allowed: true, linkScope: null });
  assert.equal((await req('GET', '/api/access/status?screen=somewhere')).status, 400);
});

test('with the lock on, strangers are refused everything the kiosk and monitor use, and nothing else changes', async () => {
  await setScreenLock(true);
  try {
    for (const url of ['/api/services', '/api/catalog', '/api/i18n/en', '/api/i18n/es', '/api/queue']) assert.ok(isLocked(await req('GET', url)), url);
    assert.ok(isLocked(await req('POST', '/api/tickets', { body: { serviceId: 'BPI', name: 'Stranger' } })));
    // What the sign-in page and every other page need stays open, and so does signing in.
    for (const url of ['/api/public-settings', '/index.html', '/kiosk.html', '/monitor.html']) assert.equal((await req('GET', url)).status, 200, url);
    assert.equal((await signIn('admin', 'AdminPass123')).status, 200);
    assert.deepEqual((await req('GET', '/api/access/status?screen=monitor')).json, { restricted: true, allowed: false, linkScope: null });
  } finally {
    await setScreenLock(false);
  }
});

test('with the lock on, someone signed in can use the screens, unless they still have to choose a new password', async () => {
  await setScreenLock(true);
  try {
    const admin = await adminSession();
    for (const url of ['/api/services', '/api/queue', '/api/catalog', '/api/i18n/en']) assert.equal((await req('GET', url, { cookie: admin })).status, 200, url);
    assert.equal((await req('POST', '/api/tickets', { cookie: admin, body: { serviceId: 'BPI', name: 'Walk In' } })).status, 201);
    assert.equal((await req('GET', '/api/access/status?screen=kiosk', { cookie: admin })).json.allowed, true);
    const newbie = (await signIn('newbie', 'NewbiePass123')).cookie;
    assert.ok(isLocked(await req('GET', '/api/services', { cookie: newbie })));
  } finally {
    await setScreenLock(false);
  }
});

test('an access link opens the kind of screen it was made for, and only that kind', async () => {
  const kiosk = await makeLink('kiosk', 'Lobby kiosk');
  const monitor = await makeLink('monitor', 'Lobby monitor');
  assert.match(kiosk.key, /^[A-Za-z0-9_-]{43}$/);
  await setScreenLock(true);
  try {
    // Opening the link hands the key over once, and the browser is given a cookie a script cannot read.
    const opened = await redeem(kiosk.key);
    assert.equal(opened.status, 200);
    assert.deepEqual([opened.json.scope, opened.json.name], ['kiosk', 'Lobby kiosk']);
    assert.match(opened.setCookie, /vq_screen=/);
    assert.match(opened.setCookie, /HttpOnly/);
    const k = opened.cookie;
    for (const url of ['/api/services', '/api/i18n/es', '/api/catalog']) assert.equal((await req('GET', url, { cookie: k })).status, 200, 'a kiosk link opens ' + url);
    assert.equal((await req('POST', '/api/tickets', { cookie: k, body: { serviceId: 'BPI', name: 'Kiosk Customer' } })).status, 201);
    assert.ok(isLocked(await req('GET', '/api/queue', { cookie: k })), 'a kiosk link does not open what the monitor shows');
    assert.deepEqual((await req('GET', '/api/access/status?screen=kiosk', { cookie: k })).json, { restricted: true, allowed: true, linkScope: null });
    assert.deepEqual((await req('GET', '/api/access/status?screen=monitor', { cookie: k })).json, { restricted: true, allowed: false, linkScope: 'kiosk' });
    // And the other way round.
    const m = (await redeem(monitor.key)).cookie;
    assert.equal((await req('GET', '/api/queue', { cookie: m })).status, 200);
    assert.equal((await req('GET', '/api/catalog', { cookie: m })).status, 200);
    assert.ok(isLocked(await req('GET', '/api/services', { cookie: m })));
    assert.ok(isLocked(await req('GET', '/api/i18n/en', { cookie: m })));
    assert.ok(isLocked(await req('POST', '/api/tickets', { cookie: m, body: { serviceId: 'BPI', name: 'Nope' } })), 'a monitor link cannot check anyone in');
  } finally {
    await setScreenLock(false);
  }
});

test('a wrong, missing or made-up key is refused, and a cookie that stops working is taken away', async () => {
  const unknown = madeUpKey();
  for (const key of [undefined, '', 'short', unknown, 12345]) {
    const r = await redeem(key);
    assert.equal(r.status, 403, String(key));
    assert.equal(r.setCookie, '', 'no cookie is given for ' + String(key));
  }
  await setScreenLock(true);
  try {
    const stale = 'vq_screen=' + unknown;
    assert.ok(isLocked(await req('GET', '/api/services', { cookie: stale })));
    const status = await req('GET', '/api/access/status?screen=kiosk', { cookie: stale });
    assert.equal(status.json.allowed, false);
    assert.match(status.setCookie, /vq_screen=;.*Max-Age=0/);
  } finally {
    await setScreenLock(false);
  }
});

test('a link that is revoked stops working at once, and replacing a link ends its old key', async () => {
  const admin = await adminSession();
  const link = await makeLink('kiosk', 'Back office kiosk');
  const cookie = (await redeem(link.key)).cookie;
  await setScreenLock(true);
  try {
    assert.equal((await req('GET', '/api/services', { cookie })).status, 200);
    assert.equal((await req('POST', '/api/admin/screen-links/' + link.id + '/revoke', { cookie: admin })).status, 200);
    assert.ok(isLocked(await req('GET', '/api/services', { cookie })), 'refused straight away, not after a delay');
    assert.equal((await redeem(link.key)).status, 403, 'a revoked link cannot be opened again');
    // Replacing it gives a new key and switches the link back on. The old key stays dead.
    const replaced = await req('POST', '/api/admin/screen-links/' + link.id + '/replace', { cookie: admin });
    assert.equal(replaced.status, 200);
    assert.notEqual(replaced.json.key, link.key);
    assert.equal((await redeem(link.key)).status, 403);
    const fresh = await redeem(replaced.json.key);
    assert.equal(fresh.status, 200);
    assert.equal((await req('GET', '/api/services', { cookie: fresh.cookie })).status, 200);
    // Removing it ends it for good.
    assert.equal((await req('DELETE', '/api/admin/screen-links/' + link.id, { cookie: admin })).status, 200);
    assert.ok(isLocked(await req('GET', '/api/services', { cookie: fresh.cookie })));
    assert.equal((await req('POST', '/api/admin/screen-links/' + link.id + '/revoke', { cookie: admin })).status, 404);
    const actions = (await req('GET', '/api/admin/audit', { cookie: admin })).json.map((a) => a.action);
    for (const action of ['screen_link.create', 'screen_link.revoke', 'screen_link.replace', 'screen_link.delete']) assert.ok(actions.includes(action), action + ' is in the audit log');
  } finally {
    await setScreenLock(false);
  }
});

test('only admins manage access links, the key is shown once, and nothing kept could be used as a key', async () => {
  const admin = await adminSession();
  const mgr = (await signIn('mgr', 'ResetPass123')).cookie;
  assert.equal((await req('GET', '/api/admin/screen-links')).status, 401);
  assert.equal((await req('GET', '/api/admin/screen-links', { cookie: mgr })).status, 403);
  assert.equal((await req('POST', '/api/admin/screen-links', { cookie: mgr, body: { name: 'x', scope: 'kiosk' } })).status, 403);
  assert.equal((await req('POST', '/api/admin/screen-links', { cookie: admin, body: { name: '  ', scope: 'kiosk' } })).status, 400);
  assert.equal((await req('POST', '/api/admin/screen-links', { cookie: admin, body: { name: 'Front desk', scope: 'admin' } })).status, 400);
  const made = await makeLink('monitor', 'Front desk monitor');
  const list = await req('GET', '/api/admin/screen-links', { cookie: admin });
  const mine = list.json.find((l) => l.id === made.id);
  assert.deepEqual([mine.name, mine.scope, mine.panel, mine.createdBy, mine.revokedAt], ['Front desk monitor', 'monitor', 'full', 'admin', null]);
  assert.ok(!list.text.includes(made.key), 'the key is not in the list');
  assert.deepEqual(Object.keys(mine).sort(), ['createdAt', 'createdBy', 'id', 'lastUsedAt', 'name', 'panel', 'revokedAt', 'scope'], 'no key and no hash in the list');
  for (const action of ['replace', 'revoke']) {
    assert.equal((await req('POST', '/api/admin/screen-links/abc/' + action, { cookie: admin })).status, 400);
    assert.equal((await req('POST', '/api/admin/screen-links/99999/' + action, { cookie: admin })).status, 404);
  }
  assert.equal((await req('DELETE', '/api/admin/screen-links/99999', { cookie: admin })).status, 404);
});

test('a monitor link is made for the full screen, the left or the right, and the choice stays with the link', async () => {
  const admin = await adminSession();
  const post = (body) => req('POST', '/api/admin/screen-links', { cookie: admin, body });
  // Left out, a monitor link is the full screen, and so is any kiosk link whatever it is sent.
  assert.equal((await makeLink('monitor', 'Whole wall')).panel, 'full');
  assert.equal((await makeLink('kiosk', 'Door kiosk', 'left')).panel, 'full', 'a kiosk has no sides');
  const left = await makeLink('monitor', 'Left TV', 'left');
  const right = await makeLink('monitor', 'Right TV', 'right');
  assert.deepEqual([left.panel, right.panel, (await makeLink('monitor', 'Wall', 'full')).panel], ['left', 'right', 'full']);
  const panels = (await req('GET', '/api/admin/screen-links', { cookie: admin })).json;
  assert.equal(panels.find((l) => l.id === left.id).panel, 'left');
  assert.equal(panels.find((l) => l.id === right.id).panel, 'right');
  // Anything else is refused.
  for (const bad of ['middle', 'LEFT', 7, {}, ['left']]) {
    const r = await post({ name: 'Odd TV', scope: 'monitor', panel: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.json.error, /Full, Left or Right/);
  }
  // A new key keeps the choice.
  const replaced = await req('POST', '/api/admin/screen-links/' + left.id + '/replace', { cookie: admin });
  assert.equal(replaced.json.panel, 'left');
  const audit = (await req('GET', '/api/admin/audit', { cookie: admin })).json;
  assert.ok(audit.some((a) => a.action === 'screen_link.create' && a.detail === 'monitor, left'), 'the audit log says which side');
});

// A fraction (1.5) used to go into the query as it was, which is a syntax error there: a 500 from a page address.
test('the audit log limit is always a whole number from 1 to 1000', async () => {
  const admin = await adminSession();
  const asked = async (query) => { assert.equal((await req('GET', '/api/admin/audit' + query, { cookie: admin })).status, 200, query); return lastAuditLimit; };
  assert.equal(await asked('?limit=1.5'), 1);
  assert.equal(await asked('?limit=250.9'), 250);
  assert.equal(await asked('?limit=5000'), 1000);
  assert.equal(await asked('?limit=-4'), 1);
  assert.equal(await asked('?limit=abc'), 200);
  assert.equal(await asked('?limit=0'), 200);
  assert.equal(await asked(''), 200);
});

// Opens a live connection the way a page does, and says what the server answered.
function liveConnection(port, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/socket.io/?EIO=4&transport=websocket', cookie ? { headers: { Cookie: cookie } } : {});
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('no answer from the live connection')); }, 5000);
    ws.on('message', (data) => {
      const text = String(data);
      if (text[0] === '0') ws.send('40');
      else if (text.startsWith('40')) { clearTimeout(timer); resolve({ answer: 'connected', ws }); }
      else if (text.startsWith('44')) { clearTimeout(timer); ws.close(); resolve({ answer: 'refused', ws }); }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
const closes = (ws, ms) => Promise.race([
  new Promise((resolve) => ws.on('close', () => resolve(true))),
  new Promise((resolve) => setTimeout(() => resolve(false), ms || 3000)),
]);

test('with the lock on, a stranger cannot hold the live connection, and turning the lock on drops the ones already open', async () => {
  await new Promise((resolve) => liveServer.listen(0, '127.0.0.1', resolve));
  const port = liveServer.address().port;
  const open = [];
  try {
    // Off: anyone connects.
    const before = await liveConnection(port);
    assert.equal(before.answer, 'connected');
    open.push(before.ws);
    const dropped = closes(before.ws);
    await setScreenLock(true);
    assert.equal(await dropped, true, 'a connection that was already open is dropped, so it is checked again');
    // On: a stranger is refused, a signed-in person and a screen with a link are not.
    assert.equal((await liveConnection(port)).answer, 'refused');
    const admin = await adminSession();
    const signedIn = await liveConnection(port, admin);
    open.push(signedIn.ws);
    assert.equal(signedIn.answer, 'connected');
    const link = await makeLink('monitor', 'Live monitor');
    const cookie = (await redeem(link.key)).cookie;
    const withLink = await liveConnection(port, cookie);
    open.push(withLink.ws);
    assert.equal(withLink.answer, 'connected');
    // Revoking the link drops its live connection as well, and it is not let back in.
    const gone = closes(withLink.ws);
    await req('POST', '/api/admin/screen-links/' + link.id + '/revoke', { cookie: admin });
    assert.equal(await gone, true);
    assert.equal((await liveConnection(port, cookie)).answer, 'refused');
  } finally {
    await setScreenLock(false);
    open.forEach((ws) => ws.terminate());
    liveServer.closeAllConnections();
    await new Promise((resolve) => liveServer.close(resolve));
  }
});

test('opening links is limited per minute from one address, so a key cannot be found by trying', async () => {
  const statuses = [];
  for (let i = 0; i < 30; i++) statuses.push((await redeem(madeUpKey())).status);
  assert.ok(statuses.includes(429), 'it stops after a number of tries: ' + statuses.join(' '));
  assert.ok(statuses.every((s) => s === 403 || s === 429), 'every try is refused: ' + statuses.join(' '));
});

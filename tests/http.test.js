// Runs the real routes in server.js against an in-memory stand-in for the database, so the access rules,
// sign-in, sessions, settings, check-in limit, logo and error handling are all tested without MySQL.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
process.env.SESSION_SECRET = 'test-only-secret-0123456789abcdefghijklmnopqrstuvwxyz';

// ---- in-memory stand-in for db.js ----
const users = [];
const audit = [];
const settings = {};
const tickets = [];
let nextId = 1;
let settingValueLimit = 0; // when set, saved settings are cut to this length, as the old VARCHAR(255) column did
let failAudit = false; // makes the audit list fail, to test the error handler
let openTicketsToClose = 0; // how many open tickets the end-of-day close finds

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
  listAudit: async () => {
    if (failAudit) throw new Error('simulated failure in a late route');
    return audit.map((a) => ({ actorName: a.who, action: a.action, target: a.target, detail: a.detail }));
  },
  listServices: async () => [
    { code: 'BPI', name: 'Building Permits & Inspections', route: null, available: true, unavailableMessage: null },
    { code: 'ZD', name: 'Zoning', route: null, available: true, unavailableMessage: null },
  ],
  listServicesAdmin: async () => [],
  listSchedules: async () => [],
  listGroups: async () => [
    { id: 'building', label: 'Building Dept.', englishLabel: 'Building Dept.', icon: 'building', color: '#2f6fd6', sortOrder: 1, codes: ['BPI'] },
  ],
  listLanguages: async () => [
    { code: 'en', name: 'English', enabled: true },
    { code: 'es', name: 'Español', enabled: true },
  ],
  listCatalogServices: async () => [
    { code: 'BPI', name: 'Building Permits & Inspections', description: 'Permits', icon: 'building', color: null, route: 'Building Dept.', groupId: 'building', active: true, sortOrder: 1, hasTickets: false },
  ],
  getTranslations: async () => ({}),
  setTranslations: async () => {},
  knownTranslationKeys: async () => ['service.BPI.name', 'service.BPI.description', 'group.building.label', 'ui.btn_join'],
  createService: async () => {},
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
  closeOpenTickets: async () => { const n = openTicketsToClose; openTicketsToClose = 0; return n; },
  cleanupOldTickets: async () => 0,
  cleanupAudit: async () => 0,
};
const dbPath = require.resolve(path.join(ROOT, 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const auth = require(path.join(ROOT, 'auth.js'));
const { app, checkAutoClose } = require(path.join(ROOT, 'server.js'));

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

test('managers cannot use the Services & languages admin routes', async () => {
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

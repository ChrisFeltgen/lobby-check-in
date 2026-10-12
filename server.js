'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const { Server } = require('socket.io');
const db = require('./db');
const auth = require('./auth');
const reports = require('./reports');
const appSettings = require('./settings');
const catalog = require('./catalog');
const privacy = require('./privacy');
const { UI_STRINGS } = require('./ui-strings');

const PORT = process.env.PORT || 3000;
// Set BASE_PATH (e.g. /virtual-queue) when the app is served under a sub-path. Leave empty for a domain root.
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');

// Signs and verifies session cookies. Without a fixed secret, a new random one is used for this
// process, which works fine but signs everyone out whenever the app restarts.
let SESSION_SECRET = process.env.SESSION_SECRET || '';
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('WARNING: SESSION_SECRET is not set. Using a random secret for this run, so all staff will be signed out on every restart. Set SESSION_SECRET to a long random value to avoid this.');
}

const app = express();
app.disable('x-powered-by');
// Basic browser protections for every response. The pages are all same-origin, so SAMEORIGIN framing
// still lets the kiosk and monitor work while stopping other sites from framing the sign-in and Management pages.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.set('trust proxy', true); // so req.secure reflects the original request behind a reverse proxy
if (BASE_PATH) {
  // The host forwards the full path, so remove the prefix before routing.
  app.use((req, res, next) => {
    if (req.url === BASE_PATH || req.url.startsWith(BASE_PATH + '/') || req.url.startsWith(BASE_PATH + '?')) {
      req.url = req.url.slice(BASE_PATH.length) || '/';
    }
    next();
  });
}
// Most routes take small JSON bodies. The logo upload is the one route that takes a larger image.
const smallJson = express.json({ limit: '10kb' });
const logoJson = express.json({ limit: '500kb' });
app.use((req, res, next) => (req.path === '/api/admin/logo' || req.path === '/api/admin/translations' ? logoJson : smallJson)(req, res, next));
app.use((req, res, next) => {
  req.cookies = auth.parseCookies(req.headers.cookie);
  next();
});
// HTML pages must be re-checked on every navigation. Without this, a normal link click can reuse a
// cached copy of an older page (e.g. manage.html without a newly added tab), and only a refresh shows the update.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

const server = http.createServer(app);
const io = new Server(server, { path: BASE_PATH + '/socket.io' });

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Tell every connected kiosk, staff screen and monitor to refresh.
function notify() {
  io.emit('queue:changed');
}

// A change to services, groups, languages or wording: the kiosk and monitors re-read the catalogue as well.
function notifyCatalog() {
  io.emit('catalog:changed');
  notify();
}

function cookiePath() { return BASE_PATH || '/'; }

async function currentSettings() {
  return appSettings.parseSettings(await db.getSettings());
}

async function loadSessionUser(req, res) {
  const token = req.cookies[auth.SESSION_COOKIE];
  const payload = token && auth.verifySession(SESSION_SECRET, token);
  if (!payload) return null;
  const user = await db.getUser(payload.uid);
  if (!user || !user.active) return null;
  // A password reset ends every session started before it. Sessions without a start time are treated as older.
  if (user.sessionsRevokedAt && (typeof payload.iat !== 'number' || payload.iat < user.sessionsRevokedAt)) return null;
  await renewSession(req, res, payload);
  return user;
}

// Starts a session for this browser. The sign-out time follows the session length and idle setting.
async function issueSession(req, res, userId, s) {
  const now = Date.now();
  const sessionMs = s.session_hours * 3600000;
  const exp = s.session_idle_minutes ? Math.min(now + s.session_idle_minutes * 60000, now + sessionMs) : now + sessionMs;
  const token = auth.signSession(SESSION_SECRET, { uid: userId, iat: now, exp });
  res.setHeader('Set-Cookie', auth.sessionCookie(token, { path: cookiePath(), secure: req.secure, maxAgeMs: exp - now }));
}

// With an idle timeout set, each request moves the sign-out time forward, up to the session length
// from sign-in. The session length is only ever shortened by a request, never extended past it.
async function renewSession(req, res, payload) {
  const s = await currentSettings();
  if (!s.session_idle_minutes || typeof payload.iat !== 'number') return;
  const now = Date.now();
  const exp = Math.min(now + s.session_idle_minutes * 60000, payload.iat + s.session_hours * 3600000);
  if (Math.abs(exp - payload.exp) < 60000) return; // Only rewrite the cookie when the time has moved by a minute or more, either way.
  const token = auth.signSession(SESSION_SECRET, { uid: payload.uid, iat: payload.iat, exp });
  res.setHeader('Set-Cookie', auth.sessionCookie(token, { path: cookiePath(), secure: req.secure, maxAgeMs: exp - now }));
}

// Attaches req.user when a valid session cookie is present. Does not require one to exist.
function withUser(fn) {
  return wrap(async (req, res, next) => {
    req.user = await loadSessionUser(req, res);
    return fn(req, res, next);
  });
}

// Rejects the request unless the signed-in user's role is at least `minRole`.
function requireRole(minRole) {
  return wrap(async (req, res, next) => {
    req.user = await loadSessionUser(req, res);
    // 401 means "not signed in" (the pages send the person to sign-in). A signed-in person without the
    // right role gets 403, so the page can say so instead of sending them away.
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    if (!auth.roleAtLeast(req.user.role, minRole)) {
      return res.status(403).json({ error: 'Your account does not have access to this.' });
    }
    // Until a forced password change is done, only the My account routes are open.
    if (req.user.mustChangePassword && !req.path.startsWith('/api/account')) {
      return res.status(403).json({ error: 'You must choose a new password before continuing.', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    next();
  });
}

const SERVICE_CODE = /^[A-Z0-9]{1,10}$/;
// A service that asks for an appointment (set in Services & languages) wants who the visitor is seeing and the
// time they are booked for.
const APPOINTMENT_TIME = /^(1[0-2]|0?[1-9]):[0-5][0-9] (AM|PM)$/;
const TICKET_ACTIONS = ['call', 'complete', 'remove', 'return'];
const USERNAME_RE = /^[a-z0-9._-]{3,40}$/i;
const ROLES = ['staff', 'manager', 'admin'];

// Public: kiosk and monitor
// The language to use for a request: one that is switched on, otherwise English.
async function languageFor(code) {
  if (!code || code === 'en') return 'en';
  const langs = await db.listLanguages();
  return langs.some((l) => l.code === code && l.enabled) ? code : 'en';
}

async function departmentList() {
  return (await db.listGroups('en')).map((g) => ({ id: g.id, label: g.label }));
}

// Active services. With ?lang=, names and descriptions come in that language where translated.
app.get('/api/services', wrap(async (req, res) => {
  res.json(await db.listServices(await languageFor(String(req.query.lang || ''))));
}));

// Department groups and the languages the kiosk offers.
app.get('/api/catalog', wrap(async (req, res) => {
  const lang = await languageFor(String(req.query.lang || ''));
  const languages = (await db.listLanguages()).filter((l) => l.enabled);
  res.json({ groups: await db.listGroups(lang), languages });
}));

// The kiosk's wording for one language. Anything not translated falls back to English.
app.get('/api/i18n/:lang', wrap(async (req, res) => {
  const lang = await languageFor(req.params.lang);
  const strings = { ...UI_STRINGS.en };
  if (lang !== 'en') {
    const tr = await db.getTranslations(lang);
    for (const key of Object.keys(strings)) {
      const value = tr[catalog.keys.ui(key)];
      if (value) strings[key] = value;
    }
  }
  res.json({ lang, strings });
}));

// ---- Services & languages (admin): services, department groups, languages and translations ----

app.get('/api/admin/catalog', requireRole('admin'), wrap(async (req, res) => {
  res.json({
    services: await db.listCatalogServices(),
    groups: await db.listGroups('en'),
    languages: await db.listLanguages(),
    iconNames: catalog.ICON_NAMES,
  });
}));

app.post('/api/admin/services', requireRole('admin'), wrap(async (req, res) => {
  const groupIds = (await db.listGroups('en')).map((g) => g.id);
  const checked = catalog.validateService(req.body, groupIds, true);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const existing = (await db.listCatalogServices()).find((s) => s.code === checked.values.code);
  if (existing) return res.status(409).json({ error: 'A service with that code already exists' });
  await db.createService(checked.values);
  await db.logAudit(req.user.displayName, 'service.create', checked.values.code, checked.values.name);
  notifyCatalog();
  res.status(201).json({ ok: true });
}));

app.patch('/api/admin/services/:code', requireRole('admin'), wrap(async (req, res) => {
  const code = req.params.code;
  if (!catalog.CODE_RE.test(code)) return res.status(400).json({ error: 'Invalid service' });
  const groupIds = (await db.listGroups('en')).map((g) => g.id);
  const checked = catalog.validateService(req.body, groupIds, false);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!Object.keys(checked.values).length) return res.status(400).json({ error: 'Nothing to change' });
  if (!(await db.updateService(code, checked.values))) return res.status(404).json({ error: 'Service not found' });
  await db.logAudit(req.user.displayName, 'service.update', code, Object.keys(checked.values).join(', '));
  notifyCatalog();
  res.json({ ok: true });
}));

// The kiosk layout: which services sit on which row, and in what order. Sent whole, so it is saved all or nothing.
app.put('/api/admin/layout', requireRole('admin'), wrap(async (req, res) => {
  const active = (await db.listCatalogServices()).filter((s) => s.active).map((s) => s.code);
  const checked = catalog.validateLayout(req.body, active);
  if (checked.error) return res.status(400).json({ error: checked.error });
  await db.setLayout(checked.rows);
  await db.logAudit(req.user.displayName, 'layout.update', 'Kiosk layout', checked.rows.map((r) => r.join(' ')).join(' / '));
  notifyCatalog();
  res.json({ ok: true });
}));

// Takes ids that no longer exist out of the left and right monitor panels in Settings. A panel left with nothing
// goes back to its default.
async function pruneMonitorPanels(removed) {
  const values = appSettings.parseSettings(await db.getSettings());
  for (const key of ['monitor_left', 'monitor_right']) {
    const next = values[key].filter((id) => !removed.includes(id));
    if (next.length === values[key].length) continue;
    await db.setSetting(key, next.length ? appSettings.toStored(key, next) : '');
  }
}

app.delete('/api/admin/services/:code', requireRole('admin'), wrap(async (req, res) => {
  const code = req.params.code;
  if (!catalog.CODE_RE.test(code)) return res.status(400).json({ error: 'Invalid service' });
  const existing = (await db.listCatalogServices()).find((s) => s.code === code);
  const result = await db.deleteService(code);
  if (!result.ok) return res.status(409).json({ error: 'This service has customers on record, so it cannot be deleted. Turn it off instead.' });
  await db.logAudit(req.user.displayName, 'service.delete', code, existing ? existing.name : null);
  await pruneMonitorPanels([code]);
  notifyCatalog();
  res.json({ ok: true });
}));

app.post('/api/admin/groups', requireRole('admin'), wrap(async (req, res) => {
  const ids = (await db.listGroups('en')).map((g) => g.id);
  const checked = catalog.validateGroup(req.body, ids, true);
  if (checked.error) return res.status(400).json({ error: checked.error });
  await db.createGroup(checked.values);
  await db.logAudit(req.user.displayName, 'group.create', checked.values.id, checked.values.label);
  notifyCatalog();
  res.status(201).json({ ok: true });
}));

app.patch('/api/admin/groups/:id', requireRole('admin'), wrap(async (req, res) => {
  const id = req.params.id;
  const ids = (await db.listGroups('en')).map((g) => g.id);
  if (!ids.includes(id)) return res.status(404).json({ error: 'Group not found' });
  const checked = catalog.validateGroup(req.body, ids, false);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!Object.keys(checked.values).length) return res.status(400).json({ error: 'Nothing to change' });
  await db.updateGroup(id, checked.values);
  await db.logAudit(req.user.displayName, 'group.update', id, Object.keys(checked.values).join(', '));
  notifyCatalog();
  res.json({ ok: true });
}));

app.delete('/api/admin/groups/:id', requireRole('admin'), wrap(async (req, res) => {
  const ids = (await db.listGroups('en')).map((g) => g.id);
  if (!ids.includes(req.params.id)) return res.status(404).json({ error: 'Group not found' });
  const result = await db.deleteGroup(req.params.id);
  if (!result.ok) return res.status(409).json({ error: 'Move or delete the services in this group first.' });
  await db.logAudit(req.user.displayName, 'group.delete', req.params.id, null);
  await pruneMonitorPanels([req.params.id]);
  notifyCatalog();
  res.json({ ok: true });
}));

app.post('/api/admin/languages', requireRole('admin'), wrap(async (req, res) => {
  const codes = (await db.listLanguages()).map((l) => l.code);
  const checked = catalog.validateLanguage(req.body, codes, true);
  if (checked.error) return res.status(400).json({ error: checked.error });
  await db.createLanguage(checked.values);
  await db.logAudit(req.user.displayName, 'language.create', checked.values.code, checked.values.name);
  notifyCatalog();
  res.status(201).json({ ok: true });
}));

app.patch('/api/admin/languages/:code', requireRole('admin'), wrap(async (req, res) => {
  const code = req.params.code;
  const codes = (await db.listLanguages()).map((l) => l.code);
  if (!codes.includes(code)) return res.status(404).json({ error: 'Language not found' });
  if (code === 'en' && req.body && req.body.enabled === false) return res.status(400).json({ error: 'English cannot be turned off' });
  const checked = catalog.validateLanguage(req.body, codes, false);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!Object.keys(checked.values).length) return res.status(400).json({ error: 'Nothing to change' });
  await db.updateLanguage(code, checked.values);
  await db.logAudit(req.user.displayName, 'language.update', code, Object.keys(checked.values).join(', '));
  notifyCatalog();
  res.json({ ok: true });
}));

app.delete('/api/admin/languages/:code', requireRole('admin'), wrap(async (req, res) => {
  const code = req.params.code;
  if (code === 'en') return res.status(400).json({ error: 'English cannot be removed' });
  const codes = (await db.listLanguages()).map((l) => l.code);
  if (!codes.includes(code)) return res.status(404).json({ error: 'Language not found' });
  await db.deleteLanguage(code);
  await db.logAudit(req.user.displayName, 'language.delete', code, null);
  notifyCatalog();
  res.json({ ok: true });
}));

// Every translatable item for one language, with its English text alongside.
app.get('/api/admin/translations', requireRole('admin'), wrap(async (req, res) => {
  const lang = String(req.query.lang || '');
  const codes = (await db.listLanguages()).map((l) => l.code);
  if (lang === 'en' || !codes.includes(lang)) return res.status(400).json({ error: 'Choose a language to translate' });
  const tr = await db.getTranslations(lang);
  const items = [];
  for (const s of await db.listCatalogServices()) {
    items.push({ key: catalog.keys.serviceName(s.code), section: 'Services', label: s.code + ' name', english: s.name, value: tr[catalog.keys.serviceName(s.code)] || '' });
    items.push({ key: catalog.keys.serviceDescription(s.code), section: 'Services', label: s.code + ' description', english: s.description, value: tr[catalog.keys.serviceDescription(s.code)] || '' });
  }
  for (const g of await db.listGroups('en')) {
    items.push({ key: catalog.keys.groupLabel(g.id), section: 'Department groups', label: g.id, english: g.englishLabel, value: tr[catalog.keys.groupLabel(g.id)] || '' });
  }
  for (const k of Object.keys(UI_STRINGS.en)) {
    items.push({ key: catalog.keys.ui(k), section: 'Kiosk wording', label: k, english: UI_STRINGS.en[k], value: tr[catalog.keys.ui(k)] || '' });
  }
  res.json({ lang, items });
}));

app.put('/api/admin/translations', requireRole('admin'), wrap(async (req, res) => {
  const body = req.body || {};
  const lang = String(body.lang || '');
  const codes = (await db.listLanguages()).map((l) => l.code);
  if (lang === 'en' || !codes.includes(lang)) return res.status(400).json({ error: 'Choose a language to translate' });
  const checked = catalog.validateTranslations(body.values, await db.knownTranslationKeys());
  if (checked.error) return res.status(400).json({ error: checked.error });
  await db.setTranslations(lang, checked.changes);
  await db.logAudit(req.user.displayName, 'translations.update', lang, Object.keys(checked.changes).length + ' item(s)');
  notifyCatalog();
  res.json({ ok: true });
}));

// ---- App settings (kiosk, monitor, security, branding) ----

// Public, for the lobby monitor: customers as first name and last initial only.
app.get('/api/queue', wrap(async (req, res) => {
  res.json(privacy.publicQueue(await db.queueSnapshot()));
}));

// The same queue with everything staff need: full names and appointment details.
app.get('/api/staff/queue', requireRole('staff'), wrap(async (req, res) => {
  res.json(await db.queueSnapshot());
}));

// Check-in attempts per address in the last minute. Kept in memory, so it starts again after a restart.
const checkinAttempts = new Map();
function checkinAllowed(address, limit, now) {
  const cutoff = now - 60000;
  if (checkinAttempts.size > 1000) {
    for (const [key, times] of checkinAttempts) {
      if (!times.some((t) => t > cutoff)) checkinAttempts.delete(key);
    }
  }
  const recent = (checkinAttempts.get(address) || []).filter((t) => t > cutoff);
  const allowed = recent.length < limit;
  if (allowed) recent.push(now);
  checkinAttempts.set(address, recent);
  return allowed;
}

app.post('/api/tickets', wrap(async (req, res) => {
  const limit = (await currentSettings()).checkin_rate_per_minute;
  if (limit && !checkinAllowed(req.ip, limit, Date.now())) {
    return res.status(429).json({ error: 'Too many check-ins from this address. Please wait a minute and try again.' });
  }
  const serviceId = req.body && req.body.serviceId;
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
  if (typeof serviceId !== 'string' || !SERVICE_CODE.test(serviceId)) {
    return res.status(400).json({ error: 'Choose a service' });
  }
  if (!name) return res.status(400).json({ error: 'Enter your name' });

  const availability = await db.getServiceAvailability(serviceId);
  if (!availability) return res.status(404).json({ error: 'That service is not available' });
  if (!availability.available) return res.status(409).json({ error: availability.message });

  let appointment = null;
  if (availability.asksAppointment) {
    const withName = String((req.body.appointment && req.body.appointment.with) || '').trim().slice(0, 100);
    const time = String((req.body.appointment && req.body.appointment.time) || '').trim();
    if (!withName) return res.status(400).json({ error: 'Enter who you are here to see' });
    if (!APPOINTMENT_TIME.test(time)) return res.status(400).json({ error: 'Choose your appointment time' });
    appointment = { with: withName, time };
  }

  const ticket = await db.createTicket(serviceId, name, appointment);
  if (!ticket) return res.status(404).json({ error: 'That service is not available' });
  notify();
  res.status(201).json(ticket);
}));

// ---- Accounts ----
app.post('/api/auth/login', wrap(async (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  const s = await currentSettings();
  // Too many recent failures locks the User ID for a while, even with the right password.
  if (username && s.lockout_attempts) {
    const failures = await db.countRecentLoginFailures(username, s.lockout_minutes);
    if (failures >= s.lockout_attempts) {
      return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again in ' + s.lockout_minutes + ' minutes.' });
    }
  }
  const row = username && (await db.findUserByUsername(username));
  if (!row || !row.active || !auth.verifyPassword(password, row.password_hash)) {
    db.logAudit(username || '(blank)', 'auth.login_failed', username || '(blank)', null).catch(() => {});
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  await issueSession(req, res, row.id, s);
  db.touchLastLogin(row.id).catch(() => {});
  db.logAudit(row.display_name, 'auth.login', row.username, null).catch(() => {});
  res.json({ id: row.id, username: row.username, displayName: row.display_name, role: row.role, mustChangePassword: !!row.must_change_password });
}));

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', auth.clearCookie({ path: cookiePath(), secure: req.secure }));
  res.json({ ok: true });
});

app.get('/api/auth/me', withUser(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  res.json(req.user);
}));

// Managers see and manage staff accounts only. Admins see and manage every account.
app.get('/api/users', requireRole('manager'), wrap(async (req, res) => {
  res.json(await db.listUsers(req.user.role === 'manager' ? 'staff' : null));
}));

app.post('/api/users', requireRole('manager'), wrap(async (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const displayName = String((req.body && req.body.displayName) || '').trim().slice(0, 100);
  const password = String((req.body && req.body.password) || '');
  const role = req.body && req.body.role;
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 3-40 letters, numbers, dots, dashes or underscores' });
  if (!displayName) return res.status(400).json({ error: 'Enter a display name' });
  const policy = await currentSettings();
  const passwordError = auth.passwordProblem(password, undefined, policy.min_password_length);
  if (passwordError) return res.status(400).json({ error: passwordError });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  // New accounts must choose their own password at first sign-in unless the creator turns that off.
  const requestedChange = req.body ? req.body.mustChangePassword : undefined;
  const mustChangePassword = typeof requestedChange === 'boolean' ? requestedChange : policy.new_account_change_password;
  if (req.user.role === 'manager' && role !== 'staff') return res.status(403).json({ error: 'Managers can only create Staff accounts' });

  const existing = await db.findUserByUsername(username);
  if (existing) return res.status(409).json({ error: 'That username is already taken' });

  const user = await db.createUser(username.toLowerCase(), displayName, auth.hashPassword(password), role, mustChangePassword);
  await db.logAudit(req.user.displayName, 'user.create', user.username,
    'name: ' + user.displayName + ', role: ' + user.role + (mustChangePassword ? ', must change password' : ''));
  res.status(201).json(user);
}));

app.patch('/api/users/:id', requireRole('manager'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid request' });
  const target = await db.getUser(id);
  if (!target) return res.status(404).json({ error: 'Account not found' });

  // A manager may only touch Staff accounts, and may never grant a role above Staff. Anyone may
  // edit their own name and User ID, but never their own role, and never disable themselves.
  const body = req.body || {};
  const isSelf = target.id === req.user.id;
  const nextRole = body.role !== undefined ? body.role : target.role;
  if (!isSelf && req.user.role === 'manager' && (target.role !== 'staff' || nextRole !== 'staff')) {
    return res.status(403).json({ error: 'Managers can only manage Staff accounts' });
  }
  if (isSelf && body.role !== undefined && body.role !== target.role) {
    return res.status(403).json({ error: 'You cannot change your own role' });
  }
  if (isSelf && body.active === false) {
    return res.status(403).json({ error: 'You cannot disable your own account' });
  }
  if (body.role !== undefined && !ROLES.includes(body.role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  // Never leave the system with no active admin.
  const demotingOrDisabling =
    (body.role !== undefined && body.role !== 'admin' && target.role === 'admin') ||
    (body.active === false && target.role === 'admin');
  if (demotingOrDisabling && (await db.countActiveAdmins()) <= 1) {
    return res.status(409).json({ error: 'At least one active admin account must remain' });
  }

  const patch = {};
  if (body.displayName !== undefined) {
    const displayName = String(body.displayName).trim().slice(0, 100);
    if (!displayName) return res.status(400).json({ error: 'Enter a display name' });
    patch.displayName = displayName;
  }
  if (body.username !== undefined) {
    const username = String(body.username).trim().toLowerCase();
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'User ID must be 3-40 letters, numbers, dots, dashes or underscores' });
    const clash = await db.findUserByUsername(username);
    if (clash && clash.id !== id) return res.status(409).json({ error: 'That User ID is already taken' });
    patch.username = username;
  }
  if (body.role !== undefined) patch.role = body.role;
  if (body.active !== undefined) patch.active = !!body.active;
  if (body.password !== undefined) {
    const policy = await currentSettings();
    const passwordError = auth.passwordProblem(body.password, undefined, policy.min_password_length);
    if (passwordError) return res.status(400).json({ error: passwordError });
    patch.passwordHash = auth.hashPassword(body.password);
    patch.sessionsRevokedAt = Date.now();
    // A reset asks the person to choose their own password at next sign-in, unless told otherwise.
    const policyDefault = await currentSettings();
    patch.mustChangePassword = typeof body.requirePasswordChange === 'boolean' ? body.requirePasswordChange : policyDefault.new_account_change_password;
  }

  const updated = await db.updateUser(id, patch);
  // Record what changed, but never the password hash itself.
  const changes = Object.keys(patch).filter(function (k) { return k !== 'passwordHash'; }).map(function (k) { return k + ': ' + patch[k]; });
  const passwordReset = patch.passwordHash !== undefined;
  if (passwordReset) changes.push('password reset');
  await db.logAudit(req.user.displayName, passwordReset && changes.length === 1 ? 'user.password_reset' : 'user.update', target.username, changes.join(', '));
  res.json(updated);
}));

// Removes an account for good. Disabling is the gentler option: a disabled account keeps its
// record and can be turned back on. Managers may only remove Staff accounts; nobody may remove
// their own account or the last active admin.
app.delete('/api/users/:id', requireRole('manager'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid request' });
  if (id === req.user.id) return res.status(403).json({ error: 'You cannot remove your own account' });
  const target = await db.getUser(id);
  if (!target) return res.status(404).json({ error: 'Account not found' });
  if (req.user.role === 'manager' && target.role !== 'staff') {
    return res.status(403).json({ error: 'Managers can only remove Staff accounts' });
  }
  if (target.role === 'admin' && target.active && (await db.countActiveAdmins()) <= 1) {
    return res.status(409).json({ error: 'At least one active admin account must remain' });
  }
  await db.deleteUser(id);
  await db.logAudit(req.user.displayName, 'user.delete', target.username, 'name: ' + target.displayName + ', role: ' + target.role);
  res.json({ ok: true });
}));

// ---- Service availability (Manager/Admin manage it; the queue portal's Reopen button uses it too) ----
const WEEKDAY_TIME = /^\d{2}:\d{2}$/;
const NTH_WEEKS_RE = /^(1|2|3|4|last)(,(1|2|3|4|last))*$/;
const OVERRIDES = ['none', 'closed', 'open'];

app.get('/api/services/admin', requireRole('manager'), wrap(async (req, res) => {
  res.json(await db.listServicesAdmin());
}));

app.patch('/api/services/:code/override', requireRole('manager'), wrap(async (req, res) => {
  const code = req.params.code;
  if (!SERVICE_CODE.test(code)) return res.status(400).json({ error: 'Invalid service' });
  const body = req.body || {};
  let override = OVERRIDES.includes(body.override) ? body.override : null;
  if (!override) return res.status(400).json({ error: 'Invalid override' });

  let message = null;
  let expiresAt = null;
  if (override === 'closed') {
    message = String(body.message || '').trim().slice(0, 200);
    if (!message) return res.status(400).json({ error: 'Enter a reason customers will see' });
    if (body.expiresAt) {
      expiresAt = new Date(body.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) return res.status(400).json({ error: 'Invalid expiry time' });
    }
  } else if (override === 'open') {
    // "Reopen" should only override the closure happening right now, not any closure the
    // service's schedule has coming up — cap it at the end of today's active occurrence, so it
    // auto-closes again next time the schedule triggers. If nothing is actively closing it on a
    // schedule right now (just a manual closure), there's nothing to cap against, so clear the
    // override entirely instead of forcing it open indefinitely.
    const now = new Date();
    const activeSchedule = await db.findActiveSchedule(code, now);
    if (activeSchedule) {
      const [h, m] = String(activeSchedule.end_time).split(':').map(Number);
      expiresAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
    } else {
      override = 'none';
    }
  }

  const ok = await db.setManualOverride(code, override, message, expiresAt);
  if (!ok) return res.status(404).json({ error: 'Service not found' });
  await db.logAudit(req.user.displayName, 'service.override', code, override + (message ? ': ' + message : '') + (expiresAt ? ' until ' + expiresAt.toISOString() : ''));
  notify();
  res.json({ ok: true });
}));

app.get('/api/services/:code/schedules', requireRole('manager'), wrap(async (req, res) => {
  if (!SERVICE_CODE.test(req.params.code)) return res.status(400).json({ error: 'Invalid service' });
  res.json(await db.listSchedules(req.params.code));
}));

app.post('/api/services/:code/schedules', requireRole('manager'), wrap(async (req, res) => {
  const code = req.params.code;
  if (!SERVICE_CODE.test(code)) return res.status(400).json({ error: 'Invalid service' });
  const b = req.body || {};
  const message = String(b.message || '').trim().slice(0, 200);
  const recurrence = b.recurrence === 'monthly_nth' ? 'monthly_nth' : 'weekly';
  const weekday = Number(b.weekday);
  const nthWeeks = recurrence === 'monthly_nth' ? String(b.nthWeeks || '').trim() : null;
  const startTime = String(b.startTime || '');
  const endTime = String(b.endTime || '');

  if (!message) return res.status(400).json({ error: 'Enter a reason for the closure' });
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return res.status(400).json({ error: 'Choose a day of the week' });
  if (recurrence === 'monthly_nth' && !NTH_WEEKS_RE.test(nthWeeks)) {
    return res.status(400).json({ error: 'Choose which week(s) of the month (1st-4th, or last)' });
  }
  if (!WEEKDAY_TIME.test(startTime) || !WEEKDAY_TIME.test(endTime)) {
    return res.status(400).json({ error: 'Choose a start and end time' });
  }
  if (startTime >= endTime) return res.status(400).json({ error: 'End time must be after start time' });

  const schedule = await db.createSchedule(code, {
    message, recurrence, weekday, nthWeeks, startTime: startTime + ':00', endTime: endTime + ':00',
  });
  await db.logAudit(req.user.displayName, 'schedule.create', code, message + ' (' + recurrence + ', day ' + weekday + ', ' + startTime + '-' + endTime + ')');
  notify();
  res.status(201).json(schedule);
}));

app.patch('/api/services/schedules/:id', requireRole('manager'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid request' });
  const body = req.body || {};
  const patch = {};
  if (body.active !== undefined) patch.active = !!body.active;
  if (body.message !== undefined) {
    const message = String(body.message).trim().slice(0, 200);
    if (!message) return res.status(400).json({ error: 'Enter a reason for the closure' });
    patch.message = message;
  }

  // A full edit (day, time, recurrence) sends all of these together; validated the same way
  // as creating a schedule. A simple active/message toggle (Pause, Resume) sends neither.
  if (body.weekday !== undefined || body.startTime !== undefined || body.endTime !== undefined) {
    const recurrence = body.recurrence === 'monthly_nth' ? 'monthly_nth' : 'weekly';
    const weekday = Number(body.weekday);
    const nthWeeks = recurrence === 'monthly_nth' ? String(body.nthWeeks || '').trim() : null;
    const startTime = String(body.startTime || '');
    const endTime = String(body.endTime || '');

    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return res.status(400).json({ error: 'Choose a day of the week' });
    if (recurrence === 'monthly_nth' && !NTH_WEEKS_RE.test(nthWeeks)) {
      return res.status(400).json({ error: 'Choose which week(s) of the month (1st-4th, or last)' });
    }
    if (!WEEKDAY_TIME.test(startTime) || !WEEKDAY_TIME.test(endTime)) {
      return res.status(400).json({ error: 'Choose a start and end time' });
    }
    if (startTime >= endTime) return res.status(400).json({ error: 'End time must be after start time' });

    patch.recurrence = recurrence;
    patch.weekday = weekday;
    patch.nthWeeks = nthWeeks;
    patch.startTime = startTime + ':00';
    patch.endTime = endTime + ':00';
  }

  const updated = await db.updateSchedule(id, patch);
  if (!updated) return res.status(404).json({ error: 'Schedule not found' });
  await db.logAudit(req.user.displayName, 'schedule.update', updated.serviceCode, updated.message + ': ' + Object.keys(patch).join(', '));
  notify();
  res.json(updated);
}));

app.delete('/api/services/schedules/:id', requireRole('manager'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid request' });
  const ok = await db.deleteSchedule(id);
  if (!ok) return res.status(404).json({ error: 'Schedule not found' });
  await db.logAudit(req.user.displayName, 'schedule.delete', 'schedule #' + id, null);
  notify();
  res.json({ ok: true });
}));

// Staff only
app.get('/api/staff/history', requireRole('staff'), wrap(async (req, res) => {
  res.json(await db.completedToday());
}));

// Managers and admins only: every ticket from one day, for the Reports dialog on manage.html.
// Every ticket created from one calendar date through another (both YYYY-MM-DD, inclusive). A
// missing "to" means a single day. Capped at a year so one request can't pull the whole history.
const reportRange = wrap(async (req, res) => {
  const from = String(req.query.from || '');
  const to = String(req.query.to || from);
  // Real calendar dates only, in order, and within the cap (see reports.js).
  const problem = reports.rangeProblem(from, to);
  if (problem) return res.status(400).json({ error: problem });
  // Names for every service, turned off or not, so a report still reads "Zoning" for a service that has since been turned off.
  const services = (await db.listCatalogServices()).map((s) => ({ code: s.code, name: s.name }));
  res.json({ from, to, tickets: await db.ticketsForRange(from, to), services });
});
app.get('/api/reports/range', requireRole('manager'), reportRange);
// The single-day address the Reports page used before the date range. A copy of manage.html
// cached by a browser may still call it, so it keeps working as a one-day range.
app.get('/api/reports/day', requireRole('manager'), (req, res, next) => {
  req.query = { from: req.query.date, to: req.query.date };
  reportRange(req, res, next);
});

app.post('/api/staff/next', requireRole('staff'), wrap(async (req, res) => {
  const serviceId = req.body && req.body.serviceId;
  const counter = String((req.body && req.body.counter) || '').trim().slice(0, 20);
  if (typeof serviceId !== 'string' || !SERVICE_CODE.test(serviceId) || !counter) {
    return res.status(400).json({ error: 'Service and counter are required' });
  }
  const ticket = await db.callNext(serviceId, counter, req.user.displayName);
  if (!ticket) return res.status(404).json({ error: 'No one is waiting for this service' });
  notify();
  res.json(ticket);
}));

app.post('/api/staff/tickets/:id/transfer', requireRole('staff'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const serviceId = req.body && req.body.serviceId;
  if (!Number.isInteger(id) || id <= 0 || typeof serviceId !== 'string' || !SERVICE_CODE.test(serviceId)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  const ok = await db.transferTicket(id, serviceId);
  if (!ok) return res.status(409).json({ error: 'Could not transfer this customer' });
  notify();
  res.json({ ok: true });
}));

app.post('/api/staff/tickets/:id/:action', requireRole('staff'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0 || !TICKET_ACTIONS.includes(req.params.action)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  const counter = String((req.body && req.body.counter) || '').trim().slice(0, 20);
  if (req.params.action === 'call' && !counter) {
    return res.status(400).json({ error: 'Counter is required' });
  }
  const ok = await db.updateTicket(id, req.params.action, counter, req.user.displayName);
  if (!ok) return res.status(409).json({ error: 'That ticket cannot be changed right now' });
  notify();
  res.json({ ok: true });
}));


// ---- My account: any signed-in user can change their own name, User ID and password ----
app.patch('/api/account', requireRole('staff'), wrap(async (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (body.displayName !== undefined) {
    const displayName = String(body.displayName).trim().slice(0, 100);
    if (!displayName) return res.status(400).json({ error: 'Enter a display name' });
    patch.displayName = displayName;
  }
  if (body.username !== undefined) {
    const username = String(body.username).trim().toLowerCase();
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'User ID must be 3-40 letters, numbers, dots, dashes or underscores' });
    const clash = await db.findUserByUsername(username);
    if (clash && clash.id !== req.user.id) return res.status(409).json({ error: 'That User ID is already taken' });
    patch.username = username;
  }
  if (!Object.keys(patch).length) return res.json(req.user);
  const updated = await db.updateUser(req.user.id, patch);
  await db.logAudit(req.user.displayName, 'account.update', updated.username, Object.keys(patch).join(', '));
  res.json(updated);
}));

app.post('/api/account/password', requireRole('staff'), wrap(async (req, res) => {
  const body = req.body || {};
  const currentPassword = String(body.currentPassword || '');
  const newPassword = String(body.newPassword || '');
  const row = await db.findUserByUsername(req.user.username);
  if (!row || !auth.verifyPassword(currentPassword, row.password_hash)) {
    return res.status(403).json({ error: 'Your current password is not correct' });
  }
  const policy = await currentSettings();
  const passwordError = auth.passwordProblem(newPassword, currentPassword, policy.min_password_length);
  if (passwordError) return res.status(400).json({ error: passwordError });
  // Ends every session started before now, on every browser. This browser is then given a fresh session below.
  await db.updateUser(req.user.id, { passwordHash: auth.hashPassword(newPassword), mustChangePassword: false, sessionsRevokedAt: Date.now() });
  await issueSession(req, res, req.user.id, policy);
  await db.logAudit(req.user.displayName, 'account.password_change', req.user.username, null);
  res.json({ ok: true });
}));

// Saves the service queues this person watches by default, so they follow the account to any computer.
// Send { codes: [...] } to save, or { codes: null } to clear. Only active service codes are kept.
app.put('/api/account/default-queues', requireRole('staff'), wrap(async (req, res) => {
  const body = req.body || {};
  if (body.codes === null) {
    await db.updateUser(req.user.id, { defaultQueues: null });
    return res.json({ defaultQueues: null });
  }
  if (!Array.isArray(body.codes)) return res.status(400).json({ error: 'Choose the queues to save' });
  const known = new Set((await db.listServices()).map((s) => s.code));
  const codes = [...new Set(body.codes.map(String))].filter((c) => known.has(c));
  await db.updateUser(req.user.id, { defaultQueues: codes });
  res.json({ defaultQueues: codes });
}));

// ---- Admin: Settings tab (admins only) ----
app.get('/api/admin/health', requireRole('admin'), wrap(async (req, res) => {
  const snapshot = await db.healthSnapshot();
  const settings = retentionSettings(await db.getSettings());
  res.json({
    app: { uptimeSeconds: Math.round(process.uptime()), nodeVersion: process.version, time: new Date().toISOString() },
    database: {
      latencyMs: snapshot.dbLatencyMs,
      time: snapshot.dbTime,
      // A large gap here means the database and the app disagree about the time zone.
      clockDifferenceSeconds: Math.round((new Date(snapshot.dbTime) - Date.now()) / 1000),
      waitingToday: snapshot.waiting,
      servingToday: snapshot.serving,
      activeAdmins: snapshot.activeAdmins,
    },
    oldRecords: settings,
  });
}));

app.get('/api/admin/database', requireRole('admin'), wrap(async (req, res) => {
  res.json({ checks: await db.databaseCheck() });
}));

app.get('/api/admin/settings', requireRole('admin'), wrap(async (req, res) => {
  res.json(retentionSettings(await db.getSettings()));
}));

app.put('/api/admin/settings', requireRole('admin'), wrap(async (req, res) => {
  const body = req.body || {};
  const days = Number(body.retentionDays);
  const action = body.retentionAction;
  if (!Number.isInteger(days) || days < 0 || days > 3650) return res.status(400).json({ error: 'Enter a number of days from 0 (keep everything) to 3650' });
  if (!RETENTION_ACTIONS.includes(action)) return res.status(400).json({ error: 'Choose what to do with old records' });
  const before = retentionSettings(await db.getSettings());
  await db.setSetting('retention_days', days);
  await db.setSetting('retention_action', action);
  await db.logAudit(req.user.displayName, 'settings.update', 'Old records',
    'days: ' + before.retentionDays + ' → ' + days + ', action: ' + before.retentionAction + ' → ' + action);
  res.json(retentionSettings(await db.getSettings()));
}));

// ---- App settings (kiosk, monitor, security, branding) ----

// Public: what the kiosk, monitors and sign-in pages need. No sign-in required.
app.get('/api/public-settings', wrap(async (req, res) => {
  // Always read fresh: a cached copy would show an old password length or kiosk timer.
  res.setHeader('Cache-Control', 'no-store');
  const stored = await db.getSettings();
  const pub = appSettings.publicSettings(appSettings.parseSettings(stored));
  pub.logoUrl = stored.logo_data_url ? 'api/branding/logo?v=' + (stored.logo_updated_at || '0') : null;
  res.json(pub);
}));

// Public: the logo image. Only PNG, JPEG and WebP are accepted on upload, so this never serves an SVG.
app.get('/api/branding/logo', wrap(async (req, res) => {
  const stored = await db.getSettings();
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(stored.logo_data_url || '');
  if (!m) return res.status(404).end();
  res.setHeader('Content-Type', m[1]);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(Buffer.from(m[2], 'base64'));
}));

app.get('/api/admin/app-settings', requireRole('admin'), wrap(async (req, res) => {
  const values = appSettings.parseSettings(await db.getSettings());
  const services = (await db.listServices()).map((s) => ({ code: s.code, name: s.name }));
  const stored = await db.getSettings();
  const definitions = {};
  Object.keys(appSettings.DEFINITIONS).forEach((key) => {
    const d = appSettings.DEFINITIONS[key];
    definitions[key] = { label: d.label, type: d.type, min: d.min, max: d.max, options: d.options };
  });
  res.json({
    values, definitions, services,
    departments: await departmentList(),
    logoUrl: stored.logo_data_url ? 'api/branding/logo?v=' + (stored.logo_updated_at || '0') : null,
  });
}));

app.put('/api/admin/app-settings', requireRole('admin'), wrap(async (req, res) => {
  const services = await db.listServices();
  const groups = (await db.listGroups('en')).map((g) => ({ id: g.id, codes: g.codes }));
  const result = appSettings.validateSettings(req.body, services.map((s) => s.code), groups);
  if (result.error) return res.status(400).json({ error: result.error });
  const stored = await db.getSettings();
  const before = appSettings.parseSettings(stored);
  const changed = [];
  for (const key of Object.keys(result.changes)) {
    const value = result.changes[key];
    if (JSON.stringify(value) === JSON.stringify(before[key])) continue;
    await db.setSetting(key, appSettings.toStored(key, value));
    const show = (v) => (Array.isArray(v) ? v.join(', ') : String(v));
    changed.push(appSettings.DEFINITIONS[key].label + ': ' + show(before[key]) + ' → ' + show(value));
  }
  if (changed.length) {
    await db.logAudit(req.user.displayName, 'settings.update', 'App settings', changed.join('; '));
  }
  res.json({ values: appSettings.parseSettings(await db.getSettings()) });
}));

app.put('/api/admin/logo', requireRole('admin'), wrap(async (req, res) => {
  const dataUrl = String((req.body && req.body.dataUrl) || '');
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(dataUrl) || dataUrl.length > 420000) {
    return res.status(400).json({ error: 'Choose a PNG, JPEG or WebP image under 300 KB' });
  }
  // Check the file starts with the signature of an image type it is allowed to be.
  const head = Buffer.from(dataUrl.split(',')[1].slice(0, 16), 'base64');
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const isWebp = head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP';
  if (!isPng && !isJpeg && !isWebp) return res.status(400).json({ error: 'That file is not a PNG, JPEG or WebP image' });
  await db.setSetting('logo_data_url', dataUrl);
  // Read it back: a copy the database cut short would show as a broken image, so refuse to keep it.
  if ((await db.getSettings()).logo_data_url !== dataUrl) {
    await db.setSetting('logo_data_url', '');
    return res.status(500).json({ error: 'The logo could not be saved in full. Ask for help before trying again.' });
  }
  await db.setSetting('logo_updated_at', String(Date.now()));
  await db.logAudit(req.user.displayName, 'settings.update', 'Logo', 'logo uploaded');
  res.json({ ok: true });
}));

app.delete('/api/admin/logo', requireRole('admin'), wrap(async (req, res) => {
  await db.setSetting('logo_data_url', '');
  await db.setSetting('logo_updated_at', String(Date.now()));
  await db.logAudit(req.user.displayName, 'settings.update', 'Logo', 'logo removed');
  res.json({ ok: true });
}));

app.post('/api/admin/cleanup', requireRole('admin'), wrap(async (req, res) => {
  const { retentionDays } = retentionSettings(await db.getSettings());
  if (!retentionDays) return res.status(400).json({ error: 'Set a number of days first. 0 means keep everything.' });
  const changed = await runRetention(req.user.displayName);
  res.json({ changed });
}));

// Runs the automated test files (the same ones `npm test` runs) and returns their output. The list
// is fixed in the code, so nothing from the request reaches the command.
const TEST_FILES = ['tests/auth.test.js', 'tests/availability.test.js', 'tests/reports.test.js', 'tests/schema.test.js', 'tests/settings.test.js', 'tests/http.test.js', 'tests/catalog.test.js', 'tests/privacy.test.js'];
app.post('/api/admin/tests', requireRole('admin'), wrap(async (req, res) => {
  await db.logAudit(req.user.displayName, 'tests.run', 'Automated tests', null);
  execFile(process.execPath, ['--test', ...TEST_FILES], { cwd: __dirname, timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout, stderr) => {
      const output = String(stdout || '') + String(stderr || '');
      res.json({ passed: !err, output: output.slice(-30000) });
    });
}));

app.get('/api/admin/audit', requireRole('admin'), wrap(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  res.json(await db.listAudit(limit, String(req.query.q || '').slice(0, 100)));
}));

const RETENTION_ACTIONS = ['anonymize', 'delete'];
function retentionSettings(s) {
  return {
    retentionDays: Number(s.retention_days || 0),
    retentionAction: RETENTION_ACTIONS.includes(s.retention_action) ? s.retention_action : 'anonymize',
    lastCleanupAt: s.last_cleanup_at || null,
  };
}

// Applies the old-record rule. Scheduled runs (no actor) are only logged when something changed;
// a manual run from the Settings tab is always logged.
async function runRetention(actorName) {
  const s = retentionSettings(await db.getSettings());
  if (!s.retentionDays) return 0;
  const changed = await db.cleanupOldTickets(s.retentionDays, s.retentionAction);
  await db.setSetting('last_cleanup_at', new Date().toISOString());
  if (actorName || changed) {
    const verb = s.retentionAction === 'delete' ? 'deleted' : 'anonymized';
    await db.logAudit(actorName || 'System', 'cleanup.run', 'Old records',
      changed + ' ticket(s) ' + verb + ' (finished more than ' + s.retentionDays + ' days ago)');
  }
  return changed;
}

// Removes audit entries older than the retention period set in Settings (0 keeps everything).
async function trimAuditLog() {
  const s = await currentSettings();
  if (s.audit_retention_days >= appSettings.MIN_AUDIT_DAYS) await db.cleanupAudit(s.audit_retention_days);
}

// Closes every open ticket once the end-of-day time has passed, once per day. Checked each minute, so a
// restart after the time still catches up the same day. The day is recorded only after the close succeeds.
function localDateKey(d) {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

async function checkAutoClose() {
  const stored = await db.getSettings();
  const s = appSettings.parseSettings(stored);
  if (!s.auto_close_time) return;
  const now = new Date();
  const [h, m] = s.auto_close_time.split(':').map(Number);
  if (now < new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0)) return;
  const today = localDateKey(now);
  if (stored.auto_close_last_date === today) return;
  const closed = await db.closeOpenTickets();
  await db.setSetting('auto_close_last_date', today);
  if (closed) {
    await db.logAudit('System', 'tickets.auto_close', 'End of day', closed + ' open ticket(s) closed at ' + s.auto_close_time);
    notify();
  }
}

function scheduleAutoClose() {
  const run = function () {
    checkAutoClose().catch(function (err) { console.error('End-of-day close failed:', err.message); });
  };
  run();
  setInterval(run, 60 * 1000);
}

// Runs the old-record rule at startup and then once a day.
function scheduleRetention() {
  const run = function () {
    runRetention(null).catch(function (err) { console.error('Old-record cleanup failed:', err.message); });
    trimAuditLog().catch(function (err) { console.error('Audit log cleanup failed:', err.message); });
  };
  run();
  setInterval(run, 24 * 60 * 60 * 1000);
}

// Creates the first admin account from the environment, only if no admin exists yet.
// Safe to leave these variables set after the first run; they are ignored once an admin exists.
async function bootstrapAdmin() {
  const username = (process.env.ADMIN_USERNAME || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!username || !password) return;
  if ((await db.countActiveAdmins()) > 0) return;
  const existing = await db.findUserByUsername(username);
  if (existing) {
    await db.updateUser(existing.id, { role: 'admin', active: true, passwordHash: auth.hashPassword(password) });
    console.log(`Promoted existing user "${username}" to admin.`);
  } else {
    await db.createUser(username, 'Administrator', auth.hashPassword(password), 'admin');
    console.log(`Created admin account "${username}". Remove ADMIN_USERNAME / ADMIN_PASSWORD once you have signed in.`);
  }
}

// Registered after every route, so it catches errors from all of them.
app.use((err, req, res, next) => {
  // Body too large (for example a logo that is too big to upload): say so, rather than a generic error.
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large. Choose a smaller image.' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

function start() {
  return db.init()
    .then(bootstrapAdmin)
    .then(scheduleRetention)
    .then(scheduleAutoClose)
    .then(() => new Promise((resolve) => {
      server.listen(PORT, () => {
        console.log(`Virtual queue listening on port ${PORT}`);
        resolve();
      });
    }));
}

// Hosts such as cPanel load this file with require() rather than running it directly, so start unless the
// automated tests are loading it (the test runner sets NODE_TEST_CONTEXT).
if (!process.env.NODE_TEST_CONTEXT) {
  start().catch((err) => {
    console.error('Database initialization failed:', err.code || err.message || err);
    process.exit(1);
  });
}

module.exports = { app, server, start, checkAutoClose };

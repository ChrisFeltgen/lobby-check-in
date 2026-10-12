'use strict';

// Access links for the kiosk and the monitor. When Security asks for a staff sign-in or an access link, a screen opens
// for someone signed in, or for a browser that holds the key of a link an admin made for it.
//
// A link is an address with a secret key on the end. The first time a screen is opened with it, the screen hands the key
// to the server, which gives that browser a cookie holding the key and the address is cleaned. From then on the cookie
// opens the screen, so nobody has to sign in, and the key is not left in the browser's history. The key is also
// accepted again if the cookie is lost, so a screen whose browser forgets everything each time can have the link as its
// start page. The server keeps only a hash of each key (shown once, when the link is made), so a copy of the database
// does not open any screen. A link can be revoked at any time, and the screens using it lock at once.
//
// Pure functions only, with no database or request in them, so the rules can be tested on their own.

const crypto = require('crypto');

const COOKIE = 'vq_screen';
const SCOPES = ['kiosk', 'monitor'];
const PANELS = ['full', 'left', 'right'];
// A key is 32 random bytes written as base64url: 43 characters, 256 bits, which cannot be guessed.
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
// The longest a browser keeps a cookie. The server renews it while the screen is in use, so a screen that is running never runs out.
const COOKIE_MAX_AGE_MS = 400 * 24 * 3600 * 1000;

function newKey() {
  return crypto.randomBytes(32).toString('base64url');
}

// What the server stores and looks up. The keys are random and long, so a fast hash is enough.
function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function isKey(value) {
  return typeof value === 'string' && KEY_RE.test(value);
}

// Whether a link of one kind opens what a request needs. A kiosk link opens the kiosk and the data behind it, a monitor
// link the monitor's, and 'either' is for data both use (the department list, for one).
function scopeAllows(scope, need) {
  if (!SCOPES.includes(scope)) return false;
  return need === 'either' ? true : scope === need;
}

// A name an admin gives a link, so the list says which screen is which, for example "Lobby kiosk".
function validateName(raw) {
  const name = String(raw === null || raw === undefined ? '' : raw).trim().slice(0, 100);
  if (!name) return { error: 'Enter a name for the screen, for example "Lobby kiosk".' };
  return { value: name };
}

function validateScope(raw) {
  return SCOPES.includes(raw) ? { value: raw } : { error: 'Choose Kiosk or Monitor.' };
}

// Which departments a monitor link shows: every department ('full'), or the ones chosen for the left or right screen in
// Settings. It only decides the address the link opens (monitor.html?panel=left), so it is not part of what the key
// allows. Left out, it is 'full'. A kiosk has no sides, so its link is always 'full'.
function validatePanel(raw, scope) {
  if (scope !== 'monitor') return { value: 'full' };
  if (raw === undefined || raw === null || raw === '') return { value: 'full' };
  return PANELS.includes(raw) ? { value: raw } : { error: 'Choose Full, Left or Right for the monitor.' };
}

// The Set-Cookie value that keeps a browser unlocked. HttpOnly, so a script on the page cannot read the key.
function cookie(key, opts) {
  const o = opts || {};
  const parts = [COOKIE + '=' + encodeURIComponent(key), 'Path=' + (o.path || '/'), 'Max-Age=' + Math.floor(COOKIE_MAX_AGE_MS / 1000), 'HttpOnly', 'SameSite=Lax'];
  if (o.secure) parts.push('Secure');
  return parts.join('; ');
}

// Takes the cookie away from a browser whose link has been revoked, so it stops sending a key that no longer works.
function clearCookie(opts) {
  const o = opts || {};
  const parts = [COOKIE + '=', 'Path=' + (o.path || '/'), 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (o.secure) parts.push('Secure');
  return parts.join('; ');
}

module.exports = { COOKIE, SCOPES, PANELS, COOKIE_MAX_AGE_MS, newKey, hashKey, isKey, scopeAllows, validateName, validateScope, validatePanel, cookie, clearCookie };

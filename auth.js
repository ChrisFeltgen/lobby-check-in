'use strict';

// Password hashing and session cookies, using only Node's built-in crypto module.
// No extra npm packages, so there is nothing new to install on the host.

const crypto = require('crypto');

const ROLE_RANK = { staff: 1, manager: 2, admin: 3 };
const SESSION_COOKIE = 'vq_session';
const SESSION_MS = 12 * 60 * 60 * 1000; // 12 hours

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBuffer(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function roleAtLeast(role, min) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[min] || 99);
}

// ---- Passwords ----
// Stored as "scrypt:<salt-hex>:<hash-hex>". Each password gets its own random salt.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return 'scrypt:' + salt.toString('hex') + ':' + hash.toString('hex');
}

// The password rules, shared by every route that sets a password. Returns an error message, or null
// when the new password is acceptable. Pass the current password to also reject re-using it.
const MIN_PASSWORD_LENGTH = 8;
function passwordProblem(newPassword, currentPassword, minLength) {
  const min = minLength || MIN_PASSWORD_LENGTH;
  if (String(newPassword).length < min) return 'The new password must be at least ' + min + ' characters';
  if (currentPassword !== undefined && newPassword === currentPassword) return 'Choose a password different from the current one';
  return null;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(String(password), salt, 64);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---- Sessions ----
// A signed, stateless token: base64url(payload).base64url(HMAC-SHA256 signature).
// Nothing is stored server-side, so sessions survive a restart as long as SESSION_SECRET is unchanged.
function signSession(secret, payload) {
  const body = base64url(Buffer.from(JSON.stringify(payload)));
  const sig = base64url(crypto.createHmac('sha256', secret).update(body).digest());
  return body + '.' + sig;
}

function verifySession(secret, token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = base64url(crypto.createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(base64urlToBuffer(body).toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

// ---- Cookies ----
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  });
  return out;
}

function sessionCookie(token, opts) {
  opts = opts || {};
  const parts = [SESSION_COOKIE + '=' + encodeURIComponent(token)];
  parts.push('Path=' + (opts.path || '/'));
  parts.push('Max-Age=' + Math.floor((opts.maxAgeMs || SESSION_MS) / 1000));
  parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie(opts) {
  opts = opts || {};
  return [
    SESSION_COOKIE + '=',
    'Path=' + (opts.path || '/'),
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ].concat(opts.secure ? ['Secure'] : []).join('; ');
}

module.exports = {
  ROLE_RANK,
  SESSION_COOKIE,
  SESSION_MS,
  roleAtLeast,
  hashPassword,
  verifyPassword,
  passwordProblem,
  MIN_PASSWORD_LENGTH,
  signSession,
  verifySession,
  parseCookies,
  sessionCookie,
  clearCookie,
};

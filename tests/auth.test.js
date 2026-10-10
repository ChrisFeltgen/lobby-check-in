'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../auth');

test('a password verifies against its own hash and nothing else', () => {
  const stored = auth.hashPassword('correct-horse');
  assert.equal(auth.verifyPassword('correct-horse', stored), true);
  assert.equal(auth.verifyPassword('wrong-horse', stored), false);
  assert.equal(auth.verifyPassword('correct-horse', 'not-a-hash'), false);
  assert.equal(auth.verifyPassword('correct-horse', null), false);
});

test('each hash gets its own salt', () => {
  assert.notEqual(auth.hashPassword('same-password'), auth.hashPassword('same-password'));
});

test('password rules: minimum length and not reusing the current password', () => {
  assert.equal(auth.passwordProblem('short'), 'The new password must be at least 8 characters');
  assert.equal(auth.passwordProblem('long-enough'), null);
  assert.equal(auth.passwordProblem('same-as-now', 'same-as-now'), 'Choose a password different from the current one');
  assert.equal(auth.passwordProblem('brand-new', 'old-password'), null);
});

test('a session token round-trips with the same secret', () => {
  const token = auth.signSession('secret-one', { uid: 7, exp: Date.now() + 60000 });
  assert.equal(auth.verifySession('secret-one', token).uid, 7);
});

test('a session is rejected with a different secret, tampering, or expiry', () => {
  const token = auth.signSession('secret-one', { uid: 7, exp: Date.now() + 60000 });
  assert.equal(auth.verifySession('secret-two', token), null);

  // Change the payload but keep the old signature.
  const sig = token.split('.')[1];
  const forged = Buffer.from(JSON.stringify({ uid: 1, exp: Date.now() + 60000 })).toString('base64url');
  assert.equal(auth.verifySession('secret-one', forged + '.' + sig), null);

  const expired = auth.signSession('secret-one', { uid: 7, exp: Date.now() - 1000 });
  assert.equal(auth.verifySession('secret-one', expired), null);

  assert.equal(auth.verifySession('secret-one', undefined), null);
  assert.equal(auth.verifySession('secret-one', 'no-dot-here'), null);
});

test('roles are ranked staff, manager, admin', () => {
  assert.equal(auth.roleAtLeast('admin', 'manager'), true);
  assert.equal(auth.roleAtLeast('manager', 'manager'), true);
  assert.equal(auth.roleAtLeast('staff', 'manager'), false);
  assert.equal(auth.roleAtLeast('unknown', 'staff'), false);
});

test('the session cookie is HttpOnly, and Secure only over HTTPS', () => {
  const plain = auth.sessionCookie('abc', { path: '/' });
  assert.match(plain, /HttpOnly/);
  assert.doesNotMatch(plain, /Secure/);
  assert.match(auth.sessionCookie('abc', { path: '/', secure: true }), /Secure/);
});

test('cookie headers are parsed into name and value pairs', () => {
  const cookies = auth.parseCookies('a=1; vq_session=abc%20def; empty=');
  assert.equal(cookies.a, '1');
  assert.equal(cookies.vq_session, 'abc def');
  assert.equal(cookies.empty, '');
  assert.deepEqual(auth.parseCookies(undefined), {});
});

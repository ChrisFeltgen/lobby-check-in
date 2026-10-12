'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const screens = require('../lib/screens');

test('a key is 43 characters of random base64url, and no two are alike', () => {
  const a = screens.newKey();
  const b = screens.newKey();
  assert.notEqual(a, b);
  assert.equal(a.length, 43);
  assert.equal(screens.isKey(a), true);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test('only something shaped like a key is looked up at all', () => {
  assert.equal(screens.isKey(screens.newKey()), true);
  for (const bad of ['', 'short', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + '!', 'a'.repeat(42) + ' ', null, undefined, 12345, {}, ['a'.repeat(43)]]) {
    assert.equal(screens.isKey(bad), false, JSON.stringify(bad));
  }
});

test('the server keeps a hash of a key, which is the same for the same key and does not reveal it', () => {
  const key = screens.newKey();
  assert.equal(screens.hashKey(key), screens.hashKey(key));
  assert.notEqual(screens.hashKey(key), screens.hashKey(screens.newKey()));
  assert.match(screens.hashKey(key), /^[0-9a-f]{64}$/);
  assert.ok(!screens.hashKey(key).includes(key.slice(0, 10)));
});

test('a kiosk link opens the kiosk, a monitor link the monitor, and either opens what both use', () => {
  assert.equal(screens.scopeAllows('kiosk', 'kiosk'), true);
  assert.equal(screens.scopeAllows('kiosk', 'monitor'), false);
  assert.equal(screens.scopeAllows('monitor', 'monitor'), true);
  assert.equal(screens.scopeAllows('monitor', 'kiosk'), false);
  assert.equal(screens.scopeAllows('kiosk', 'either'), true);
  assert.equal(screens.scopeAllows('monitor', 'either'), true);
  // Anything that is not a kind of link opens nothing.
  assert.equal(screens.scopeAllows('admin', 'either'), false);
  assert.equal(screens.scopeAllows(undefined, 'kiosk'), false);
});

test('a link needs a name and one of the two kinds of screen', () => {
  assert.equal(screens.validateName('  Lobby kiosk  ').value, 'Lobby kiosk');
  assert.match(screens.validateName('   ').error, /Enter a name/);
  assert.match(screens.validateName(undefined).error, /Enter a name/);
  assert.equal(screens.validateName('x'.repeat(300)).value.length, 100);
  assert.equal(screens.validateScope('kiosk').value, 'kiosk');
  assert.equal(screens.validateScope('monitor').value, 'monitor');
  assert.match(screens.validateScope('admin').error, /Kiosk or Monitor/);
  assert.match(screens.validateScope(undefined).error, /Kiosk or Monitor/);
});

test('a monitor link is for the full screen, the left or the right; a kiosk has no sides', () => {
  assert.deepEqual(screens.PANELS, ['full', 'left', 'right']);
  for (const side of screens.PANELS) assert.equal(screens.validatePanel(side, 'monitor').value, side);
  // Left out, it is the full screen.
  for (const blank of [undefined, null, '']) assert.equal(screens.validatePanel(blank, 'monitor').value, 'full');
  // Anything else is a mistake worth saying so, not a silent full screen.
  for (const bad of ['middle', 'Left', 'LEFT', ' left', 0, true, {}, ['left']]) {
    assert.match(screens.validatePanel(bad, 'monitor').error, /Full, Left or Right/, JSON.stringify(bad));
  }
  // A kiosk is always the full screen, whatever it is sent.
  for (const any of ['left', 'right', 'middle', undefined]) assert.equal(screens.validatePanel(any, 'kiosk').value, 'full');
});

test('the cookie that keeps a screen open cannot be read by a script, lasts long, and is Secure over HTTPS', () => {
  const key = screens.newKey();
  const plain = screens.cookie(key, { path: '/virtual-queue' });
  assert.ok(plain.startsWith('vq_screen=' + key));
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Lax/);
  assert.match(plain, /Path=\/virtual-queue/);
  assert.doesNotMatch(plain, /Secure/);
  assert.match(plain, /Max-Age=34560000/);
  assert.match(screens.cookie(key, { secure: true }), /Secure/);
  const gone = screens.clearCookie({ path: '/virtual-queue', secure: true });
  assert.match(gone, /^vq_screen=;/);
  assert.match(gone, /Max-Age=0/);
});

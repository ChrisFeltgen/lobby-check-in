const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../settings');

test('missing or unusable stored values fall back to the defaults', () => {
  const values = s.parseSettings({ kiosk_idle_seconds: 'lots', monitor_chime: 'maybe', monitor_left: 'not json' });
  assert.equal(values.kiosk_idle_seconds, 60);
  assert.equal(values.monitor_chime, true);
  assert.deepEqual(values.monitor_left, ['planning', 'CE', 'BTD']);
  assert.equal(values.session_hours, 12);
});

test('stored values are read back with their types', () => {
  const values = s.parseSettings({ monitor_chime: '0', kiosk_done_seconds: '20', org_name: 'City Hall', monitor_right: '["records","AC"]' });
  assert.equal(values.monitor_chime, false);
  assert.equal(values.kiosk_done_seconds, 20);
  assert.equal(values.org_name, 'City Hall');
  assert.deepEqual(values.monitor_right, ['records', 'AC']);
});

test('numbers outside their limits are rejected with a clear message', () => {
  assert.match(s.validateSettings({ kiosk_idle_seconds: 5 }, []).error, /from 15 to 300/);
  assert.match(s.validateSettings({ session_hours: 0 }, []).error, /from 1 to 24/);
  assert.match(s.validateSettings({ min_password_length: 2.5 }, []).error, /whole number/);
});

test('a valid change is returned typed', () => {
  const result = s.validateSettings({ kiosk_idle_seconds: '90', monitor_chime: false, monitor_scroll: 'fast' }, []);
  assert.deepEqual(result.changes, { kiosk_idle_seconds: 90, monitor_chime: false, monitor_scroll: 'fast' });
});

test('an unknown setting name is refused', () => {
  assert.match(s.validateSettings({ made_up: 1 }, []).error, /Unknown setting: made_up/);
});

test('a monitor panel may list department groups and active service codes only', () => {
  assert.deepEqual(s.validateSettings({ monitor_left: ['records', 'UF'] }, ['UF']).changes, { monitor_left: ['records', 'UF'] });
  assert.match(s.validateSettings({ monitor_left: ['planning', 'NOPE'] }, ['UF']).error, /Unknown department: NOPE/);
  assert.match(s.validateSettings({ monitor_left: [] }, ['UF']).error, /at least one department/);
});

test('a department and one of its own services cannot both be chosen', () => {
  assert.match(s.validateSettings({ monitor_left: ['building', 'BPI'] }, ['BPI']).error, /Building Dept. or its service BPI, not both/);
  assert.deepEqual(s.validateSettings({ monitor_left: ['building', 'AC'] }, ['BPI', 'AC']).changes, { monitor_left: ['building', 'AC'] });
});

test('the audit log cannot be kept for less than 30 days, but 0 keeps everything', () => {
  assert.match(s.validateSettings({ audit_retention_days: 7 }, []).error, /at least 30 days/);
  assert.deepEqual(s.validateSettings({ audit_retention_days: 0 }, []).changes, { audit_retention_days: 0 });
  assert.deepEqual(s.validateSettings({ audit_retention_days: 365 }, []).changes, { audit_retention_days: 365 });
});

test('the public view leaves out admin-only settings', () => {
  const pub = s.publicSettings(s.parseSettings({}));
  assert.equal(pub.kiosk_idle_seconds, 60);
  assert.equal('session_hours' in pub, false);
  assert.equal('lockout_attempts' in pub, false);
  assert.equal('audit_retention_days' in pub, false);
});

test('booleans and lists are stored as text the parser understands', () => {
  assert.equal(s.fromStored('monitor_chime', s.toStored('monitor_chime', false)), false);
  assert.deepEqual(s.fromStored('monitor_left', s.toStored('monitor_left', ['CE'])), ['CE']);
});

test('kiosk and monitor colours are light or dark, and are public', () => {
  const values = s.parseSettings({});
  assert.equal(values.kiosk_theme, 'light');
  assert.equal(values.monitor_theme, 'dark');
  assert.deepEqual(s.validateSettings({ kiosk_theme: 'dark', monitor_theme: 'light' }, []).changes, { kiosk_theme: 'dark', monitor_theme: 'light' });
  assert.match(s.validateSettings({ kiosk_theme: 'blue' }, []).error, /one of: light, dark/);
  const pub = s.publicSettings(values);
  assert.equal(pub.kiosk_theme, 'light');
  assert.equal(pub.monitor_theme, 'dark');
});

test('the check-in limit is a whole number from 0 (no limit) to 600 per minute, and is not public', () => {
  assert.equal(s.parseSettings({}).checkin_rate_per_minute, 20);
  assert.deepEqual(s.validateSettings({ checkin_rate_per_minute: 0 }, []).changes, { checkin_rate_per_minute: 0 });
  assert.match(s.validateSettings({ checkin_rate_per_minute: 601 }, []).error, /from 0 to 600/);
  assert.equal('checkin_rate_per_minute' in s.publicSettings(s.parseSettings({})), false);
});

test('the end-of-day time is blank (off) or a 24-hour time', () => {
  assert.equal(s.parseSettings({}).auto_close_time, '');
  assert.deepEqual(s.validateSettings({ auto_close_time: '17:30' }, []).changes, { auto_close_time: '17:30' });
  assert.deepEqual(s.validateSettings({ auto_close_time: '' }, []).changes, { auto_close_time: '' });
  assert.match(s.validateSettings({ auto_close_time: '5pm' }, []).error, /such as 17:30/);
  assert.match(s.validateSettings({ auto_close_time: '25:00' }, []).error, /such as 17:30/);
  assert.equal(s.fromStored('auto_close_time', '09:05'), '09:05');
  assert.equal(s.fromStored('auto_close_time', 'soon'), undefined);
});

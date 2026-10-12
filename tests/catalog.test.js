const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const c = require('../catalog');
const { UI_STRINGS } = require('../ui-strings');
const seed = require('../catalog-seed');
const settings = require('../settings');

const ROOT = path.join(__dirname, '..');

test('service codes are 2 to 10 letters or numbers', () => {
  assert.equal(c.CODE_RE.test('BPI'), true);
  assert.equal(c.CODE_RE.test('X1'), true);
  assert.equal(c.CODE_RE.test('b'), false);
  assert.equal(c.CODE_RE.test('TOO-LONG-CODE'), false);
  assert.match(c.validateService({ code: 'b', name: 'X' }, [], true).error, /2 to 10 letters or numbers/);
});

test('a new service needs a code and a name; the code is upper-cased', () => {
  assert.match(c.validateService({ name: 'Permits' }, [], true).error, /2 to 10/);
  assert.match(c.validateService({ code: 'PRM' }, [], true).error, /service name/);
  const ok = c.validateService({ code: 'prm', name: 'Permits' }, [], true);
  assert.equal(ok.values.code, 'PRM');
});

test('a service may only use a listed icon and an existing group', () => {
  assert.match(c.validateService({ icon: 'dragon' }, ['building'], false).error, /listed icons/);
  assert.match(c.validateService({ groupId: 'nowhere' }, ['building'], false).error, /group that exists/);
  assert.deepEqual(c.validateService({ icon: 'bell', groupId: 'building' }, ['building'], false).values, { icon: 'bell', groupId: 'building' });
  assert.deepEqual(c.validateService({ icon: '', groupId: '' }, ['building'], false).values, { icon: null, groupId: null });
});

test('a service colour is a hex value, and sort order is 0 to 999', () => {
  assert.match(c.validateService({ color: 'blue' }, [], false).error, /hex value/);
  assert.equal(c.validateService({ color: '#2f6fd6' }, [], false).values.color, '#2f6fd6');
  assert.match(c.validateService({ sortOrder: 1000 }, [], false).error, /0 to 999/);
});

test('a group needs a valid id that is not already used, a name, and a valid colour', () => {
  assert.match(c.validateGroup({ id: 'Bad Id', label: 'X' }, [], true).error, /lower case/);
  assert.match(c.validateGroup({ id: 'permits', label: 'X' }, ['permits'], true).error, /already exists/);
  assert.match(c.validateGroup({ id: 'permits' }, [], true).error, /group name/);
  assert.match(c.validateGroup({ label: 'X', color: 'red' }, [], false).error, /hex value/);
  assert.deepEqual(c.validateGroup({ id: 'permits', label: 'Permits', icon: 'building' }, [], true).values, { id: 'permits', label: 'Permits', icon: 'building' });
});

test('a language code is short, lower case, and new', () => {
  assert.equal(c.validateLanguage({ code: 'PT-BR', name: 'Português' }, [], true).values.code, 'pt-br');
  assert.match(c.validateLanguage({ code: 'english', name: 'English' }, [], true).error, /look like/);
  assert.match(c.validateLanguage({ code: 'es', name: 'Español' }, ['es'], true).error, /already set up/);
  assert.match(c.validateLanguage({ enabled: 'yes' }, [], false).error, /yes or no/);
});

test('translations: unknown items are refused; an empty text means "use English again"', () => {
  const known = ['service.BPI.name', 'ui.btn_join'];
  assert.match(c.validateTranslations({ 'service.XX.name': 'x' }, known).error, /Unknown item/);
  assert.match(c.validateTranslations({ 'ui.btn_join': 'x'.repeat(501) }, known).error, /under 500/);
  assert.deepEqual(c.validateTranslations({ 'ui.btn_join': '  Unirse  ', 'service.BPI.name': '' }, known).changes, {
    'ui.btn_join': 'Unirse',
    'service.BPI.name': '',
  });
});

test('the icon names the server accepts are exactly the drawings in public/icons.js', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public', 'icons.js'), 'utf8'), sandbox);
  const drawn = [...sandbox.window.ICON_NAMES].sort();
  assert.deepEqual([...c.ICON_NAMES].sort(), drawn);
  for (const name of c.ICON_NAMES) assert.equal(typeof sandbox.window.ICON_PATHS[name], 'string');
});

test('the English and Spanish kiosk wording have the same keys, none of them empty', () => {
  const en = Object.keys(UI_STRINGS.en).sort();
  assert.deepEqual(Object.keys(UI_STRINGS.es).sort(), en);
  for (const key of en) {
    assert.ok(UI_STRINGS.en[key], 'English text for ' + key);
    assert.ok(UI_STRINGS.es[key], 'Spanish text for ' + key);
  }
});

test('the default groups and services are consistent with each other and with the schema', () => {
  const groupIds = seed.GROUPS.map((g) => g.id);
  for (const [code, s] of Object.entries(seed.SERVICES)) {
    assert.ok(c.CODE_RE.test(code), code);
    if (s.group) assert.ok(groupIds.includes(s.group), 'group for ' + code);
    assert.ok(c.ICON_NAMES.includes(s.icon), 'icon for ' + code);
  }
  const schema = fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8');
  const schemaCodes = [...schema.matchAll(/^\s+\('([A-Z0-9]+)', '/gm)].map((m) => m[1]);
  assert.ok(schemaCodes.length >= 10);
  for (const code of schemaCodes) assert.ok(seed.SERVICES[code], 'seed entry for schema service ' + code);
});

test('a monitor panel can use any group or service that exists, including new ones', () => {
  const groups = [{ id: 'permits', codes: ['PRM'] }];
  assert.deepEqual(settings.validateSettings({ monitor_left: ['permits', 'NEW'] }, ['PRM', 'NEW'], groups).changes, { monitor_left: ['permits', 'NEW'] });
  assert.match(settings.validateSettings({ monitor_left: ['permits', 'PRM'] }, ['PRM'], groups).error, /not both/);
});

test('the order of a service or group is a whole number from 0 to 999, and cannot be blank', () => {
  assert.equal(c.validateGroup({ sortOrder: 4 }, [], false).values.sortOrder, 4);
  assert.equal(c.validateService({ sortOrder: '12' }, [], false).values.sortOrder, 12);
  for (const bad of ['', null, 1.5, -1, 1000, 'abc']) {
    assert.match(c.validateGroup({ sortOrder: bad }, [], false).error, /0 to 999/, String(bad));
    assert.match(c.validateService({ sortOrder: bad }, [], false).error, /0 to 999/, String(bad));
  }
});

test('only the default-service statements in schema.sql are skipped once the catalogue has been set up', () => {
  const { isDefaultServiceStatement, splitStatements } = require('../db');
  const sql = fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8');
  const skipped = splitStatements(sql).filter(isDefaultServiceStatement);
  // The default services, and the retired codes: a restart must not bring either back.
  assert.equal(skipped.length, 2);
  assert.ok(skipped.some((s) => /INSERT IGNORE INTO services/.test(s)));
  assert.ok(skipped.some((s) => /UPDATE services SET active = 0/.test(s)));
  // Other seed data, such as the settings defaults, still runs on every start.
  assert.equal(isDefaultServiceStatement("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('a', '1')"), false);
  assert.equal(isDefaultServiceStatement('-- note\nCREATE TABLE IF NOT EXISTS services (code VARCHAR(10))'), false);
});

test('a service row is a whole number from 1 to 20, and cannot be blank', () => {
  assert.equal(c.validateService({ row: 3 }, [], false).values.row, 3);
  assert.equal(c.validateService({ row: '2' }, [], false).values.row, 2);
  for (const bad of ['', null, 0, 21, 1.5, 'x']) {
    assert.match(c.validateService({ row: bad }, [], false).error, /1 to 20/, String(bad));
  }
  // Row and position are optional when adding a service: left out, it goes at the end.
  assert.equal(c.validateService({ code: 'NEW', name: 'New' }, [], true).values.row, undefined);
});

test('with no rows chosen, services are split into even rows of at most four, longer rows first', () => {
  assert.deepEqual(c.layoutRows(0), []);
  assert.deepEqual(c.layoutRows(3), [3]);
  assert.deepEqual(c.layoutRows(5), [3, 2]);
  assert.deepEqual(c.layoutRows(10), [4, 3, 3]);
  assert.deepEqual(c.layoutRows(13), [4, 3, 3, 3]);
  for (let n = 1; n < 60; n++) {
    const rows = c.layoutRows(n);
    assert.equal(rows.reduce((a, b) => a + b, 0), n);
    assert.ok(rows.every((r) => r >= 1 && r <= c.ROW_TILES), String(n));
  }
});

test('a kiosk layout lists every service that is on once, drops empty rows, and is refused otherwise', () => {
  const on = ['A1', 'B2', 'C3'];
  assert.deepEqual(c.validateLayout({ rows: [['B2', 'A1'], [], ['C3']] }, on).rows, [['B2', 'A1'], ['C3']]);
  assert.match(c.validateLayout({ rows: [['A1', 'B2']] }, on).error, /missing C3/);
  assert.match(c.validateLayout({ rows: [['A1', 'B2', 'C3', 'Z9']] }, on).error, /Z9 is not a service that is turned on/);
  assert.match(c.validateLayout({ rows: [['A1', 'B2'], ['B2', 'C3']] }, on).error, /B2 is in the layout twice/);
  assert.match(c.validateLayout({ rows: 'A1' }, on).error, /Send the rows/);
  assert.match(c.validateLayout({ rows: ['A1'] }, on).error, /list of services/);
  assert.match(c.validateLayout(null, on).error, /Send the rows/);
  const many = Array.from({ length: 21 }, (_, i) => 'S' + i);
  assert.match(c.validateLayout({ rows: many.map((x) => [x]) }, many).error, /up to 20 rows/);
});

test('a service can be set to ask appointment questions and to be pinned, as yes or no', () => {
  assert.deepEqual(c.validateService({ asksAppointment: true, pinned: false }, [], false).values, { asksAppointment: true, pinned: false });
  assert.match(c.validateService({ asksAppointment: 'yes' }, [], false).error, /yes or no/);
  assert.match(c.validateService({ pinned: 1 }, [], false).error, /yes or no/);
  assert.equal(c.validateService({ code: 'NEW', name: 'New' }, [], true).values.pinned, undefined);
});

test('the default appointment service asks the questions and is pinned, and nothing else is', () => {
  assert.equal(seed.SERVICES.AC.appointment, true);
  assert.equal(seed.SERVICES.AC.pinned, true);
  for (const [code, s] of Object.entries(seed.SERVICES)) {
    if (code !== 'AC') assert.ok(!s.appointment && !s.pinned, code);
  }
});

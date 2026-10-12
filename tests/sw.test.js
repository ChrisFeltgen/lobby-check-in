const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const source = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');

test('the service worker is valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(source));
});

test('every page and script it keeps for an outage exists (the live connection script comes from the server)', () => {
  const list = /var PRECACHE = \[([^\]]*)\]/.exec(source);
  assert.ok(list, 'the list of pages is there');
  const names = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.includes('kiosk.html') && names.includes('queue.html') && names.includes('monitor.html'));
  for (const name of names) {
    if (name.startsWith('socket.io/')) continue;
    assert.ok(fs.existsSync(path.join(PUBLIC, name)), name + ' exists');
  }
});

test('it never keeps API data or the live connection, and every page registers it', () => {
  assert.match(source, /indexOf\('api\/'\) === 0/);
  assert.match(source, /indexOf\('socket\.io\/'\) === 0/);
  assert.match(fs.readFileSync(path.join(PUBLIC, 'app-settings.js'), 'utf8'), /serviceWorker\.register\(BASE \+ 'sw\.js'\)/);
  for (const page of ['index', 'kiosk', 'monitor', 'queue', 'manage', 'account']) {
    assert.match(fs.readFileSync(path.join(PUBLIC, page + '.html'), 'utf8'), /src="app-settings\.js"/, page + ' loads app-settings.js');
  }
});

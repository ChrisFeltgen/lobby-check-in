'use strict';

// Management is one page with a tab for everything an admin changes, Service Configuration included. These checks read
// public/manage.html as text, so a tab that goes missing, a button that points at nothing, or an element that is drawn
// twice shows up here and not on the live site.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'manage.html'), 'utf8');

const TABS = [
  ['services', 'Operations'],
  ['staff', 'Staff'],
  ['reports', 'Reports'],
  ['catalog', 'Service Configuration'],
  ['settings', 'Settings'],
  ['security', 'Security'],
  ['health', 'Health and Audit'],
];

test('the tabs are Operations, Staff, Reports, Service Configuration, Settings, Security and Health and Audit, in that order', () => {
  const nav = /<nav class="tabs hidden" id="tabs">([\s\S]*?)<\/nav>/.exec(html);
  assert.ok(nav, 'the tab bar is there');
  const buttons = [...nav[1].matchAll(/<button class="tab-btn" data-tab="([^"]+)" type="button">([^<]*)<\/button>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(buttons, TABS);
  assert.ok(!/<a\b/.test(nav[1]), 'every entry is a tab of this page, not a link to another page');
});

test('the old Services & languages page is gone, and nothing points at it', () => {
  assert.ok(!fs.existsSync(path.join(PUBLIC, 'catalog.html')));
  for (const file of fs.readdirSync(PUBLIC).filter((f) => /\.(html|js)$/.test(f))) {
    assert.ok(!/catalog\.html/.test(fs.readFileSync(path.join(PUBLIC, file), 'utf8')), file + ' mentions catalog.html');
  }
});

test('only admins may open the Service Configuration, Settings, Security and Health and Audit tabs', () => {
  const access = /var TAB_ACCESS = \{([^}]*)\}/.exec(html);
  assert.ok(access, 'TAB_ACCESS is there');
  const roles = {};
  for (const m of access[1].matchAll(/(\w+): \[([^\]]*)\]/g)) roles[m[1]] = [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1]);
  assert.deepEqual(Object.keys(roles), TABS.map((t) => t[0]), 'every tab, in the same order as the bar');
  for (const tab of ['catalog', 'settings', 'security', 'health']) assert.deepEqual(roles[tab], ['admin'], tab);
  for (const tab of ['services', 'staff', 'reports']) assert.deepEqual(roles[tab], ['manager', 'admin'], tab);
});

// The Service Configuration markup sits in a <template> and is drawn into the tab only for an admin, so its ids never
// collide with the page's own. Together they must still name each element once.
test('no id is used twice, counting the page and the Service Configuration template together', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const twice = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual(twice, []);
});

test('everything the Service Configuration code looks up by id is in its template', () => {
  const template = /<template id="catalog-template">([\s\S]*?)<\/template>/.exec(html);
  assert.ok(template, 'the template is there');
  const inTemplate = new Set([...template[1].matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const code = /var catalogTab = \(function \(\) \{([\s\S]*?)\n      \}\)\(\);/.exec(html);
  assert.ok(code, 'catalogTab is there');
  const looked = new Set([...code[1].matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  // Created by the code itself, or drawn by Management
  const elsewhere = new Set(['panel-catalog']);
  for (const id of looked) {
    if (id.includes('-new-') && id.endsWith('-slot')) assert.ok(inTemplate.has(id), id);
    else assert.ok(inTemplate.has(id) || elsewhere.has(id), id + ' is not in the template');
  }
  // ...and the sections it switches between have ids of their own, apart from Management's panel-<tab> ids
  for (const section of ['services', 'groups', 'languages', 'translations']) assert.ok(inTemplate.has('cfg-panel-' + section), section);
});

test('the Service Configuration styles are all scoped to its tab, so they cannot change another tab', () => {
  const mark = html.indexOf('Service Configuration tab (it was its own page)');
  assert.ok(mark > 0, 'its style block is there');
  const start = html.lastIndexOf('/*', mark);
  const css = html.slice(start, html.indexOf('</style>', mark));
  const selectors = [];
  const strip = css.replace(/\/\*[\s\S]*?\*\//g, '');
  (function walk(text) {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (depth) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
      if (prelude.startsWith('@media')) walk(text.slice(open + 1, j - 1));
      else if (prelude) prelude.split(',').forEach((s) => selectors.push(s.trim()));
      i = j;
    }
  })(strip);
  assert.ok(selectors.length > 80, 'its rules are there');
  assert.deepEqual(selectors.filter((s) => !s.startsWith('#panel-catalog ')), []);
});

test('Management loads the script that draws the icons, which Service Configuration uses', () => {
  assert.match(html, /<script src="icons\.js"><\/script>/);
  assert.ok(fs.existsSync(path.join(PUBLIC, 'icons.js')));
});

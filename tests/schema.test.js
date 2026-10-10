'use strict';

// The startup code splits schema.sql on every semicolon, so a semicolon inside a comment would cut a
// statement in half. This test catches that before it reaches the live server.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { splitStatements } = require('../db');

const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');

test('no comment line contains a semicolon', () => {
  const offending = sql.split('\n').filter((line) => /^\s*--/.test(line) && line.includes(';'));
  assert.deepEqual(offending, []);
});

test('every statement starts with an SQL keyword once comments are removed', () => {
  const statements = splitStatements(sql);
  assert.ok(statements.length > 0);
  statements.forEach((statement) => {
    const code = statement.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n').trim();
    assert.match(code, /^(CREATE|INSERT|ALTER|UPDATE)\b/i, 'unexpected statement: ' + code.slice(0, 80));
  });
});

test('the schema creates every table the app uses', () => {
  const tables = ['services', 'service_counters', 'tickets', 'service_schedules', 'users', 'audit_log', 'app_settings'];
  tables.forEach((table) => {
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS ' + table + ' ('), table);
  });
});

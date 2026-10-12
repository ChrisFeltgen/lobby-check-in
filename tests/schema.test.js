'use strict';

// The startup code splits schema.sql on every semicolon, so a semicolon inside a comment would cut a
// statement in half. This test catches that before it reaches the live server.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { splitStatements, isCreateStatement } = require('../db');

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

// A statement with a comment above it still has to be seen as a CREATE. If it is not, its table is only made after
// the startup code has tried to add columns to it, and a new, empty database fails to start ("Table users doesn't exist").
test('every table is created before columns are added to one, whatever comment sits above its statement', () => {
  splitStatements(sql).forEach((statement) => {
    const code = statement.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
    assert.equal(isCreateStatement(statement), /^\s*CREATE\s+TABLE/i.test(code), 'misread statement: ' + code.slice(0, 60));
  });
  assert.equal(isCreateStatement('-- A comment\n-- another\nCREATE TABLE IF NOT EXISTS users (id INT)'), true);
  assert.equal(isCreateStatement('-- CREATE TABLE in a comment\nINSERT INTO services VALUES (1)'), false);
});

// An install that already has the table gets a column the schema later adds from the startup code, and a new install gets
// it from the schema. Both have to say the same thing, or the two kinds of install end up with different tables.
test('the monitor mode of an access link is in the schema and is added to a table made before it existed', () => {
  const definition = "ENUM('full','left','right') NOT NULL DEFAULT 'full'";
  const table = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS screen_links'));
  assert.ok(table.slice(0, table.indexOf(';')).includes('panel ' + definition), 'schema.sql');
  const code = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  assert.ok(code.includes("ensureColumn(conn, 'screen_links', 'panel', \"" + definition + "\")"), 'db.js');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const reports = require('../reports');

test('only real calendar dates are accepted', () => {
  assert.equal(reports.isCalendarDate('2026-10-09'), true);
  assert.equal(reports.isCalendarDate('2026-02-30'), false, 'no 30th of February');
  assert.equal(reports.isCalendarDate('09/10/2026'), false);
  assert.equal(reports.isCalendarDate(''), false);
});

test('a range must be valid and in order', () => {
  assert.equal(reports.rangeProblem('2026-10-08', '2026-10-09'), null);
  assert.equal(reports.rangeProblem('2026-10-09', '2026-10-09'), null, 'a single day is fine');
  assert.equal(reports.rangeProblem('2026-10-09', '2026-10-08'), 'The end date must be on or after the start date');
  assert.equal(reports.rangeProblem('2026-02-30', '2026-03-01'), 'Choose valid dates');
});

test('a range is capped at one year', () => {
  assert.equal(reports.rangeProblem('2026-01-01', '2026-12-31'), null, '365 days');
  assert.equal(reports.rangeProblem('2024-01-01', '2025-01-01'), 'Choose a range of no more than a year', '366 days, a leap year');
});

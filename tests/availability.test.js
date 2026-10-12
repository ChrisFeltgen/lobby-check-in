'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAvailability, isScheduleActiveAt } = require('../lib/availability');

// 14 October 2026 is a Wednesday. 7 October is the 1st Wednesday, 21 October the 3rd, 28 October the last.
const wed = (day, hour, minute) => new Date(2026, 9, day, hour, minute);

const weekly = {
  id: 1, active: 1, weekday: 3, recurrence: 'weekly', nth_weeks: null,
  start_time: '12:00:00', end_time: '16:00:00', message: 'Closed for training',
};

test('a weekly closure applies during its window only', () => {
  assert.equal(isScheduleActiveAt(weekly, wed(14, 13, 0)), true);
  assert.equal(isScheduleActiveAt(weekly, wed(14, 11, 59)), false);
  assert.equal(isScheduleActiveAt(weekly, wed(14, 16, 0)), false, 'the end time is not closed');
  assert.equal(isScheduleActiveAt(weekly, wed(15, 13, 0)), false, 'a different day');
  assert.equal(isScheduleActiveAt({ ...weekly, active: 0 }, wed(14, 13, 0)), false, 'paused');
});

test('a monthly closure applies only on the chosen weeks', () => {
  const firstAndThird = { ...weekly, recurrence: 'monthly_nth', nth_weeks: '1,3' };
  assert.equal(isScheduleActiveAt(firstAndThird, wed(7, 13, 0)), true, '1st Wednesday');
  assert.equal(isScheduleActiveAt(firstAndThird, wed(14, 13, 0)), false, '2nd Wednesday');
  assert.equal(isScheduleActiveAt(firstAndThird, wed(21, 13, 0)), true, '3rd Wednesday');
});

test('"last" means the final occurrence of that weekday in the month', () => {
  const lastWed = { ...weekly, recurrence: 'monthly_nth', nth_weeks: 'last' };
  assert.equal(isScheduleActiveAt(lastWed, wed(28, 13, 0)), true);
  assert.equal(isScheduleActiveAt(lastWed, wed(21, 13, 0)), false);
});

test('a manual closure overrides being open', () => {
  const result = resolveAvailability({ manual_override: 'closed', manual_message: 'Hearing', manual_override_expires_at: null }, [], wed(14, 9, 0));
  assert.deepEqual(result, { available: false, message: 'Hearing', source: 'manual' });
});

test('a manual reopen overrides an active recurring closure', () => {
  const result = resolveAvailability({ manual_override: 'open', manual_override_expires_at: null }, [weekly], wed(14, 13, 0));
  assert.deepEqual(result, { available: true, source: 'manual' });
});

test('a manual closure with a reopen time stops applying after that time', () => {
  const service = { manual_override: 'closed', manual_message: 'Hearing', manual_override_expires_at: new Date(2026, 9, 14, 12, 0) };
  assert.equal(resolveAvailability(service, [], wed(14, 11, 0)).available, false);
  assert.equal(resolveAvailability(service, [], wed(14, 12, 30)).available, true);
});

test('a recurring closure is reported with its message and schedule', () => {
  const result = resolveAvailability({ manual_override: 'none' }, [weekly], wed(14, 13, 0));
  assert.deepEqual(result, { available: false, message: 'Closed for training', source: 'schedule', scheduleId: 1 });
});

test('with nothing set, the service is open', () => {
  assert.deepEqual(resolveAvailability({ manual_override: 'none' }, [], wed(14, 13, 0)), { available: true, source: 'default' });
});

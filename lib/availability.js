'use strict';

// Decides whether a service is open right now, combining a manual override with any
// recurring closure schedules. Pure functions, no database access, so this is easy to
// reuse from different routes and easy to reason about independent of the DB layer.

function parseClock(t) {
  // mysql2 returns a TIME column as a "HH:MM:SS" string.
  const parts = String(t).split(':').map(Number);
  return parts[0] * 60 + (parts[1] || 0);
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

// Is this one recurring schedule in effect at `now`?
function isScheduleActiveAt(schedule, now) {
  if (!schedule.active) return false;
  if (now.getDay() !== Number(schedule.weekday)) return false;

  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = parseClock(schedule.start_time);
  const end = parseClock(schedule.end_time);
  if (!(minutes >= start && minutes < end)) return false;

  if (schedule.recurrence === 'weekly') return true;

  // monthly_nth: which occurrence of this weekday is today — 1st, 2nd, 3rd, 4th, or "last"?
  const date = now.getDate();
  const occurrence = Math.ceil(date / 7); // 1-5
  const isLast = date + 7 > daysInMonth(now.getFullYear(), now.getMonth());
  const weeks = String(schedule.nth_weeks || '').split(',').map((s) => s.trim()).filter(Boolean);
  return weeks.includes(String(occurrence)) || (isLast && weeks.includes('last'));
}

// Combines a service's manual override with its schedules to decide availability right now.
// `service` is a row from the services table (snake_case columns); `schedules` is that
// service's rows from service_schedules.
function resolveAvailability(service, schedules, now) {
  now = now || new Date();

  const overrideLive = service.manual_override && service.manual_override !== 'none' &&
    (!service.manual_override_expires_at || now < new Date(service.manual_override_expires_at));

  if (overrideLive) {
    if (service.manual_override === 'closed') {
      return { available: false, message: service.manual_message || 'This service is temporarily unavailable.', source: 'manual' };
    }
    // 'open' forces the service open even through an active schedule.
    return { available: true, source: 'manual' };
  }

  const active = (schedules || []).find((s) => isScheduleActiveAt(s, now));
  if (active) {
    return { available: false, message: active.message, source: 'schedule', scheduleId: active.id };
  }

  return { available: true, source: 'default' };
}

module.exports = { isScheduleActiveAt, resolveAvailability, parseClock };

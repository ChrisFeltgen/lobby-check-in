'use strict';

// Checks the date range the Reports tab asks for. Pure functions with no database access, so the
// rules can be tested on their own. The server uses these for /api/reports/range.

const REPORT_MAX_DAYS = 366;

// A real calendar date in YYYY-MM-DD form. Rejects shapes that look right but aren't, such as 2026-02-30.
function isCalendarDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
}

// Returns an error message for a range that can't be used, or null when it can.
function rangeProblem(from, to) {
  if (!isCalendarDate(from) || !isCalendarDate(to)) return 'Choose valid dates';
  const days = (new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000;
  if (days < 0) return 'The end date must be on or after the start date';
  if (days >= REPORT_MAX_DAYS) return 'Choose a range of no more than a year';
  return null;
}

module.exports = { isCalendarDate, rangeProblem, REPORT_MAX_DAYS };

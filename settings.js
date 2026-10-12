// App settings that admins change from Management → Settings. Each one has a type, limits and a
// default. Values are stored as text in app_settings and read back with these defaults, so a missing
// or odd stored value never stops the app from starting.

// Departments the lobby monitor can group together. The monitor draws them; these ids are what a
// monitor panel can list alongside single service codes.
const DEPARTMENT_GROUPS = [
  { id: 'building', label: 'Building Dept.', codes: ['BPI', 'CR', 'BSC'] },
  { id: 'planning', label: 'Planning & Zoning', codes: ['UF', 'ZD'] },
  { id: 'records', label: 'Records & Alarms', codes: ['LS', 'AB'] },
];

const DEFINITIONS = {
  kiosk_idle_seconds: { label: 'Kiosk inactivity reset', type: 'int', def: 60, min: 15, max: 300 },
  kiosk_done_seconds: { label: 'Kiosk confirmation time', type: 'int', def: 10, min: 3, max: 60 },
  monitor_call_seconds: { label: 'Now Calling notice time', type: 'int', def: 15, min: 5, max: 120 },
  monitor_chime: { label: 'Now Calling chime', type: 'bool', def: true },
  monitor_scroll: { label: 'Long queue scrolling', type: 'choice', def: 'normal', options: ['slow', 'normal', 'fast'] },
  kiosk_theme: { label: 'Kiosk colours', type: 'choice', def: 'light', options: ['light', 'dark'] },
  monitor_theme: { label: 'Lobby monitor colours', type: 'choice', def: 'dark', options: ['light', 'dark'] },
  checkin_rate_per_minute: { label: 'Check-ins allowed per minute from one address (0 = no limit)', type: 'int', def: 20, min: 0, max: 600 },
  monitor_left: { label: 'Left monitor departments', type: 'keys', def: ['planning', 'CE', 'BTD'] },
  monitor_right: { label: 'Right monitor departments', type: 'keys', def: ['building', 'records', 'AC'] },
  session_hours: { label: 'Session length (hours)', type: 'int', def: 12, min: 1, max: 24 },
  session_idle_minutes: { label: 'Idle sign-out (minutes, 0 is off)', type: 'int', def: 0, min: 0, max: 480 },
  min_password_length: { label: 'Minimum password length', type: 'int', def: 8, min: 6, max: 64 },
  new_account_change_password: { label: 'New accounts must change password', type: 'bool', def: true },
  lockout_attempts: { label: 'Failed sign-ins before lockout (0 is off)', type: 'int', def: 5, min: 0, max: 20 },
  lockout_minutes: { label: 'Lockout length (minutes)', type: 'int', def: 15, min: 1, max: 120 },
  audit_retention_days: { label: 'Audit log retention (days, 0 keeps everything)', type: 'int', def: 0, min: 0, max: 3650 },
  auto_close_time: { label: 'End of day: close open tickets at (blank = off)', type: 'clock', def: '' },
  org_name: { label: 'Organisation name', type: 'text', def: '', max: 100 },
};

// Settings the public screens and sign-in pages need. Everything else stays admin-only.
const PUBLIC_KEYS = [
  'kiosk_idle_seconds', 'kiosk_done_seconds', 'monitor_call_seconds', 'monitor_chime', 'monitor_scroll',
  'monitor_left', 'monitor_right', 'kiosk_theme', 'monitor_theme', 'min_password_length', 'new_account_change_password', 'org_name',
];

// Audit-log cleanup removes old rows, so a short window would make the sign-in lockout forget failures.
const MIN_AUDIT_DAYS = 30;

// A 24-hour time such as 17:30.
const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Reads one value from its stored text. Returns undefined when the stored text can't be used.
function fromStored(key, text) {
  const d = DEFINITIONS[key];
  if (text === undefined || text === null) return undefined;
  switch (d.type) {
    case 'int': {
      const n = Number(text);
      return Number.isInteger(n) && n >= d.min && n <= d.max ? n : undefined;
    }
    case 'bool':
      return text === '1' ? true : text === '0' ? false : undefined;
    case 'choice':
      return d.options.includes(text) ? text : undefined;
    case 'text':
      return String(text).slice(0, d.max);
    case 'clock':
      return text === '' ? '' : CLOCK_RE.test(text) ? text : undefined;
    case 'keys': {
      try {
        const list = JSON.parse(text);
        return Array.isArray(list) && list.length && list.every((k) => typeof k === 'string') ? list : undefined;
      } catch (e) {
        return undefined;
      }
    }
    default:
      return undefined;
  }
}

function toStored(key, value) {
  const d = DEFINITIONS[key];
  if (d.type === 'bool') return value ? '1' : '0';
  if (d.type === 'keys') return JSON.stringify(value);
  return String(value);
}

// Turns the stored settings (key → text) into typed values, with defaults for anything missing or unusable.
function parseSettings(stored) {
  const values = {};
  Object.keys(DEFINITIONS).forEach((key) => {
    const value = fromStored(key, (stored || {})[key]);
    values[key] = value === undefined ? DEFINITIONS[key].def : value;
  });
  return values;
}

// Checks a settings change from the admin form. `serviceCodes` are the active service codes, which are
// the only codes a monitor panel may list. Returns { changes } with typed values, or { error }.
function validateSettings(body, serviceCodes, groups) {
  const departments = groups || DEPARTMENT_GROUPS;
  const changes = {};
  const allowedKeys = new Set([...departments.map((g) => g.id), ...serviceCodes]);
  const input = body || {};
  for (const key of Object.keys(input)) {
    const d = DEFINITIONS[key];
    if (!d) return { error: 'Unknown setting: ' + key };
    const raw = input[key];
    if (d.type === 'int') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < d.min || n > d.max) return { error: d.label + ' must be a whole number from ' + d.min + ' to ' + d.max };
      changes[key] = n;
    } else if (d.type === 'bool') {
      if (typeof raw !== 'boolean') return { error: d.label + ' must be on or off' };
      changes[key] = raw;
    } else if (d.type === 'choice') {
      if (!d.options.includes(raw)) return { error: d.label + ' must be one of: ' + d.options.join(', ') };
      changes[key] = raw;
    } else if (d.type === 'text') {
      if (typeof raw !== 'string' || raw.trim().length > d.max) return { error: d.label + ' must be up to ' + d.max + ' characters' };
      changes[key] = raw.trim();
    } else if (d.type === 'clock') {
      const value = String(raw === null || raw === undefined ? '' : raw);
      if (value !== '' && !CLOCK_RE.test(value)) return { error: d.label + ' must be a time such as 17:30, or blank' };
      changes[key] = value;
    } else if (d.type === 'keys') {
      if (!Array.isArray(raw) || !raw.length) return { error: 'Choose at least one department for ' + d.label.toLowerCase() };
      const unique = [...new Set(raw.map(String))];
      const bad = unique.find((k) => !allowedKeys.has(k));
      if (bad) return { error: 'Unknown department: ' + bad };
      // A department and one of its own services would be drawn twice on the monitor.
      for (const group of departments) {
        const clash = group.codes.find((code) => unique.includes(code));
        if (unique.includes(group.id) && clash) return { error: 'Choose ' + group.label + ' or its service ' + clash + ', not both' };
      }
      changes[key] = unique;
    }
  }
  if (changes.audit_retention_days && changes.audit_retention_days < MIN_AUDIT_DAYS) {
    return { error: 'Keep the audit log for at least ' + MIN_AUDIT_DAYS + ' days, or 0 to keep everything' };
  }
  return { changes };
}

// The subset of settings that public pages may read.
function publicSettings(values) {
  const out = {};
  PUBLIC_KEYS.forEach((key) => { out[key] = values[key]; });
  return out;
}

module.exports = {
  DEFINITIONS, DEPARTMENT_GROUPS, MIN_AUDIT_DAYS,
  parseSettings, toStored, fromStored, validateSettings, publicSettings,
};

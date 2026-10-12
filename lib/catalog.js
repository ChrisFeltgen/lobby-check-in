// Rules for the service catalogue: services, department groups, languages and translations.
// Pure functions only, so they can be tested without a database. The database work is in db.js.

// Service codes are the key that tickets point to. Letters and numbers, 2 to 10 characters.
const CODE_RE = /^[A-Z0-9]{2,10}$/;
// Group ids are used in settings and in the page code. Lower case letters, numbers and dashes.
const GROUP_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
// Language codes: "en", "es", or a region such as "pt-br".
const LANG_RE = /^[a-z]{2}(-[a-z]{2})?$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Names of the icons a service or group can use. These must match the drawings in public/icons.js.
const ICON_NAMES = [
  'building', 'shield', 'clipboard', 'shield-alert', 'receipt', 'leaf', 'map', 'file-search', 'bell', 'calendar',
  'users', 'home', 'phone', 'help', 'book', 'briefcase', 'heart', 'flag',
];

function text(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

// The kiosk shows services in rows. A service has a row number and, within the row, a position.
const MAX_ROW = 20;
// The most tiles a row is planned for: more than this may wrap on a smaller screen.
const ROW_TILES = 4;

function rowValue(raw) {
  const n = Number(raw);
  if (raw === '' || raw === null || !Number.isInteger(n) || n < 1 || n > MAX_ROW) return { error: 'Row must be a whole number from 1 to ' + MAX_ROW };
  return { value: n };
}

// How a number of services is split into rows when nobody has chosen: at most 4 to a row, the rows as even as
// possible and the longer ones first. Ten services make 4, 3 and 3.
function layoutRows(count) {
  if (count <= 0) return [];
  const rows = Math.ceil(count / ROW_TILES);
  const base = Math.floor(count / rows);
  const extra = count % rows;
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0));
}

// The kiosk layout as the admin page sends it: a list of rows, each a list of service codes in order. Every
// service that is turned on must appear exactly once, so no two services are left fighting over a place.
// Empty rows are dropped. Returns { rows } or { error }.
function validateLayout(body, activeCodes) {
  const rows = body && body.rows;
  if (!Array.isArray(rows)) return { error: 'Send the rows to save' };
  const seen = new Set();
  const clean = [];
  for (const row of rows) {
    if (!Array.isArray(row)) return { error: 'Each row must be a list of services' };
    const codes = row.map(String);
    if (!codes.length) continue;
    for (const code of codes) {
      if (!activeCodes.includes(code)) return { error: code + ' is not a service that is turned on. Reload the page and try again.' };
      if (seen.has(code)) return { error: code + ' is in the layout twice' };
      seen.add(code);
    }
    clean.push(codes);
  }
  if (clean.length > MAX_ROW) return { error: 'The kiosk can have up to ' + MAX_ROW + ' rows' };
  const missing = activeCodes.filter((code) => !seen.has(code));
  if (missing.length) return { error: 'The layout is missing ' + missing.join(', ') + '. Reload the page and try again.' };
  return { rows: clean };
}

// Where an item sits in its list: a whole number from 0 to 999. Returns { value } or { error }.
function sortOrderValue(raw) {
  const n = Number(raw);
  if (raw === '' || raw === null || !Number.isInteger(n) || n < 0 || n > 999) return { error: 'Order must be a whole number from 0 to 999' };
  return { value: n };
}

// A service: the name and description shown to customers, its icon, and its department group.
// `groupIds` are the group ids that exist. Returns { values } with only the fields that were sent, or { error }.
function validateService(body, groupIds, creating) {
  const input = body || {};
  const values = {};
  if (creating) {
    const code = text(input.code, 10).toUpperCase();
    if (!CODE_RE.test(code)) return { error: 'Service codes are 2 to 10 letters or numbers, for example BPI' };
    values.code = code;
  }
  if (input.name !== undefined || creating) {
    const name = text(input.name, 100);
    if (!name) return { error: 'Enter the service name' };
    values.name = name;
  }
  if (input.description !== undefined) {
    values.description = text(input.description, 255) || null;
  }
  if (input.icon !== undefined) {
    const icon = text(input.icon, 40);
    if (icon && !ICON_NAMES.includes(icon)) return { error: 'Choose one of the listed icons' };
    values.icon = icon || null;
  }
  if (input.color !== undefined) {
    const color = text(input.color, 7);
    if (color && !COLOR_RE.test(color)) return { error: 'Colour must be a hex value such as #2f6fd6' };
    values.color = color || null;
  }
  if (input.groupId !== undefined) {
    const groupId = text(input.groupId, 40);
    if (groupId && !groupIds.includes(groupId)) return { error: 'Choose a department group that exists' };
    values.groupId = groupId || null;
  }
  if (input.active !== undefined) {
    if (typeof input.active !== 'boolean') return { error: 'Active must be yes or no' };
    values.active = input.active;
  }
  // Two behaviours a service can have: asking appointment questions, and being pinned in staff queues.
  if (input.asksAppointment !== undefined) {
    if (typeof input.asksAppointment !== 'boolean') return { error: 'Asks for an appointment must be yes or no' };
    values.asksAppointment = input.asksAppointment;
  }
  if (input.pinned !== undefined) {
    if (typeof input.pinned !== 'boolean') return { error: 'Pinned must be yes or no' };
    values.pinned = input.pinned;
  }
  if (input.row !== undefined) {
    const row = rowValue(input.row);
    if (row.error) return row;
    values.row = row.value;
  }
  if (input.sortOrder !== undefined) {
    const order = sortOrderValue(input.sortOrder);
    if (order.error) return order;
    values.sortOrder = order.value;
  }
  return { values };
}

// A department group: the card the monitor draws for the services in it.
function validateGroup(body, existingIds, creating) {
  const input = body || {};
  const values = {};
  if (creating) {
    const id = text(input.id, 40).toLowerCase();
    if (!GROUP_ID_RE.test(id)) return { error: 'Group ids are 2 to 40 lower case letters, numbers or dashes' };
    if (existingIds.includes(id)) return { error: 'A group with that id already exists' };
    values.id = id;
  }
  if (input.label !== undefined || creating) {
    const label = text(input.label, 100);
    if (!label) return { error: 'Enter the group name' };
    values.label = label;
  }
  if (input.icon !== undefined) {
    const icon = text(input.icon, 40);
    if (icon && !ICON_NAMES.includes(icon)) return { error: 'Choose one of the listed icons' };
    values.icon = icon || null;
  }
  if (input.color !== undefined) {
    const color = text(input.color, 7);
    if (color && !COLOR_RE.test(color)) return { error: 'Colour must be a hex value such as #2f6fd6' };
    values.color = color || null;
  }
  if (input.sortOrder !== undefined) {
    const order = sortOrderValue(input.sortOrder);
    if (order.error) return order;
    values.sortOrder = order.value;
  }
  return { values };
}

// A language the kiosk can offer. The code is fixed once made; the name and whether it is on can change.
function validateLanguage(body, existingCodes, creating) {
  const input = body || {};
  const values = {};
  if (creating) {
    const code = text(input.code, 10).toLowerCase();
    if (!LANG_RE.test(code)) return { error: 'Language codes look like "es" or "pt-br"' };
    if (existingCodes.includes(code)) return { error: 'That language is already set up' };
    values.code = code;
  }
  if (input.name !== undefined || creating) {
    const name = text(input.name, 50);
    if (!name) return { error: 'Enter the language name, as people in that language would write it' };
    values.name = name;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return { error: 'Enabled must be yes or no' };
    values.enabled = input.enabled;
  }
  return { values };
}

// Translations: a map of item key to the text in that language. An empty text removes the translation,
// so the English is used again. Only keys the app knows about are accepted.
function validateTranslations(values, knownKeys) {
  const known = new Set(knownKeys);
  const changes = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (!known.has(key)) return { error: 'Unknown item: ' + key };
    if (typeof value !== 'string') return { error: 'Translations must be text' };
    const clean = value.trim();
    if (clean.length > 500) return { error: 'Keep each translation under 500 characters' };
    changes[key] = clean;
  }
  return { changes };
}

// Item keys for translations. Services and groups are per item; the kiosk wording is per phrase.
const keys = {
  serviceName: (code) => 'service.' + code + '.name',
  serviceDescription: (code) => 'service.' + code + '.description',
  groupLabel: (id) => 'group.' + id + '.label',
  ui: (key) => 'ui.' + key,
};

// Every item that can be translated into one language, each with its English text alongside. `translations` is that
// language's saved text, keyed by item key. The list is built from the services, groups and wording as they are now,
// so a service or group added later appears in it at once, with no translation yet.
// A service's description is listed only when it has one (or already has a translation), so a service with no
// description is not left "still to translate" for text that is not there.
function translationItems(services, groups, uiStrings, translations) {
  const tr = translations || {};
  const items = [];
  for (const s of services) {
    const nameKey = keys.serviceName(s.code);
    const descriptionKey = keys.serviceDescription(s.code);
    items.push({ key: nameKey, section: 'Services', label: s.code + ' name', english: s.name, value: tr[nameKey] || '' });
    if (s.description || tr[descriptionKey]) {
      items.push({ key: descriptionKey, section: 'Services', label: s.code + ' description', english: s.description || '', value: tr[descriptionKey] || '' });
    }
  }
  for (const g of groups) {
    items.push({ key: keys.groupLabel(g.id), section: 'Department groups', label: g.id, english: g.englishLabel, value: tr[keys.groupLabel(g.id)] || '' });
  }
  for (const k of Object.keys(uiStrings)) {
    items.push({ key: keys.ui(k), section: 'Kiosk wording', label: k, english: uiStrings[k], value: tr[keys.ui(k)] || '' });
  }
  return items;
}

function untranslatedCount(items) {
  return items.filter((item) => !item.value).length;
}

// For each service, the languages that are missing its name, or its description when it has one. `translationsByLang`
// maps a language code to that language's saved text. A service that is fully translated is left out.
function serviceTranslationGaps(services, languageCodes, translationsByLang) {
  const gaps = {};
  for (const s of services) {
    const missing = languageCodes.filter((lang) => {
      const tr = (translationsByLang && translationsByLang[lang]) || {};
      return !tr[keys.serviceName(s.code)] || !!(s.description && !tr[keys.serviceDescription(s.code)]);
    });
    if (missing.length) gaps[s.code] = missing;
  }
  return gaps;
}

module.exports = {
  MAX_ROW, ROW_TILES, layoutRows, validateLayout,
  CODE_RE, GROUP_ID_RE, LANG_RE, COLOR_RE, ICON_NAMES, keys,
  validateService, validateGroup, validateLanguage, validateTranslations,
  translationItems, untranslatedCount, serviceTranslationGaps,
};

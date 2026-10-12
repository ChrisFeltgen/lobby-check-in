// The catalogue the app starts with: department groups, the icon, description and colour of each default
// service, and the Spanish translations. Seeded once, on the first start after this change, so later edits
// made in Service Configuration are never overwritten. The Spanish text should be reviewed with staff.
const { UI_STRINGS } = require('./ui-strings');
const { keys } = require('./catalog');

const GROUPS = [
  { id: 'building', label: 'Building Dept.', icon: 'building', color: '#2f6fd6', sortOrder: 1, es: 'Departamento de Edificios' },
  { id: 'planning', label: 'Planning & Zoning', icon: 'map', color: '#2f9e6f', sortOrder: 2, es: 'Planificación y Zonificación' },
  { id: 'records', label: 'Records & Alarms', icon: 'file-search', color: '#7c4fd1', sortOrder: 3, es: 'Registros y Alarmas' },
];

// Per default service: its group (or none), icon, colour on the monitor, English description, and Spanish name and description.
const SERVICES = {
  BPI: { group: 'building', icon: 'building', description: 'Permits, plan review, inspections', es: { name: 'Permisos de construcción e inspecciones', description: 'Permisos, revisión de planos e inspecciones' } },
  BSC: { group: 'building', icon: 'shield', description: 'Building safety inspections and compliance', es: { name: 'Cumplimiento de seguridad de construcción', description: 'Inspecciones y cumplimiento de seguridad de construcción' } },
  CR: { group: 'building', icon: 'clipboard', description: 'Contractor registration and licensing', es: { name: 'Registro de contratistas', description: 'Registro y licencias de contratistas' } },
  CE: { group: null, icon: 'shield-alert', color: '#c2662a', description: 'Code compliance, violations and cases', es: { name: 'Cumplimiento de códigos', description: 'Cumplimiento de códigos, infracciones y casos' } },
  BTD: { group: null, icon: 'receipt', color: '#b23b7a', description: 'Business tax receipts and related services', es: { name: 'Recibos de impuestos comerciales', description: 'Recibos de impuestos comerciales y servicios relacionados' } },
  UF: { group: 'planning', icon: 'leaf', description: 'Landscape, urban forestry and tree services', es: { name: 'Paisajismo y silvicultura urbana', description: 'Paisajismo, silvicultura urbana y servicios de árboles' } },
  LS: { group: 'records', icon: 'file-search', description: 'Search for liens and expired permits', es: { name: 'Búsqueda de gravámenes y permisos vencidos', description: 'Búsqueda de gravámenes y permisos vencidos' } },
  ZD: { group: 'planning', icon: 'map', description: 'Zoning questions and reviews', es: { name: 'Zonificación', description: 'Preguntas y revisiones de zonificación' } },
  AB: { group: 'records', icon: 'bell', description: 'Alarm permits and billing services', es: { name: 'Facturación de alarmas', description: 'Permisos y servicios de facturación de alarmas' } },
  AC: { group: null, appointment: true, pinned: true, icon: 'calendar', color: '#1fae8e', description: 'Check in for scheduled appointments', es: { name: 'Registro de citas', description: 'Registro para citas programadas' } },
};

// Seeds the catalogue once. `conn` is a single connection from the pool.
async function seedCatalog(conn) {
  const [[done]] = await conn.query("SELECT setting_value AS v FROM app_settings WHERE setting_key = 'catalog_seeded'");
  if (done) return;

  for (const g of GROUPS) {
    await conn.query(
      'INSERT IGNORE INTO service_groups (id, label, icon, color, sort_order) VALUES (?, ?, ?, ?, ?)',
      [g.id, g.label, g.icon, g.color, g.sortOrder]
    );
    await conn.query('INSERT IGNORE INTO translations (lang, item_key, value) VALUES (?, ?, ?)', ['es', keys.groupLabel(g.id), g.es]);
  }

  await conn.query(
    "INSERT IGNORE INTO languages (code, name, enabled, sort_order) VALUES ('en', 'English', 1, 1), ('es', 'Español', 1, 2)"
  );

  for (const [code, s] of Object.entries(SERVICES)) {
    await conn.query(
      'UPDATE services SET description = COALESCE(description, ?), icon = COALESCE(icon, ?), group_id = COALESCE(group_id, ?), color = COALESCE(color, ?) WHERE code = ?',
      [s.description, s.icon, s.group, s.color || null, code]
    );
    // The default appointment service asks the appointment questions and is pinned in staff queues.
    if (s.appointment || s.pinned) {
      await conn.query('UPDATE services SET asks_appointment = ?, pinned = ? WHERE code = ?', [s.appointment ? 1 : 0, s.pinned ? 1 : 0, code]);
    }
    await conn.query('INSERT IGNORE INTO translations (lang, item_key, value) VALUES (?, ?, ?)', ['es', keys.serviceName(code), s.es.name]);
    await conn.query('INSERT IGNORE INTO translations (lang, item_key, value) VALUES (?, ?, ?)', ['es', keys.serviceDescription(code), s.es.description]);
  }

  for (const [key, value] of Object.entries(UI_STRINGS.es)) {
    await conn.query('INSERT IGNORE INTO translations (lang, item_key, value) VALUES (?, ?, ?)', ['es', keys.ui(key), value]);
  }

  await conn.query(
    "INSERT INTO app_settings (setting_key, setting_value) VALUES ('catalog_seeded', '1') ON DUPLICATE KEY UPDATE setting_value = '1'"
  );
}

// Kiosk wording added after the first setup, in the order it was added. A new install gets all of the Spanish text
// from seedCatalog; an install that was set up earlier gets each batch below once, the first time it starts with it.
// When you add a message to ui-strings.js, add its key to a NEW batch here (with the next flag), or an install that
// already exists would show it in English in every other language. A test checks this.
const ADDED_WORDING = [
  { flag: 'wording_added_1', keys: ['welcome_title'] },
  { flag: 'wording_added_2', keys: ['choose_language', 'err_rate', 'offline_title', 'offline_message', 'offline_help'] },
];

// Puts the Spanish text of each batch in, once. Text an admin has since changed or cleared is never put back: a batch
// runs only the one time, and never replaces a translation that is there. If Spanish has been deleted as a language,
// nothing is added for it.
async function seedAddedWording(conn) {
  for (const batch of ADDED_WORDING) {
    const [[done]] = await conn.query('SELECT setting_value AS v FROM app_settings WHERE setting_key = ?', [batch.flag]);
    if (done) continue;
    const [[spanish]] = await conn.query("SELECT COUNT(*) AS n FROM languages WHERE code = 'es'");
    if (spanish.n) {
      for (const key of batch.keys) {
        await conn.query('INSERT IGNORE INTO translations (lang, item_key, value) VALUES (?, ?, ?)', ['es', keys.ui(key), UI_STRINGS.es[key]]);
      }
    }
    await conn.query("INSERT INTO app_settings (setting_key, setting_value) VALUES (?, '1') ON DUPLICATE KEY UPDATE setting_value = '1'", [batch.flag]);
  }
}

module.exports = { seedCatalog, seedAddedWording, ADDED_WORDING, GROUPS, SERVICES };

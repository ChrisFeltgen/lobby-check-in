CREATE TABLE IF NOT EXISTS services (
  code VARCHAR(10) NOT NULL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  route VARCHAR(100) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS service_counters (
  service_code VARCHAR(10) NOT NULL,
  day DATE NOT NULL,
  seq INT NOT NULL DEFAULT 0,
  PRIMARY KEY (service_code, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tickets (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  service_code VARCHAR(10) NOT NULL,
  customer_name VARCHAR(100) NOT NULL,
  ticket_number VARCHAR(20) NOT NULL,
  status ENUM('waiting','called','serving','served','removed') NOT NULL DEFAULT 'waiting',
  counter VARCHAR(20) NULL,
  created_at DATETIME NOT NULL,
  called_at DATETIME NULL,
  completed_at DATETIME NULL,
  appointment_with VARCHAR(100) NULL,
  appointment_time VARCHAR(20) NULL,
  called_by VARCHAR(100) NULL,
  INDEX idx_queue (service_code, status, created_at),
  CONSTRAINT fk_tickets_service FOREIGN KEY (service_code) REFERENCES services (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO services (code, name, route, sort_order, active) VALUES
  ('BPI', 'Building Permits & Inspections', 'Building Dept.', 1, 1),
  ('BSC', 'Building Safety Compliance', 'Building Dept.', 5, 1),
  ('CR', 'Contractor Registration', 'Building Dept.', 6, 1),
  ('CE', 'Code Compliance', 'Code Enforcement', 3, 1),
  ('BTD', 'Business Tax Receipts', 'Business Tax Division', 2, 1),
  ('UF', 'Landscape and Urban Forestry', 'Planning & Zoning', 7, 1),
  ('LS', 'Lien Search & Expired Permits', 'Records & Alarms', 8, 1),
  ('ZD', 'Zoning', 'Planning & Zoning', 4, 1),
  ('AB', 'Alarm Billing', 'Records & Alarms', 9, 1),
  ('AC', 'Appointment Check-In', 'Appointment Questions', 10, 1)
ON DUPLICATE KEY UPDATE name = VALUES(name), route = VALUES(route), sort_order = VALUES(sort_order), active = VALUES(active);

-- Services that are no longer offered. Kept as rows so existing tickets still reference them.
UPDATE services SET active = 0 WHERE code IN ('PRM', 'LIC', 'UTL', 'CSH', 'PZ');

-- Recurring closures, e.g. "Code Compliance is closed 12pm-4pm on the 1st and 3rd Wednesday of
-- every month." Resolved against the current time by availability.js, not precomputed.
CREATE TABLE IF NOT EXISTS service_schedules (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  service_code VARCHAR(10) NOT NULL,
  message VARCHAR(200) NOT NULL,
  recurrence ENUM('weekly','monthly_nth') NOT NULL DEFAULT 'weekly',
  weekday TINYINT UNSIGNED NOT NULL,
  nth_weeks VARCHAR(20) NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  CONSTRAINT fk_schedules_service FOREIGN KEY (service_code) REFERENCES services (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Staff accounts. The server creates the first admin automatically from ADMIN_USERNAME / ADMIN_PASSWORD
-- the first time it starts with no admin account yet (see server.js).
CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(40) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('staff','manager','admin') NOT NULL DEFAULT 'staff',
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  last_login_at DATETIME NULL,
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Audit log: a record of who changed what. Written by the server. Read only by admins.
CREATE TABLE IF NOT EXISTS audit_log (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  created_at DATETIME NOT NULL,
  actor_name VARCHAR(100) NOT NULL,
  action VARCHAR(50) NOT NULL,
  target VARCHAR(200) NULL,
  detail VARCHAR(500) NULL,
  INDEX idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Settings the admins can change on the Settings tab. Defaults only fill in missing keys.
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(50) NOT NULL PRIMARY KEY,
  setting_value MEDIUMTEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES
  ('retention_days', '0'),
  ('retention_action', 'anonymize');

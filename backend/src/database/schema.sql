PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS salons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  slug        TEXT    NOT NULL UNIQUE,
  address     TEXT,
  phone       TEXT,
  qr_code     TEXT,
  created_at  TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  salon_id      INTEGER REFERENCES salons(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  username      TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK(role IN ('super_admin','owner','barber')),
  push_sub      TEXT,
  created_at    TEXT    DEFAULT (datetime('now')),
  UNIQUE(salon_id, username)
);

CREATE TABLE IF NOT EXISTS services (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  salon_id         INTEGER REFERENCES salons(id) ON DELETE CASCADE,
  barber_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name             TEXT    NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  price            REAL    NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS working_hours (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  barber_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  day_of_week  INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
  start_time   TEXT    NOT NULL DEFAULT '09:00',
  end_time     TEXT    NOT NULL DEFAULT '18:00',
  is_day_off   INTEGER NOT NULL DEFAULT 0,
  UNIQUE(barber_id, day_of_week)
);

CREATE TABLE IF NOT EXISTS holidays (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  barber_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT    NOT NULL,
  reason     TEXT,
  UNIQUE(barber_id, date)
);

CREATE TABLE IF NOT EXISTS bookings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  salon_id      INTEGER REFERENCES salons(id) ON DELETE CASCADE,
  barber_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  service_id    INTEGER REFERENCES services(id) ON DELETE SET NULL,
  client_name   TEXT    NOT NULL,
  client_phone  TEXT,
  date          TEXT    NOT NULL,
  time          TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','cancelled','completed')),
  notes         TEXT,
  created_at    TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ratings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id  INTEGER REFERENCES bookings(id) ON DELETE CASCADE UNIQUE,
  barber_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  stars       INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TEXT    DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO users (salon_id, name, username, password_hash, role)
VALUES (NULL, 'Super Admin', 'admin', '$2a$10$fOoZli/jEdIQu3r6Jrvnmua1pO5mdlc9sWlNREom.Jwk4lujqmqa.', 'super_admin');

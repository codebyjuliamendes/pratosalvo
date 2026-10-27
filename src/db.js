'use strict';

const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { customerKey } = require('./domain/reservation');

const hasColumn = (db, table, column) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some(c => c.name === column);
const randomToken = () => crypto.randomBytes(16).toString('base64url');
// "AAAA-MM-DD HH:MM:SS" ou ISO -> ISO UTC com milissegundos (mesmo formato de Date#toISOString).
const ISO = col => `COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', ${col}), ${col})`;

// Cada migração roda uma única vez, em ordem, controlada por PRAGMA user_version.
// Nunca altere uma migração já publicada: adicione uma nova ao final da lista.
const migrations = [
  // v1: esquema original. Bancos anteriores ao versionamento podem não ter status/cancelled_at.
  db => {
    db.exec(`CREATE TABLE IF NOT EXISTS offers (id INTEGER PRIMARY KEY, restaurant TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL, category TEXT NOT NULL, price_cents INTEGER NOT NULL, original_cents INTEGER NOT NULL,
        quantity INTEGER NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS reservations (id INTEGER PRIMARY KEY, offer_id INTEGER NOT NULL REFERENCES offers(id),
        customer TEXT NOT NULL, quantity INTEGER NOT NULL, code TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, cancelled_at TEXT);`);
    if (!hasColumn(db, 'reservations', 'status')) db.exec("ALTER TABLE reservations ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    if (!hasColumn(db, 'reservations', 'cancelled_at')) db.exec('ALTER TABLE reservations ADD COLUMN cancelled_at TEXT');
  },

  // v2: janela de retirada, chave de gestão do restaurante, ids públicos, código normalizado,
  // preço congelado na reserva, prazo da reserva e datas em ISO UTC.
  db => {
    db.exec(`
      ALTER TABLE offers ADD COLUMN pickup_from TEXT;
      ALTER TABLE offers ADD COLUMN manage_key_hash TEXT;
      ALTER TABLE reservations ADD COLUMN public_id TEXT;
      ALTER TABLE reservations ADD COLUMN code_key TEXT;
      ALTER TABLE reservations ADD COLUMN customer_key TEXT;
      ALTER TABLE reservations ADD COLUMN unit_price_cents INTEGER;
      ALTER TABLE reservations ADD COLUMN expires_at TEXT;
      ALTER TABLE reservations ADD COLUMN redeemed_at TEXT;

      UPDATE offers SET created_at = ${ISO('created_at')}, expires_at = ${ISO('expires_at')};
      UPDATE offers SET pickup_from = created_at WHERE pickup_from IS NULL;
      -- Chave de gestão desconhecida para ofertas antigas: nenhuma credencial existente é inventada.
      UPDATE offers SET manage_key_hash = lower(hex(randomblob(32))) WHERE manage_key_hash IS NULL;

      UPDATE reservations SET created_at = ${ISO('created_at')}, cancelled_at = ${ISO('cancelled_at')};
      UPDATE reservations SET code_key = upper(replace(replace(code, 'PS-', ''), '-', ''));
      UPDATE reservations SET
        unit_price_cents = (SELECT price_cents FROM offers o WHERE o.id = reservations.offer_id),
        expires_at = (SELECT expires_at FROM offers o WHERE o.id = reservations.offer_id);
    `);
    // Em JS: mesma normalização Unicode usada nas reservas novas.
    const rows = db.prepare('SELECT id, customer FROM reservations').all();
    const update = db.prepare('UPDATE reservations SET public_id = ?, customer_key = ? WHERE id = ?');
    for (const row of rows) update.run(randomToken(), customerKey(row.customer), row.id);

    db.exec(`
      CREATE UNIQUE INDEX idx_offers_manage_key ON offers(manage_key_hash);
      CREATE INDEX idx_offers_expires ON offers(expires_at);
      CREATE UNIQUE INDEX idx_reservations_public_id ON reservations(public_id);
      CREATE UNIQUE INDEX idx_reservations_code_key ON reservations(code_key);
      CREATE INDEX idx_reservations_offer_customer ON reservations(offer_id, customer_key, status);
      CREATE INDEX idx_reservations_status_expires ON reservations(status, expires_at);
      -- Defesa em profundidade contra overbooking: estoque nunca fica negativo.
      CREATE TRIGGER offers_quantity_non_negative BEFORE UPDATE OF quantity ON offers
        WHEN NEW.quantity < 0 BEGIN SELECT RAISE(ABORT, 'offer quantity cannot be negative'); END;
      CREATE TRIGGER reservations_status_valid BEFORE UPDATE OF status ON reservations
        WHEN NEW.status NOT IN ('active', 'cancelled', 'redeemed', 'expired') BEGIN SELECT RAISE(ABORT, 'invalid reservation status'); END;
    `);
  },
];

// A versão é lida dentro de uma transação IMMEDIATE: dois processos subindo juntos não aplicam a mesma migração.
const step = db =>
  db
    .transaction(() => {
      const version = db.pragma('user_version', { simple: true });
      if (version >= migrations.length) return false;
      migrations[version](db);
      db.pragma(`user_version = ${version + 1}`);
      return true;
    })
    .immediate();

function migrate(db) {
  while (step(db));
}

function openDatabase(filename) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

module.exports = { openDatabase, migrate, SCHEMA_VERSION: migrations.length };

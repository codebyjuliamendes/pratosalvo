'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { migrate, SCHEMA_VERSION } = require('../src/db');
const { createStore } = require('../src/store');

// Esquema da primeira versão publicada (sem user_version, sem status/cancelled_at).
const LEGACY_SCHEMA = `
  CREATE TABLE offers(id INTEGER PRIMARY KEY, restaurant TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
    category TEXT NOT NULL, price_cents INTEGER NOT NULL, original_cents INTEGER NOT NULL, quantity INTEGER NOT NULL,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE reservations(id INTEGER PRIMARY KEY, offer_id INTEGER NOT NULL REFERENCES offers(id), customer TEXT NOT NULL,
    quantity INTEGER NOT NULL, code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  INSERT INTO offers (restaurant, title, description, category, price_cents, original_cents, quantity, expires_at, created_at) VALUES
    ('Pão & Prosa', 'Kit de pães', 'Pães do dia.', 'Padaria', 1290, 2600, 3, '2026-10-27T18:00:00.000Z', '2026-10-27 12:00:00'),
    ('Verde Vivo', 'Bowl', 'Grãos e legumes.', 'Refeição', 1890, 3500, 1, '2026-10-27T13:00:00.000Z', '2026-10-27 11:00:00');
  INSERT INTO reservations (offer_id, customer, quantity, code, created_at) VALUES
    (1, 'Ána', 2, 'PS-1A2B3C', '2026-10-27 12:30:00'),
    (2, 'Bia', 1, 'PS-D4E5F6', '2026-10-27 11:30:00');
`;

test('migra banco legado preservando dados e preparando as novas regras', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(LEGACY_SCHEMA);

  migrate(db);
  migrate(db); // idempotente
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);

  const offer = db.prepare('SELECT * FROM offers WHERE id = 1').get();
  assert.equal(offer.created_at, '2026-10-27T12:00:00.000Z');
  assert.equal(offer.pickup_from, '2026-10-27T12:00:00.000Z');
  assert.match(offer.manage_key_hash, /^[0-9a-f]{64}$/);

  const legacy = db.prepare('SELECT * FROM reservations WHERE id = 1').get();
  assert.deepEqual(
    [legacy.status, legacy.code_key, legacy.customer_key, legacy.unit_price_cents, legacy.expires_at, legacy.created_at],
    ['active', '1A2B3C', 'ána', 1290, '2026-10-27T18:00:00.000Z', '2026-10-27T12:30:00.000Z'],
  );
  assert.match(legacy.public_id, /^[A-Za-z0-9_-]{22}$/);

  const store = createStore(db);
  const now = new Date('2026-10-27T14:00:00.000Z');
  // A reserva da oferta já encerrada (13:00Z) expira e devolve a unidade; a outra segue ativa.
  const [active] = store.reservationsByIds([legacy.public_id], now);
  assert.deepEqual([active.code, active.status, active.totalCents], ['PS-1A2B3C', 'active', 2580]);
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = 2').pluck().get(), 'expired');
  assert.equal(db.prepare('SELECT quantity FROM offers WHERE id = 2').pluck().get(), 2);
  assert.deepEqual(
    store.listOffers(now).map(o => o.id),
    [1],
  );
});

test('banco que já tinha status/cancelled_at também migra', () => {
  const db = new Database(':memory:');
  db.exec(LEGACY_SCHEMA);
  db.exec(
    "ALTER TABLE reservations ADD COLUMN status TEXT NOT NULL DEFAULT 'active'; ALTER TABLE reservations ADD COLUMN cancelled_at TEXT;",
  );
  db.exec("UPDATE reservations SET status = 'cancelled', cancelled_at = '2026-10-27 12:40:00' WHERE id = 1");
  migrate(db);
  const row = db.prepare('SELECT status, cancelled_at FROM reservations WHERE id = 1').get();
  assert.deepEqual(row, { status: 'cancelled', cancelled_at: '2026-10-27T12:40:00.000Z' });
});

test('status inválido é barrado pelo banco', () => {
  const db = new Database(':memory:');
  migrate(db);
  db.exec(`INSERT INTO offers (restaurant, title, description, category, price_cents, original_cents, quantity, expires_at)
    VALUES ('a', 'b', 'c', 'Outros', 1, 2, 1, '2099-01-01T00:00:00.000Z');
    INSERT INTO reservations (offer_id, customer, quantity, code, public_id, code_key) VALUES (1, 'x', 1, 'PS-1', 'p', 'k');`);
  assert.throws(() => db.exec("UPDATE reservations SET status = 'perdida'"), /invalid reservation status/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { openDatabase } = require('../src/db');
const { createStore } = require('../src/store');

const run = promisify(execFile);
const WORKER = path.join(__dirname, 'fixtures', 'reserve-worker.js');

test('vários processos disputando o mesmo estoque não causam overbooking', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pratosalvo-race-'));
  try {
    const databasePath = path.join(dir, 'race.sqlite');
    const db = openDatabase(databasePath);
    const now = new Date();
    const { id } = createStore(db).createOffer(
      {
        restaurant: 'Corrida',
        title: 'Últimas marmitas',
        description: 'Disputa entre processos.',
        category: 'Refeição',
        priceCents: 1000,
        originalCents: 2000,
        quantity: 12,
        pickupFrom: now,
        pickupUntil: new Date(now.getTime() + 3_600_000),
      },
      now,
    );
    db.close();

    const startAt = Date.now() + 700;
    const workers = Array.from({ length: 6 }, (_, w) =>
      run(process.execPath, [WORKER, databasePath, String(id), '8', String(startAt), String(w)]).then(({ stdout }) => JSON.parse(stdout)),
    );
    const results = await Promise.all(workers);

    assert.deepEqual(
      results.flatMap(r => r.other),
      [],
    );
    assert.equal(
      results.reduce((sum, r) => sum + r.ok, 0),
      12,
    );
    assert.equal(
      results.reduce((sum, r) => sum + r.soldOut, 0),
      6 * 8 - 12,
    );

    const check = openDatabase(databasePath);
    assert.equal(check.prepare('SELECT quantity FROM offers WHERE id = ?').pluck().get(id), 0);
    assert.equal(check.prepare('SELECT SUM(quantity) FROM reservations WHERE offer_id = ?').pluck().get(id), 12);
    assert.equal(check.prepare('SELECT COUNT(DISTINCT code_key) FROM reservations').pluck().get(), 12);
    check.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trigger impede estoque negativo mesmo fora do fluxo de reserva', () => {
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO offers (restaurant, title, description, category, price_cents, original_cents, quantity, expires_at) VALUES ('a','b','c','Outros',1,2,1,'2099-01-01T00:00:00.000Z')",
  ).run();
  assert.throws(() => db.prepare('UPDATE offers SET quantity = quantity - 2').run(), /cannot be negative/);
});

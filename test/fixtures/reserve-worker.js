'use strict';

// Processo independente disputando o mesmo arquivo SQLite (usado por concurrency.test.js).
const { openDatabase } = require('../../src/db');
const { createStore } = require('../../src/store');
const { customerKey } = require('../../src/domain/reservation');

const [databasePath, offerId, attempts, startAt, worker] = process.argv.slice(2);
const store = createStore(openDatabase(databasePath), { maxUnitsPerCustomer: 10 });
const result = { ok: 0, soldOut: 0, other: [] };

// Largada sincronizada entre os processos.
while (Date.now() < Number(startAt)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);

for (let i = 0; i < Number(attempts); i++) {
  const customer = `Worker ${worker} cliente ${i}`;
  try {
    store.reserve(Number(offerId), { customer, customerKey: customerKey(customer), quantity: 1 }, new Date());
    result.ok++;
  } catch (err) {
    if (err.details?.code === 'sold_out') result.soldOut++;
    else result.other.push(err.code || err.message);
  }
}
process.stdout.write(JSON.stringify(result));

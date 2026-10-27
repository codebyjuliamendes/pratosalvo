'use strict';

// Smoke test ponta a ponta contra uma instância no ar: publica, reserva, valida no balcão.
// Uso: node scripts/smoke.js http://127.0.0.1:3001
const base = process.argv[2] || 'http://127.0.0.1:3001';

async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error}`);
  return data;
}

async function main() {
  const offer = await call('POST', '/api/offers', {
    restaurant: 'Smoke Test',
    title: 'Marmita de verificação',
    description: 'Criada pelo smoke test.',
    category: 'Outros',
    price: '9,90',
    originalPrice: '20,00',
    quantity: 2,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const reservation = await call('POST', `/api/offers/${offer.id}/reservations`, { customer: 'Smoke', quantity: 1 });
  const redeemed = await call('POST', '/api/redemptions', { code: reservation.code, manageKeys: [offer.manageKey] });
  if (redeemed.status !== 'redeemed') throw new Error(`status inesperado: ${redeemed.status}`);
  console.log(JSON.stringify({ msg: 'smoke_ok', offerId: offer.id }));
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});

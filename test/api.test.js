'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

const HOUR = 3_600_000;
// Relógio controlado: os testes avançam o tempo para exercitar janela e expiração.
let now = new Date('2026-10-27T15:00:00.000Z');
const clock = () => new Date(now);
const advance = ms => (now = new Date(now.getTime() + ms));
const inHours = h => new Date(now.getTime() + h * HOUR).toISOString();

let server, baseUrl, db;

test.before(async () => {
  db = openDatabase(':memory:');
  server = createApp(db, { clock, holdMinutes: 60, maxUnitsPerCustomer: 5 }).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function request(method, url, body) {
  const response = await fetch(baseUrl + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : body && JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

const validOffer = (overrides = {}) => ({
  restaurant: 'Cantina Teste',
  title: 'Marmita do dia',
  description: 'Arroz, feijão e legumes.',
  category: 'Refeição',
  price: '12,90',
  originalPrice: 26,
  quantity: 5,
  expiresAt: inHours(3),
  ...overrides,
});

async function createOffer(overrides) {
  const { status, body } = await request('POST', '/api/offers', validOffer(overrides));
  assert.equal(status, 201, JSON.stringify(body));
  return body;
}

const reserve = (offerId, customer = 'Ana', quantity = 1) => request('POST', `/api/offers/${offerId}/reservations`, { customer, quantity });
const offerById = async id => (await request('GET', '/api/offers?include=sold_out')).body.find(o => o.id === id);
const redeem = (code, manageKey) => request('POST', '/api/redemptions', { code, manageKeys: [manageKey] });

test('health check responde ok com cabeçalhos de segurança', async () => {
  const { status, headers, body } = await request('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
  assert.match(headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  assert.equal(headers.get('cache-control'), 'no-store');
  const csp = headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.equal(headers.get('x-powered-by'), null);
});

test('publica oferta com preços em centavos exatos e devolve a chave de gestão uma vez', async () => {
  const created = await createOffer({ price: 1.15, originalPrice: '2,30' });
  assert.ok(Number.isInteger(created.id));
  assert.match(created.manageKey, /^[A-Za-z0-9_-]{22}$/);
  const offer = await offerById(created.id);
  assert.deepEqual([offer.priceCents, offer.originalCents, offer.discountPercent, offer.soldOut], [115, 230, 50, false]);
  assert.equal(offer.manageKey, undefined);
  assert.equal(JSON.stringify(offer).includes(created.manageKey), false);
});

test('validação de oferta: textos, categoria, preços, quantidade e horário', async () => {
  const cases = [
    [{ restaurant: 'A' }, /restaurante/],
    [{ description: 'x'.repeat(221) }, /descrição/],
    [{ category: 'Bebidas' }, /categoria/],
    [{ price: 1.005 }, /preços/],
    [{ price: 30, originalPrice: 26 }, /menor que o preço original/],
    [{ quantity: 0 }, /unidades/],
    [{ quantity: 2.5 }, /unidades/],
    [{ expiresAt: 'amanhã' }, /retirada/],
    [{ expiresAt: inHours(-1) }, /retirada/],
  ];
  for (const [overrides, pattern] of cases) {
    const { status, body } = await request('POST', '/api/offers', validOffer(overrides));
    assert.equal(status, 400, JSON.stringify(overrides));
    assert.match(body.error, pattern);
  }
});

test('horário sem fuso é interpretado no fuso da loja (America/Sao_Paulo)', async () => {
  // 15:00Z = 12:00 em São Paulo. "18:00" local => 21:00Z.
  const created = await createOffer({ expiresAt: '2026-10-27T18:00' });
  assert.equal((await offerById(created.id)).expiresAt, '2026-10-27T21:00:00.000Z');
});

test('textos são devolvidos como dados (o frontend escapa); sem HTML executável na API', async () => {
  const created = await createOffer({ title: '<img src=x onerror=alert(1)>' });
  const offer = await offerById(created.id);
  assert.equal(offer.title, '<img src=x onerror=alert(1)>');
  const res = await fetch(`${baseUrl}/api/offers`);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('reserva gera código não sequencial, congela preço e decrementa estoque', async () => {
  const { id } = await createOffer({ quantity: 4 });
  const first = await reserve(id, 'Ana', 2);
  const second = await reserve(id, 'Bia', 1);
  assert.equal(first.status, 201);
  assert.match(first.body.code, /^PS-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
  assert.notEqual(first.body.code, second.body.code);
  assert.match(first.body.id, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual([first.body.status, first.body.unitPriceCents, first.body.totalCents], ['active', 1290, 2580]);
  assert.equal(first.body.expiresAt, inHours(1)); // tolerância de 60 min
  assert.equal((await offerById(id)).quantity, 1);
});

test('não reserva mais do que o estoque e marca a oferta como esgotada', async () => {
  const { id } = await createOffer({ quantity: 2 });
  const tooMany = await reserve(id, 'Ana', 3);
  assert.equal(tooMany.status, 409);
  assert.deepEqual([tooMany.body.code, tooMany.body.available], ['sold_out', 2]);
  assert.equal((await reserve(id, 'Ana', 2)).status, 201);
  const soldOut = await reserve(id, 'Bia', 1);
  assert.equal(soldOut.status, 409);
  assert.match(soldOut.body.error, /esgotar/);
  assert.equal(
    (await request('GET', '/api/offers')).body.some(o => o.id === id),
    false,
  );
  const listed = await offerById(id);
  assert.deepEqual([listed.quantity, listed.soldOut], [0, true]);
});

test('reservas simultâneas nunca ultrapassam o estoque', async () => {
  const { id } = await createOffer({ quantity: 7 });
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => reserve(id, `Cliente ${i}`, 1)));
  assert.equal(results.filter(r => r.status === 201).length, 7);
  assert.ok(results.filter(r => r.status !== 201).every(r => r.status === 409 && r.body.code === 'sold_out'));
  assert.equal((await offerById(id)).quantity, 0);
  const reserved = db.prepare("SELECT SUM(quantity) FROM reservations WHERE offer_id = ? AND status = 'active'").pluck().get(id);
  assert.equal(reserved, 7);
});

test('limite por cliente soma reservas anteriores e ignora maiúsculas', async () => {
  const { id } = await createOffer({ quantity: 20 });
  assert.equal((await reserve(id, 'Carla Dias', 4)).status, 201);
  const over = await reserve(id, 'carla  DIAS', 2);
  assert.equal(over.status, 409);
  assert.deepEqual([over.body.code, over.body.remaining], ['customer_limit', 1]);
  assert.equal((await reserve(id, 'Carla Dias', 1)).status, 201);
  assert.equal((await reserve(id, 'Outra Pessoa', 5)).status, 201);
});

test('validação de reserva: nome, quantidade e oferta', async () => {
  const { id } = await createOffer();
  assert.equal((await reserve(id, 'A', 1)).status, 400);
  assert.equal((await reserve(id, 'Ana', 0)).status, 400);
  assert.equal((await reserve(id, 'Ana', 1.5)).status, 400);
  assert.equal((await reserve(id, 'Ana', 11)).status, 400);
  assert.equal((await reserve(999999, 'Ana', 1)).status, 404);
  assert.equal((await reserve('abc', 'Ana', 1)).status, 404);
});

test('reservas são privadas: sem listagem global e só por id secreto', async () => {
  const { id } = await createOffer();
  const made = (await reserve(id, 'Dora', 1)).body;
  assert.deepEqual((await request('GET', '/api/reservations')).body, []);
  const mine = await request('GET', `/api/reservations?ids=${made.id},invalido,${'x'.repeat(200)}`);
  assert.deepEqual(
    mine.body.map(r => [r.id, r.code, r.title]),
    [[made.id, made.code, 'Marmita do dia']],
  );
  assert.equal((await request('GET', `/api/reservations/${made.id}`)).body.code, made.code);
  const rowId = db.prepare('SELECT id FROM reservations WHERE public_id = ?').pluck().get(made.id);
  assert.equal((await request('GET', `/api/reservations/${rowId}`)).status, 404);
  assert.equal((await request('POST', `/api/reservations/${rowId}/cancel`)).status, 404);
});

test('cancelamento devolve estoque uma única vez', async () => {
  const { id } = await createOffer({ quantity: 3 });
  const made = (await reserve(id, 'Eva', 2)).body;
  const cancelled = await request('POST', `/api/reservations/${made.id}/cancel`);
  assert.deepEqual([cancelled.status, cancelled.body.restocked], [200, 2]);
  assert.equal((await offerById(id)).quantity, 3);
  const again = await request('POST', `/api/reservations/${made.id}/cancel`);
  assert.deepEqual([again.status, again.body.error], [409, 'Esta reserva já foi cancelada.']);
  assert.equal((await offerById(id)).quantity, 3);
  assert.equal((await request('GET', `/api/reservations/${made.id}`)).body.status, 'cancelled');
});

test('validação no balcão: só o restaurante dono, uma única vez', async () => {
  const mineOffer = await createOffer();
  const otherOffer = await createOffer({ restaurant: 'Outro Lugar' });
  const made = (await reserve(mineOffer.id, 'Fabi', 2)).body;

  assert.equal((await redeem(made.code, otherOffer.manageKey)).status, 404);
  assert.equal((await redeem('PS-ZZZZ-ZZZZ', mineOffer.manageKey)).status, 404);
  assert.equal((await redeem('???', mineOffer.manageKey)).status, 400);
  assert.equal((await request('POST', '/api/redemptions', { code: made.code })).status, 400);

  const typed = made.code.toLowerCase().replace(/-/g, ' ');
  const ok = await redeem(typed, mineOffer.manageKey);
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.status, ok.body.customer, ok.body.quantity, ok.body.totalCents], ['redeemed', 'Fabi', 2, 2580]);
  assert.ok(ok.body.redeemedAt);
  assert.equal(ok.body.id, undefined, 'restaurante não recebe o id (credencial) da reserva');

  const twice = await redeem(made.code, mineOffer.manageKey);
  assert.deepEqual([twice.status, twice.body.status, twice.body.error], [409, 'redeemed', 'Esta reserva já foi retirada.']);
  // Retirada não pode ser cancelada nem devolve estoque.
  assert.equal((await request('POST', `/api/reservations/${made.id}/cancel`)).status, 409);
  assert.equal((await offerById(mineOffer.id)).quantity, 3);
});

test('validações simultâneas do mesmo código: só uma passa', async () => {
  const offer = await createOffer();
  const made = (await reserve(offer.id, 'Gabi', 1)).body;
  const results = await Promise.all(Array.from({ length: 10 }, () => redeem(made.code, offer.manageKey)));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 9);
});

test('reserva cancelada não pode ser retirada', async () => {
  const offer = await createOffer();
  const made = (await reserve(offer.id, 'Helena', 1)).body;
  await request('POST', `/api/reservations/${made.id}/cancel`);
  const res = await redeem(made.code, offer.manageKey);
  assert.deepEqual([res.status, res.body.error], [409, 'Esta reserva já foi cancelada.']);
});

test('janela futura: reserva antecipada, retirada só depois do início', async () => {
  const offer = await createOffer({ pickupFrom: inHours(2), expiresAt: inHours(4) });
  const made = (await reserve(offer.id, 'Iris', 1)).body;
  assert.equal(made.expiresAt, inHours(3)); // início + 60 min
  const early = await redeem(made.code, offer.manageKey);
  assert.deepEqual([early.status, /ainda não começou/.test(early.body.error)], [409, true]);
  advance(2 * HOUR);
  assert.equal((await redeem(made.code, offer.manageKey)).status, 200);
});

test('reserva vencida expira, devolve estoque e não pode ser retirada nem cancelada', async () => {
  const offer = await createOffer({ quantity: 3, expiresAt: inHours(5) });
  const made = (await reserve(offer.id, 'Joana', 2)).body;
  assert.equal((await offerById(offer.id)).quantity, 1);
  advance(61 * 60_000);
  assert.equal((await offerById(offer.id)).quantity, 3);
  assert.equal((await request('GET', `/api/reservations/${made.id}`)).body.status, 'expired');
  const late = await redeem(made.code, offer.manageKey);
  assert.deepEqual([late.status, late.body.status], [409, 'expired']);
  const cancel = await request('POST', `/api/reservations/${made.id}/cancel`);
  assert.equal(cancel.status, 409);
  assert.match(cancel.body.error, /prazo de retirada terminou/);
  assert.equal((await offerById(offer.id)).quantity, 3);
});

test('oferta vencida sai da vitrine e não aceita reservas', async () => {
  const offer = await createOffer({ expiresAt: inHours(1) });
  advance(HOUR);
  assert.equal(
    (await request('GET', '/api/offers?include=sold_out')).body.some(o => o.id === offer.id),
    false,
  );
  const res = await reserve(offer.id, 'Kátia', 1);
  assert.deepEqual([res.status, res.body.code], [409, 'offer_closed']);
});

test('painel do restaurante lista só as próprias ofertas com contadores', async () => {
  const offer = await createOffer({ quantity: 6 });
  await createOffer({ restaurant: 'Concorrente' });
  const a = (await reserve(offer.id, 'Lia', 2)).body;
  await reserve(offer.id, 'Mel', 1);
  await redeem(a.code, offer.manageKey);
  const { status, body } = await request('POST', '/api/offers/manage', { manageKeys: [offer.manageKey, 'chave-invalida'] });
  assert.equal(status, 200);
  assert.deepEqual(
    body.map(o => [o.id, o.quantity, o.reservedUnits, o.redeemedUnits, o.closed]),
    [[offer.id, 3, 1, 2, false]],
  );
  assert.equal((await request('POST', '/api/offers/manage', {})).status, 400);
});

test('regras públicas para o frontend', async () => {
  const { status, body } = await request('GET', '/api/rules');
  assert.deepEqual([status, body], [200, { maxUnitsPerCustomer: 5, holdMinutes: 60, timeZone: 'America/Sao_Paulo' }]);
});

test('erros sempre em JSON', async () => {
  const malformed = await request('POST', '/api/offers', '{"restaurant":');
  assert.deepEqual([malformed.status, malformed.body.error], [400, 'O corpo da requisição não é um JSON válido.']);
  const big = await request('POST', '/api/offers', { description: 'x'.repeat(30_000) });
  assert.equal(big.status, 413);
  const missing = await request('GET', '/api/nao-existe');
  assert.deepEqual([missing.status, missing.body.error], [404, 'Rota da API não encontrada.']);
});

test('frontend servido com CSP e sem estilos/scripts inline', async () => {
  const res = await fetch(`${baseUrl}/`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(html, /<script>(?!<\/script>)|<script(?![^>]*src=)[^>]*>/);
  assert.doesNotMatch(html, /style=|<style/);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
});

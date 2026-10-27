'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ValidationError, ConflictError } = require('../src/domain/errors');
const { parseAmountToCents, discountPercent, validatePricing, totalCents } = require('../src/domain/pricing');
const { parseInstant, buildPickupWindow, reservationDeadline, redemptionState, isOpenForReservation } = require('../src/domain/pickup');
const {
  CODE_ALPHABET,
  generateCodeKey,
  formatCode,
  codeCandidates,
  customerKey,
  assertCustomerLimit,
} = require('../src/domain/reservation');

const at = iso => new Date(iso);

test('parseAmountToCents converte formatos comuns sem erro de ponto flutuante', () => {
  assert.equal(parseAmountToCents(12.9), 1290);
  assert.equal(parseAmountToCents('12,90'), 1290);
  assert.equal(parseAmountToCents('R$ 1.234,56'), 123456);
  assert.equal(parseAmountToCents(1.15), 115);
  assert.equal(parseAmountToCents(0.29), 29);
  assert.equal(parseAmountToCents('35'), 3500);
});

test('parseAmountToCents rejeita entradas inválidas em vez de arredondar', () => {
  for (const value of [1.005, '1,005', '-5', 'abc', '', NaN, Infinity, null, undefined, {}, '1e3']) {
    assert.equal(parseAmountToCents(value), null, `deveria rejeitar ${String(value)}`);
  }
});

test('desconto arredonda para baixo e nunca exagera', () => {
  assert.equal(discountPercent(1290, 2600), 50); // 50,38%
  assert.equal(discountPercent(1890, 3500), 46); // 46,0%
  assert.equal(discountPercent(999, 1000), 0); // 0,1%
  assert.equal(discountPercent(1000, 1000), 0);
  assert.equal(totalCents(1290, 3), 3870);
});

test('validatePricing exige centavos inteiros, limites e desconto real', () => {
  assert.deepEqual(validatePricing(1290, 2600), { priceCents: 1290, originalCents: 2600, discountPercent: 50 });
  assert.throws(() => validatePricing(2600, 2600), /menor que o preço original/);
  assert.throws(() => validatePricing(999, 1000), /menor que o preço original/);
  assert.throws(() => validatePricing(0, 100), ValidationError);
  assert.throws(() => validatePricing(null, 100), ValidationError);
  assert.throws(() => validatePricing(100, 200_001), ValidationError);
});

test('parseInstant respeita o fuso informado e o da loja quando não há deslocamento', () => {
  assert.equal(parseInstant('2026-10-27T22:30:00.000Z', 'America/Sao_Paulo').toISOString(), '2026-10-27T22:30:00.000Z');
  assert.equal(parseInstant('2026-10-27T19:30-03:00', 'UTC').toISOString(), '2026-10-27T22:30:00.000Z');
  // datetime-local sem fuso: 19:30 em São Paulo (UTC−3) é 22:30Z, não 19:30Z.
  assert.equal(parseInstant('2026-10-27T19:30', 'America/Sao_Paulo').toISOString(), '2026-10-27T22:30:00.000Z');
  assert.equal(parseInstant('2026-01-15T12:00', 'Europe/Lisbon').toISOString(), '2026-01-15T12:00:00.000Z');
  assert.equal(parseInstant('2026-07-15T12:00', 'Europe/Lisbon').toISOString(), '2026-07-15T11:00:00.000Z');
  for (const bad of ['2026-02-30T10:00', '2026-10-27T25:00', 'amanhã', '', 1730000000000, null, '2026-10-27']) {
    assert.equal(parseInstant(bad, 'America/Sao_Paulo'), null, `deveria rejeitar ${String(bad)}`);
  }
});

test('janela de retirada: início no passado vira agora, mínimo de 10 minutos e máximo de 7 dias', () => {
  const now = at('2026-10-27T12:00:00Z');
  const window = buildPickupWindow({ from: at('2026-10-27T10:00:00Z'), until: at('2026-10-27T15:00:00Z'), now });
  assert.equal(window.pickupFrom.toISOString(), now.toISOString());
  const later = buildPickupWindow({ from: at('2026-10-27T18:00:00Z'), until: at('2026-10-27T20:00:00Z'), now });
  assert.equal(later.pickupFrom.toISOString(), '2026-10-27T18:00:00.000Z');
  assert.throws(() => buildPickupWindow({ until: at('2026-10-27T12:05:00Z'), now }), /pelo menos 10 minutos/);
  assert.throws(() => buildPickupWindow({ until: at('2026-10-27T11:00:00Z'), now }), ValidationError);
  assert.throws(() => buildPickupWindow({ from: at('2026-10-27T20:00:00Z'), until: at('2026-10-27T19:00:00Z'), now }), ValidationError);
  assert.throws(() => buildPickupWindow({ until: at('2026-11-05T12:00:00Z'), now }), /7 dias/);
  assert.throws(() => buildPickupWindow({ until: undefined, now }), ValidationError);
});

test('prazo da reserva: tolerância a partir do início da janela, limitada ao fim', () => {
  const pickupFrom = at('2026-10-27T18:00:00Z');
  const pickupUntil = at('2026-10-27T21:00:00Z');
  const deadline = now => reservationDeadline({ now: at(now), pickupFrom, pickupUntil, holdMinutes: 90 }).toISOString();
  assert.equal(deadline('2026-10-27T12:00:00Z'), '2026-10-27T19:30:00.000Z'); // reserva antes da janela
  assert.equal(deadline('2026-10-27T18:30:00Z'), '2026-10-27T20:00:00.000Z');
  assert.equal(deadline('2026-10-27T20:15:00Z'), '2026-10-27T21:00:00.000Z'); // limitado ao fim
  assert.equal(isOpenForReservation(pickupUntil, at('2026-10-27T20:59:59Z')), true);
  assert.equal(isOpenForReservation(pickupUntil, pickupUntil), false);
});

test('estado da retirada no balcão', () => {
  const pickupFrom = at('2026-10-27T18:00:00Z');
  const deadline = at('2026-10-27T19:30:00Z');
  assert.equal(redemptionState({ now: at('2026-10-27T17:59:00Z'), pickupFrom, deadline }), 'too_early');
  assert.equal(redemptionState({ now: at('2026-10-27T18:00:00Z'), pickupFrom, deadline }), 'ok');
  assert.equal(redemptionState({ now: deadline, pickupFrom, deadline }), 'expired');
});

test('código de retirada: alfabeto sem caracteres ambíguos e formato legível', () => {
  assert.equal(CODE_ALPHABET.length, 30);
  assert.doesNotMatch(CODE_ALPHABET, /[01OIUL]/);
  const keys = new Set(Array.from({ length: 2000 }, () => generateCodeKey()));
  assert.ok(keys.size >= 1999, 'códigos aleatórios não devem se repetir em pequena amostra');
  for (const key of keys) assert.match(key, /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
  assert.equal(formatCode('K7MP3QXA'), 'PS-K7MP-3QXA');
  assert.equal(formatCode('1A2B3C'), 'PS-1A2B3C');
  // Sequência determinística prova que o gerador usa a fonte injetada (crypto.randomInt por padrão).
  let i = 0;
  assert.equal(
    generateCodeKey(() => i++),
    '23456789',
  );
});

test('código digitado é normalizado com tolerância a erros comuns', () => {
  assert.deepEqual(codeCandidates('PS-K7MP-3QXA'), ['K7MP3QXA']);
  assert.deepEqual(codeCandidates(' ps k7mp 3qxa '), ['K7MP3QXA']);
  assert.deepEqual(codeCandidates('K7MP3QXA'), ['K7MP3QXA']);
  assert.deepEqual(codeCandidates('PSAB3QXA'), ['PSAB3QXA']);
  assert.deepEqual(codeCandidates('PSAB3C2D'), ['PSAB3C2D', 'AB3C2D']); // ambíguo: testa as duas leituras
  assert.deepEqual(codeCandidates('PS-1A2B3C'), ['1A2B3C']); // legado
  assert.deepEqual(codeCandidates('PS-1A2B3O'), ['1A2B30']); // O digitado no lugar de 0
  for (const bad of ['', 'PS-', 'abc', 'PS-K7MP-3QXA-EXTRA-LONGO', null, 12345678, '<script>']) {
    assert.deepEqual(codeCandidates(bad), [], `deveria rejeitar ${String(bad)}`);
  }
});

test('limite por cliente considera reservas anteriores', () => {
  assert.equal(customerKey('Ána Maria'), customerKey('ÁNA MARIA'));
  assert.doesNotThrow(() => assertCustomerLimit({ alreadyReserved: 3, requested: 2, limit: 5 }));
  assert.throws(
    () => assertCustomerLimit({ alreadyReserved: 3, requested: 3, limit: 5 }),
    err => err instanceof ConflictError && /ainda pode reservar 2/.test(err.message) && err.details.remaining === 2,
  );
  assert.throws(() => assertCustomerLimit({ alreadyReserved: 5, requested: 1, limit: 5 }), /já reservou o máximo/);
});

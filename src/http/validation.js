'use strict';

const { ValidationError } = require('../domain/errors');
const { parseAmountToCents, validatePricing } = require('../domain/pricing');
const { parseInstant, buildPickupWindow } = require('../domain/pickup');
const { MAX_UNITS_PER_RESERVATION, codeCandidates, customerKey } = require('../domain/reservation');

const CATEGORIES = ['Refeição', 'Padaria', 'Doces', 'Outros'];
const MAX_OFFER_UNITS = 100;
const MAX_KEYS = 50;
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

// Remove controles (exceto espaço) e normaliza espaços.
const cleanText = value =>
  typeof value === 'string'
    ? value
        .normalize('NFC')
        .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ')
    : '';

/** Inteiro positivo vindo de rota/JSON; null se inválido. */
function parseId(value) {
  const id = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Aceita 3 ou "3" (formulários enviam texto); rejeita "3.5", "3abc", 3.5.
const toInt = value => (typeof value === 'string' && /^\d{1,6}$/.test(value.trim()) ? Number(value) : value);

const parseToken = value => (typeof value === 'string' && TOKEN.test(value) ? value : null);

/** Lista de tokens (array ou "a,b,c"); inválidos descartados, únicos, no máximo 50. */
function parseTokens(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(list.map(parseToken).filter(Boolean))].slice(0, MAX_KEYS);
}

function text(body, field, { min, max, label }) {
  const value = cleanText(body?.[field]);
  if (value.length < min || value.length > max) throw new ValidationError(`${label} deve ter entre ${min} e ${max} caracteres.`);
  return value;
}

/** Corpo de POST /api/offers no formato persistido pelo store. */
function parseOfferInput(body, { now, timeZone }) {
  const restaurant = text(body, 'restaurant', { min: 2, max: 60, label: 'O nome do restaurante' });
  const title = text(body, 'title', { min: 2, max: 80, label: 'O nome do prato' });
  const description = text(body, 'description', { min: 2, max: 220, label: 'A descrição' });
  const category = cleanText(body?.category) || 'Outros';
  if (!CATEGORIES.includes(category)) throw new ValidationError(`Escolha uma categoria: ${CATEGORIES.join(', ')}.`);

  const { priceCents, originalCents } = validatePricing(parseAmountToCents(body?.price), parseAmountToCents(body?.originalPrice));

  const quantity = toInt(body?.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_OFFER_UNITS) {
    throw new ValidationError(`Informe de 1 a ${MAX_OFFER_UNITS} unidades disponíveis.`);
  }

  const rawFrom = body?.pickupFrom;
  const from = rawFrom === undefined || rawFrom === null || rawFrom === '' ? null : parseInstant(rawFrom, timeZone);
  if (from === null && rawFrom) throw new ValidationError('O início da retirada é inválido.');
  const until = parseInstant(body?.expiresAt, timeZone);
  const { pickupFrom, pickupUntil } = buildPickupWindow({ from, until: until ?? undefined, now });

  return { restaurant, title, description, category, priceCents, originalCents, quantity, pickupFrom, pickupUntil };
}

/** Corpo de POST /api/offers/:id/reservations. */
function parseReservationInput(body) {
  const customer = cleanText(body?.customer);
  if (customer.length < 2 || customer.length > 60) throw new ValidationError('Informe seu nome (2 a 60 caracteres) para reservar.');
  const quantity = toInt(body?.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_UNITS_PER_RESERVATION) {
    throw new ValidationError(`Escolha de 1 a ${MAX_UNITS_PER_RESERVATION} unidades.`);
  }
  return { customer, customerKey: customerKey(customer), quantity };
}

/** Corpo de POST /api/redemptions: código digitado + chaves de gestão do restaurante. */
function parseRedemptionInput(body) {
  const codeKeys = codeCandidates(body?.code);
  if (!codeKeys.length) throw new ValidationError('Digite o código no formato PS-XXXX-XXXX.');
  return { codeKeys, manageKeys: parseManageKeys(body) };
}

function parseManageKeys(body) {
  const manageKeys = parseTokens(body?.manageKeys ?? body?.manageKey);
  if (!manageKeys.length) throw new ValidationError('Publique uma oferta neste aparelho para validar retiradas.');
  return manageKeys;
}

module.exports = {
  CATEGORIES,
  MAX_OFFER_UNITS,
  cleanText,
  parseId,
  parseToken,
  parseTokens,
  parseOfferInput,
  parseReservationInput,
  parseRedemptionInput,
  parseManageKeys,
};

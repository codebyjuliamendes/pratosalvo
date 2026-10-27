'use strict';

const { ValidationError } = require('./errors');

const MINUTE = 60_000;
const MIN_WINDOW_MINUTES = 10;
const MAX_WINDOW_DAYS = 7;

const WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

const formatters = new Map();
function formatterFor(timeZone) {
  if (!formatters.has(timeZone)) {
    const options = { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
    formatters.set(timeZone, new Intl.DateTimeFormat('en-US', { ...options, second: '2-digit' }));
  }
  return formatters.get(timeZone);
}

/** Lança RangeError se o fuso IANA não existir. */
const assertTimeZone = timeZone => formatterFor(timeZone);

/** Deslocamento (ms) do fuso em relação a UTC no instante dado. */
function zoneOffsetMs(epochMs, timeZone) {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(new Date(epochMs))
      .map(p => [p.type, Number(p.value)]),
  );
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Converte texto ISO 8601 em Date.
 * - Com fuso ("...Z" ou "...-03:00"): instante exato.
 * - Sem fuso ("2026-10-27T19:30", formato do <input type="datetime-local">): hora de parede em `timeZone`.
 *   Evita depender do fuso do servidor (UTC em containers).
 * Retorna null se inválido (inclui datas inexistentes como 31/02).
 */
function parseInstant(value, timeZone) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (WITH_ZONE.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const match = LOCAL.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute, second = 0] = match.slice(1).map(v => Number(v ?? 0));
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wall);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  // Duas passadas resolvem a virada de horário de verão.
  const guess = wall - zoneOffsetMs(wall, timeZone);
  return new Date(wall - zoneOffsetMs(guess, timeZone));
}

/**
 * Valida a janela de retirada de uma oferta.
 * `from` ausente ou no passado vira `now` (retirada liberada desde a publicação).
 */
function buildPickupWindow({ from, until, now }) {
  if (!(until instanceof Date)) throw new ValidationError('Informe até quando a retirada pode ser feita, com data e hora válidas.');
  if (from !== null && from !== undefined && !(from instanceof Date)) throw new ValidationError('O início da retirada é inválido.');
  const start = from && from > now ? from : now;
  if (until.getTime() - start.getTime() < MIN_WINDOW_MINUTES * MINUTE) {
    throw new ValidationError(`O horário final de retirada precisa ser pelo menos ${MIN_WINDOW_MINUTES} minutos depois do início.`);
  }
  if (until.getTime() - now.getTime() > MAX_WINDOW_DAYS * 24 * 60 * MINUTE) {
    throw new ValidationError(`A retirada precisa acontecer em até ${MAX_WINDOW_DAYS} dias.`);
  }
  return { pickupFrom: start, pickupUntil: until };
}

/** Oferta aceita reservas enquanto a janela não terminou. */
const isOpenForReservation = (pickupUntil, now) => now < pickupUntil;

/**
 * Prazo da reserva: `holdMinutes` a partir do início efetivo da retirada,
 * limitado ao fim da janela. Depois disso ela expira e devolve as unidades.
 */
function reservationDeadline({ now, pickupFrom, pickupUntil, holdMinutes }) {
  const start = Math.max(now.getTime(), pickupFrom.getTime());
  return new Date(Math.min(pickupUntil.getTime(), start + holdMinutes * MINUTE));
}

/** Situação da retirada no balcão para uma reserva ativa. */
function redemptionState({ now, pickupFrom, deadline }) {
  if (now < pickupFrom) return 'too_early';
  if (now >= deadline) return 'expired';
  return 'ok';
}

module.exports = {
  MIN_WINDOW_MINUTES,
  MAX_WINDOW_DAYS,
  assertTimeZone,
  parseInstant,
  buildPickupWindow,
  isOpenForReservation,
  reservationDeadline,
  redemptionState,
};

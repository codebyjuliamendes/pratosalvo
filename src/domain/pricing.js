'use strict';

const { ValidationError } = require('./errors');

const MAX_PRICE_CENTS = 200_000; // R$ 2.000,00 por unidade
const MIN_DISCOUNT_PERCENT = 1;

/**
 * Converte um valor monetário em centavos inteiros sem aritmética de ponto
 * flutuante (1.005 * 100 === 100.49999...). Aceita 12.9, "12,90", "R$ 1.234,56".
 * Retorna null para valores inválidos ou com mais de duas casas decimais.
 */
function parseAmountToCents(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? parseAmountToCents(String(value)) : null;
  if (typeof value !== 'string') return null;

  let text = value.trim().replace(/^R\$\s*/i, '');
  // Milhar brasileiro só sem ambiguidade: "1.234,56" ou "1.234.567". "1.005" é decimal (e rejeitado).
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(text) || /^\d{1,3}(\.\d{3}){2,}$/.test(text)) text = text.replace(/\./g, '');
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(text);
  if (!match) return null;

  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Percentual exibido ao cliente. Arredonda para baixo: nunca anuncia desconto maior que o real. */
function discountPercent(priceCents, originalCents) {
  if (!(originalCents > 0) || priceCents >= originalCents) return 0;
  return Math.floor(((originalCents - priceCents) * 100) / originalCents);
}

/** Valida o par preço promocional / preço original (centavos inteiros). */
function validatePricing(priceCents, originalCents) {
  const valid = c => Number.isSafeInteger(c) && c >= 1 && c <= MAX_PRICE_CENTS;
  if (!valid(priceCents) || !valid(originalCents)) {
    throw new ValidationError('Informe preços entre R$ 0,01 e R$ 2.000,00, com até duas casas decimais.');
  }
  if (discountPercent(priceCents, originalCents) < MIN_DISCOUNT_PERCENT) {
    throw new ValidationError('O preço promocional precisa ser menor que o preço original.');
  }
  return { priceCents, originalCents, discountPercent: discountPercent(priceCents, originalCents) };
}

/** Total da reserva em centavos; inteiro exato. */
const totalCents = (unitPriceCents, quantity) => unitPriceCents * quantity;

module.exports = { MAX_PRICE_CENTS, MIN_DISCOUNT_PERCENT, parseAmountToCents, discountPercent, validatePricing, totalCents };

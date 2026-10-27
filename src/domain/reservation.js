'use strict';

const crypto = require('node:crypto');
const { ConflictError } = require('./errors');

// Sem 0/O, 1/I/L e U: lidos em voz alta ou digitados no balcão sem confusão.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8; // 30^8 ≈ 6,6 × 10^11 combinações (~39 bits)
const MAX_UNITS_PER_RESERVATION = 10;
const CURRENT_KEY = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);
const LEGACY_KEY = /^[0-9A-F]{6}$/; // versão anterior: 6 dígitos hexadecimais

const STATUS = Object.freeze({ ACTIVE: 'active', CANCELLED: 'cancelled', REDEEMED: 'redeemed', EXPIRED: 'expired' });

/** Código de retirada aleatório (CSPRNG; randomInt é uniforme, sem viés de módulo). */
function generateCodeKey(randomInt = crypto.randomInt) {
  let key = '';
  for (let i = 0; i < CODE_LENGTH; i++) key += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return key;
}

/** "K7MP3QXA" -> "PS-K7MP-3QXA". Chaves legadas (6 hex) ficam "PS-1A2B3C". */
const formatCode = key => (key.length === CODE_LENGTH ? `PS-${key.slice(0, 4)}-${key.slice(4)}` : `PS-${key}`);

/**
 * Normaliza o que foi digitado no balcão em chaves candidatas para busca.
 * Tolera minúsculas, espaços, hífens, prefixo "PS" e O/I/L digitados no lugar de 0/1.
 * Retorna [] se não pode ser um código.
 */
function codeCandidates(input) {
  if (typeof input !== 'string' || input.length > 32) return [];
  const text = input
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (!/^[0-9A-Z]{6,10}$/.test(text)) return [];
  // "PS" pode ser o prefixo ou o começo do próprio código; testa as duas leituras.
  const candidates = [text];
  if (text.startsWith('PS')) candidates.push(text.slice(2));
  return [...new Set(candidates.filter(c => CURRENT_KEY.test(c) || LEGACY_KEY.test(c)))];
}

/** Chave de identidade do cliente para o limite por oferta (sem conta de usuário, o nome é a referência). */
const customerKey = name => name.normalize('NFKC').toLocaleLowerCase('pt-BR');

/** Garante o limite de unidades por cliente em uma oferta (ativas + retiradas). */
function assertCustomerLimit({ alreadyReserved, requested, limit }) {
  if (alreadyReserved + requested <= limit) return;
  const left = Math.max(0, limit - alreadyReserved);
  throw new ConflictError(
    left
      ? `Cada pessoa pode reservar até ${limit} unidades desta oferta. Você ainda pode reservar ${left}.`
      : `Você já reservou o máximo de ${limit} unidades desta oferta.`,
    { code: 'customer_limit', limit, remaining: left },
  );
}

/** Mensagem para cada estado terminal, usada no cancelamento e no balcão. */
const STATUS_CONFLICT = {
  [STATUS.CANCELLED]: 'Esta reserva já foi cancelada.',
  [STATUS.REDEEMED]: 'Esta reserva já foi retirada.',
  [STATUS.EXPIRED]: 'O prazo de retirada terminou; esta reserva expirou.',
};

module.exports = {
  CODE_ALPHABET,
  CODE_LENGTH,
  MAX_UNITS_PER_RESERVATION,
  STATUS,
  STATUS_CONFLICT,
  generateCodeKey,
  formatCode,
  codeCandidates,
  customerKey,
  assertCustomerLimit,
};

'use strict';

const path = require('node:path');

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'];

function int(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} inválido: "${raw}" (inteiro entre ${min} e ${max}).`);
  return value;
}

function bool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no'].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} inválido: "${raw}" (true ou false).`);
}

function timeZone(env) {
  const value = env.APP_TIMEZONE || 'America/Sao_Paulo';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    throw new Error(`APP_TIMEZONE inválido: "${value}" (use um fuso IANA, ex.: America/Sao_Paulo).`);
  }
  return value;
}

/** Lê e valida o ambiente uma vez; falha no boot em vez de em runtime. */
function loadConfig(env = process.env) {
  const logLevel = env.LOG_LEVEL || 'info';
  if (!LOG_LEVELS.includes(logLevel)) throw new Error(`LOG_LEVEL inválido: "${logLevel}" (${LOG_LEVELS.join(', ')}).`);
  const nodeEnv = env.NODE_ENV || 'development';

  return Object.freeze({
    env: nodeEnv,
    port: int(env, 'PORT', 3001, { min: 1, max: 65535 }),
    databasePath: env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'pratosalvo.sqlite'),
    logLevel,
    // Saltos de proxy confiáveis (ex.: 1 atrás do proxy da Fly/Render) para obter o IP real.
    trustProxy: int(env, 'TRUST_PROXY', 0, { min: 0, max: 10 }),
    rateLimitPerMinute: int(env, 'RATE_LIMIT_PER_MINUTE', 60, { min: 0 }),
    // Validação de código no balcão: limite próprio, mais baixo, contra tentativa e erro.
    redeemRateLimitPerMinute: int(env, 'REDEEM_RATE_LIMIT_PER_MINUTE', 20, { min: 0 }),
    // Fuso usado para horários enviados sem deslocamento (ex.: "2026-10-27T19:30").
    timeZone: timeZone(env),
    holdMinutes: int(env, 'RESERVATION_HOLD_MINUTES', 90, { min: 5, max: 24 * 60 }),
    maxUnitsPerCustomer: int(env, 'MAX_UNITS_PER_CUSTOMER', 5, { min: 1, max: 10 }),
    // Ofertas de demonstração em banco vazio; desligado por padrão em produção.
    seedDemo: bool(env, 'SEED_DEMO', nodeEnv !== 'production'),
  });
}

module.exports = { loadConfig, LOG_LEVELS };

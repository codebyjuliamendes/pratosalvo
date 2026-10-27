'use strict';

const { LOG_LEVELS } = require('./config');

// Códigos de retirada ("PS-K7MP-3QXA", legados "PS-1A2B3C") valem como vale: só o prefixo vai para o log.
const PICKUP_CODE = /\bPS-?([0-9A-Z]{2})[0-9A-Z]{2}-?[0-9A-Z]{2,4}\b/gi;

const redactText = text => text.replace(PICKUP_CODE, 'PS-$1…');

function redact(value, depth = 0) {
  if (typeof value === 'string') return redactText(value);
  if (!value || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, depth + 1)]));
}

/** Logger JSON (uma linha por evento), pronto para agregadores de log. */
function createLogger({ level = 'info', bindings = {}, write = line => process.stdout.write(line + '\n') } = {}) {
  const threshold = LOG_LEVELS.indexOf(level);
  const log = (lvl, msg, fields) => {
    if (LOG_LEVELS.indexOf(lvl) < threshold) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg: redactText(msg), ...bindings, ...redact(fields) }));
  };
  return {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
    child: extra => createLogger({ level, bindings: { ...bindings, ...extra }, write }),
  };
}

const serializeError = err => ({ name: err.name, message: err.message, code: err.code, stack: err.stack });

module.exports = { createLogger, serializeError, redactText };

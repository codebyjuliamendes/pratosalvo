'use strict';

const { HttpError } = require('./errors');

/**
 * Janela fixa por IP, em memória. Suficiente para instância única (SQLite);
 * com várias instâncias, trocar por um store compartilhado (ex.: Redis).
 */
function rateLimit({ limit, windowMs = 60_000, now = Date.now }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const t = now();
    for (const [key, entry] of hits) if (entry.resetAt <= t) hits.delete(key);
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    if (!limit) return next();
    const t = now();
    let entry = hits.get(req.ip);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(req.ip, entry);
    }
    entry.count++;
    res.set('RateLimit-Limit', String(limit));
    res.set('RateLimit-Remaining', String(Math.max(0, limit - entry.count)));
    if (entry.count <= limit) return next();
    res.set('Retry-After', String(Math.ceil((entry.resetAt - t) / 1000)));
    next(new HttpError(429, 'Muitas requisições. Aguarde um instante e tente de novo.'));
  };
}

module.exports = { rateLimit };

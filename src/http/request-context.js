'use strict';

const crypto = require('node:crypto');

const INCOMING_ID = /^[A-Za-z0-9._-]{8,64}$/;
// Ids de reserva são credenciais (permitem cancelar): nunca vão inteiros para o log.
const RESERVATION_ID_IN_PATH = /(\/api\/reservations\/)([A-Za-z0-9_-]{4})[A-Za-z0-9_-]{12,60}/g;

const redactPath = url => url.split('?')[0].replace(RESERVATION_ID_IN_PATH, '$1$2…');

/** Request id (propaga X-Request-Id válido), logger por request e log de acesso. */
function requestContext(logger) {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && INCOMING_ID.test(incoming) ? incoming : crypto.randomUUID();
    req.log = logger.child({ requestId: req.id });
    res.set('X-Request-Id', req.id);

    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      req.log[level]('request', {
        method: req.method,
        path: redactPath(req.originalUrl),
        status: res.statusCode,
        durationMs: Math.round(durationMs),
      });
    });
    next();
  };
}

module.exports = { requestContext, redactPath };

'use strict';

const { ValidationError, NotFoundError, ConflictError } = require('../domain/errors');
const { serializeError } = require('../logger');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const notFound = message => new HttpError(404, message);

const DOMAIN_STATUS = new Map([
  [ValidationError, 400],
  [NotFoundError, 404],
  [ConflictError, 409],
]);

// Erros sempre em JSON; detalhes de falhas inesperadas só no log.
function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  for (const [type, status] of DOMAIN_STATUS)
    if (err instanceof type) return res.status(status).json({ ...err.details, error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'O corpo da requisição não é um JSON válido.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'A requisição é grande demais.' });
  if (err.code === 'SQLITE_BUSY') {
    res.set('Retry-After', '1');
    return res.status(503).json({ error: 'Muita gente reservando agora. Tente de novo em instantes.' });
  }
  (req.log ?? console).error('unhandled_error', { err: serializeError(err) });
  res.status(500).json({ error: 'Não foi possível concluir a ação.' });
}

module.exports = { HttpError, notFound, errorHandler };

'use strict';

const express = require('express');
const path = require('node:path');
const { version } = require('../package.json');
const { createStore } = require('./store');
const { createLogger } = require('./logger');
const { securityHeaders } = require('./http/security');
const { requestContext } = require('./http/request-context');
const { rateLimit } = require('./http/rate-limit');
const { errorHandler, notFound } = require('./http/errors');
const { offerRoutes } = require('./routes/offers');
const { reservationRoutes } = require('./routes/reservations');
const { redemptionRoutes } = require('./routes/redemptions');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * @param db conexão better-sqlite3 já migrada
 * @param options.logger padrão: silencioso (testes)
 * @param options.rateLimitPerMinute escritas por IP; 0 desativa
 * @param options.redeemRateLimitPerMinute validações de código por IP; 0 desativa
 * @param options.trustProxy saltos de proxy confiáveis para req.ip
 * @param options.timeZone fuso de horários sem deslocamento
 * @param options.holdMinutes / maxUnitsPerCustomer regras de reserva
 * @param options.clock relógio injetável (testes de expiração)
 */
function createApp(
  db,
  {
    logger = createLogger({ level: 'silent' }),
    rateLimitPerMinute = 0,
    redeemRateLimitPerMinute = 0,
    trustProxy = 0,
    timeZone = 'America/Sao_Paulo',
    holdMinutes = 90,
    maxUnitsPerCustomer = 5,
    clock = () => new Date(),
    store = createStore(db, { holdMinutes, maxUnitsPerCustomer }),
  } = {},
) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);

  app.use(requestContext(logger));
  app.use(securityHeaders);
  app.use(express.json({ limit: '24kb' }));
  // Assets sem hash no nome: revalida sempre via ETag (304 barato, nunca desatualizado).
  app.use(express.static(PUBLIC_DIR, { setHeaders: res => res.set('Cache-Control', 'no-cache') }));

  const api = express.Router();
  const limiter = rateLimit({ limit: rateLimitPerMinute });
  api.use((req, res, next) => (MUTATING.has(req.method) ? limiter(req, res, next) : next()));
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.get('/health', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', version });
  });
  api.use('/offers', offerRoutes(store, { clock, timeZone }));
  api.use('/reservations', reservationRoutes(store, { clock }));
  api.use('/redemptions', redemptionRoutes(store, { clock, limiter: rateLimit({ limit: redeemRateLimitPerMinute }) }));
  api.use((_req, _res, next) => next(notFound('Rota da API não encontrada.')));

  app.use('/api', api);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };

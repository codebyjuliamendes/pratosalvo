'use strict';

const { loadConfig } = require('./src/config');
const { createLogger, serializeError } = require('./src/logger');
const { openDatabase } = require('./src/db');
const { createStore } = require('./src/store');
const { seedDemoOffers } = require('./src/seed');
const { createApp } = require('./src/app');

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, bindings: { service: 'pratosalvo' } });
const db = openDatabase(config.databasePath);
const store = createStore(db, { holdMinutes: config.holdMinutes, maxUnitsPerCustomer: config.maxUnitsPerCustomer });
if (config.seedDemo) {
  const created = seedDemoOffers(store);
  if (created) logger.info('demo_seeded', { offers: created });
}

const app = createApp(db, {
  logger,
  store,
  rateLimitPerMinute: config.rateLimitPerMinute,
  redeemRateLimitPerMinute: config.redeemRateLimitPerMinute,
  trustProxy: config.trustProxy,
  timeZone: config.timeZone,
  holdMinutes: config.holdMinutes,
  maxUnitsPerCustomer: config.maxUnitsPerCustomer,
});

const server = app.listen(config.port, () => logger.info('server_started', { port: config.port, env: config.env }));

// Devolve ao estoque reservas vencidas mesmo sem tráfego (as rotas também fazem isso sob demanda).
const sweeper = setInterval(() => {
  try {
    const expired = store.sweep(new Date());
    if (expired) logger.info('reservations_expired', { count: expired });
  } catch (err) {
    logger.error('sweep_failed', { err: serializeError(err) });
  }
}, 60_000);
sweeper.unref();

function shutdown(signal) {
  logger.info('shutdown', { signal });
  clearInterval(sweeper);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Conexões keep-alive ociosas não seguram o desligamento.
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', reason => logger.error('unhandled_rejection', { err: serializeError(Object(reason)) }));
process.on('uncaughtException', err => {
  logger.error('uncaught_exception', { err: serializeError(err) });
  process.exit(1);
});

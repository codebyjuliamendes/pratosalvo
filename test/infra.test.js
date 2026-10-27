'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadConfig } = require('../src/config');
const { createLogger, redactText } = require('../src/logger');
const { redactPath } = require('../src/http/request-context');
const { openDatabase, SCHEMA_VERSION } = require('../src/db');
const { createApp } = require('../src/app');

async function withServer(options, fn) {
  const server = createApp(openDatabase(':memory:'), options).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('config: padrões e validação no boot', () => {
  const config = loadConfig({});
  assert.deepEqual(
    [config.port, config.rateLimitPerMinute, config.redeemRateLimitPerMinute, config.timeZone, config.holdMinutes, config.seedDemo],
    [3001, 60, 20, 'America/Sao_Paulo', 90, true],
  );
  assert.equal(loadConfig({ NODE_ENV: 'production' }).seedDemo, false);
  assert.equal(loadConfig({ NODE_ENV: 'production', SEED_DEMO: 'true' }).seedDemo, true);
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT inválido/);
  assert.throws(() => loadConfig({ LOG_LEVEL: 'verbose' }), /LOG_LEVEL inválido/);
  assert.throws(() => loadConfig({ APP_TIMEZONE: 'Marte/Base' }), /APP_TIMEZONE inválido/);
  assert.throws(() => loadConfig({ MAX_UNITS_PER_CUSTOMER: '0' }), /MAX_UNITS_PER_CUSTOMER inválido/);
  assert.throws(() => loadConfig({ SEED_DEMO: 'talvez' }), /SEED_DEMO inválido/);
});

test('logger: JSON por linha, respeita nível, herda campos e redige códigos de retirada', () => {
  const lines = [];
  const logger = createLogger({ level: 'info', write: line => lines.push(JSON.parse(line)) }).child({ requestId: 'abc' });
  logger.debug('oculto');
  logger.warn('codigo PS-K7MP-3QXA recebido', { status: 404, body: { code: 'ps-k7mp-3qxa', list: ['PS-1A2B3C'] } });
  assert.equal(lines.length, 1);
  assert.deepEqual(
    [lines[0].level, lines[0].msg, lines[0].requestId, lines[0].status, lines[0].body],
    ['warn', 'codigo PS-K7… recebido', 'abc', 404, { code: 'PS-k7…', list: ['PS-1A…'] }],
  );
  assert.equal(redactText('sem segredo aqui'), 'sem segredo aqui');
});

test('ids de reserva não aparecem inteiros nos logs', () => {
  assert.equal(redactPath('/api/reservations/dHhMGeUpQJ8nJ0LGbeKq2g/cancel?x=1'), '/api/reservations/dHhM…/cancel');
  assert.equal(redactPath('/api/reservations?ids=dHhMGeUpQJ8nJ0LGbeKq2g'), '/api/reservations');
  assert.equal(redactPath('/api/health'), '/api/health');
});

test('log de acesso com request id propagado e caminho redigido', async () => {
  const lines = [];
  const logger = createLogger({ write: line => lines.push(JSON.parse(line)) });
  await withServer({ logger }, async url => {
    const res = await fetch(`${url}/api/reservations/dHhMGeUpQJ8nJ0LGbeKq2g`, { headers: { 'X-Request-Id': 'req-12345678' } });
    assert.equal(res.headers.get('x-request-id'), 'req-12345678');
    const bad = await fetch(`${url}/api/health`, { headers: { 'X-Request-Id': 'inválido com espaço' } });
    assert.match(bad.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  });
  const entry = lines.find(l => l.msg === 'request');
  assert.deepEqual([entry.requestId, entry.status, entry.path], ['req-12345678', 404, '/api/reservations/dHhM…']);
  assert.equal(JSON.stringify(lines).includes('dHhMGeUpQJ8nJ0LGbeKq2g'), false);
});

test('rate limit só em escritas e responde 429 com Retry-After', async () => {
  await withServer({ rateLimitPerMinute: 2 }, async url => {
    assert.equal((await post(`${url}/api/offers`, {})).status, 400);
    assert.equal((await post(`${url}/api/offers`, {})).status, 400);
    const limited = await post(`${url}/api/offers`, {});
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.match((await limited.json()).error, /Muitas requisições/);
    assert.equal((await fetch(`${url}/api/offers`)).status, 200);
  });
});

test('validação de código tem limite próprio contra tentativa e erro', async () => {
  await withServer({ rateLimitPerMinute: 100, redeemRateLimitPerMinute: 3 }, async url => {
    const attempt = () => post(`${url}/api/redemptions`, { code: 'PS-ZZZZ-ZZZZ', manageKeys: ['x'.repeat(22)] });
    for (let i = 0; i < 3; i++) assert.equal((await attempt()).status, 404);
    assert.equal((await attempt()).status, 429);
    // Outras escritas seguem liberadas.
    assert.equal((await post(`${url}/api/offers`, {})).status, 400);
  });
});

test('backup gera cópia consistente e aplica retenção', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pratosalvo-backup-'));
  try {
    const databasePath = path.join(dir, 'app.sqlite');
    openDatabase(databasePath).close();
    const env = { ...process.env, DATABASE_PATH: databasePath, BACKUP_KEEP: '2' };
    for (let i = 0; i < 3; i++)
      execFileSync(process.execPath, ['scripts/backup.js', path.join(dir, 'bk')], { env, cwd: path.join(__dirname, '..') });
    const files = fs.readdirSync(path.join(dir, 'bk'));
    assert.equal(files.length, 2);
    assert.ok(files.every(f => /^pratosalvo-.*\.sqlite$/.test(f)));
    const copy = openDatabase(path.join(dir, 'bk', files[0]));
    assert.equal(copy.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    copy.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

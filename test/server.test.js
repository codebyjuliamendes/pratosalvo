const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let child, baseUrl, tempDir;
before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pratosalvo-test-'));
  const port = 20000 + Math.floor(Math.random() * 40000); baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port), DATABASE_PATH: path.join(tempDir, 'test.sqlite') }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`); try { if ((await fetch(`${baseUrl}/api/offers`)).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Test server did not become ready');
});
after(async () => { if (child && child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))]); } if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }); });
async function json(url, options) { const response = await fetch(baseUrl + url, { ...options, headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) } }); return { response, body: await response.json() }; }
test('a reservation cancellation restores stock once and is idempotency-protected', async () => {
  const offers = await json('/api/offers'); assert.ok(offers.body.length > 0); const offer = offers.body[0], quantityBefore = offer.quantity;
  const reserved = await json(`/api/offers/${offer.id}/reservations`, { method: 'POST', body: JSON.stringify({ customer: 'Test Guest', quantity: 2 }) });
  assert.equal(reserved.response.status, 201); assert.ok(reserved.body.id); assert.match(reserved.body.code, /^PS-/);
  const reduced = await json('/api/offers'); assert.equal(reduced.body.find(x => x.id === offer.id).quantity, quantityBefore - 2);
  const cancelled = await json(`/api/reservations/${reserved.body.id}/cancel`, { method: 'POST' }); assert.equal(cancelled.response.status, 200); assert.equal(cancelled.body.restocked, 2);
  const restored = await json('/api/offers'); assert.equal(restored.body.find(x => x.id === offer.id).quantity, quantityBefore);
  const repeated = await json(`/api/reservations/${reserved.body.id}/cancel`, { method: 'POST' }); assert.equal(repeated.response.status, 409);
  const finalStock = await json('/api/offers'); assert.equal(finalStock.body.find(x => x.id === offer.id).quantity, quantityBefore);
});

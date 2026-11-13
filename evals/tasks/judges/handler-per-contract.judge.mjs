// Hidden test of the handler-per-contract eval task. Copied into .crew-eval/ only after the agent has finished.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle } from '../src/handlers.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('GET /health matches the contract', () => {
  const r = handle({ method: 'GET', path: '/health' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'ok', version: pkg.version });
});

test('existing routes still work', () => {
  assert.equal(handle({ method: 'GET', path: '/items' }).status, 200);
  assert.equal(handle({ method: 'POST', path: '/health' }).status, 404);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handlers.js';

test('GET /items returns a list', () => {
  const r = handle({ method: 'GET', path: '/items' });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
});

test('unknown route -> 404', () => {
  assert.equal(handle({ method: 'GET', path: '/nope' }).status, 404);
});

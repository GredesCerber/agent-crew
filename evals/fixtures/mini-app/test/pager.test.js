import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/pager.js';

test('number of pages', () => {
  assert.equal(paginate([1, 2, 3, 4, 5], 1, 2).pages, 3);
  assert.equal(paginate([], 1, 10).pages, 1);
});

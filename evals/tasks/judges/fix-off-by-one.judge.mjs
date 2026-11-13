// Hidden test of the fix-off-by-one eval task. Copied into .crew-eval/ only after the agent has finished.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/pager.js';

const list = [1, 2, 3, 4, 5];

test('the first page holds the first items', () => {
  assert.deepEqual(paginate(list, 1, 2), { items: [1, 2], page: 1, pages: 3 });
});

test('the last page is partial', () => {
  assert.deepEqual(paginate(list, 3, 2).items, [5]);
});

test('a page out of range is empty', () => {
  assert.deepEqual(paginate(list, 4, 2).items, []);
});

test('defaults: page=1, size=10', () => {
  assert.deepEqual(paginate(list).items, list);
});

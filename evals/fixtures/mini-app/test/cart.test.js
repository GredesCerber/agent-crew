import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCart, addItem, total } from '../src/cart.js';

test('cart total', () => {
  const cart = createCart();
  addItem(cart, { sku: 'tea', qty: 2, price: 150 });
  addItem(cart, { sku: 'cup', qty: 1, price: 300 });
  assert.equal(total(cart), 600);
});

// Hidden test of the add-input-validation eval task. Copied into .crew-eval/ only after the agent has finished.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCart, addItem, total } from '../src/cart.js';

const good = { sku: 'tea', qty: 2, price: 150 };

test('a valid item is added', () => {
  const cart = createCart();
  addItem(cart, good);
  addItem(cart, { sku: 'gift', qty: 1, price: 0 });
  assert.equal(total(cart), 300);
  assert.equal(cart.items.length, 2);
});

for (const [field, values] of Object.entries({
  sku: ['', 42, null, undefined],
  qty: [0, -1, 1.5, '2', NaN],
  price: [-1, Infinity, NaN, '10'],
})) {
  for (const v of values) {
    test(`${field}=${String(v)} -> TypeError naming the field`, () => {
      const cart = createCart();
      assert.throws(() => addItem(cart, { ...good, [field]: v }), (e) => e instanceof TypeError && e.message.includes(field));
      assert.equal(cart.items.length, 0, 'an invalid item must not end up in the cart');
    });
  }
}

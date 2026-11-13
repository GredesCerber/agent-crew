// Shopping cart. Item: { sku: string, qty: integer > 0, price: number >= 0 }.

export function createCart() {
  return { items: [] };
}

export function addItem(cart, item) {
  cart.items.push({ sku: item.sku, qty: item.qty, price: item.price });
  return cart;
}

export function total(cart) {
  return cart.items.reduce((sum, i) => sum + i.qty * i.price, 0);
}

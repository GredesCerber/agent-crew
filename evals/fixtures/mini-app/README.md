# mini-app

A small module for `crew eval` tasks. No dependencies, Node.js 20+.

- `src/cart.js` — cart: `createCart`, `addItem`, `total`.
- `src/pager.js` — pagination `paginate(items, page, size)`, pages start at 1.
- `src/handlers.js` — HTTP route handlers `handle({ method, path })`.
- `contracts/` — API contracts. Do not change them, only implement them.

Tests: `npm test` (or `node --test`).

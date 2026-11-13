// HTTP route handlers. Key: "METHOD /path", value: a function with no arguments -> { status, body }.
// Route contracts live in contracts/.

const items = [
  { id: 1, name: 'tea' },
  { id: 2, name: 'coffee' },
];

export const routes = {
  'GET /items': () => ({ status: 200, body: items }),
};

export function handle({ method, path }) {
  const h = routes[`${method} ${path}`];
  return h ? h() : { status: 404, body: { error: 'not_found' } };
}

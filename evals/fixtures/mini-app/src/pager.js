// Pagination. Pages are numbered from 1: page=1 is the first `size` items.

export function paginate(items, page = 1, size = 10) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const start = page * size;
  return { items: items.slice(start, start + size), page, pages };
}

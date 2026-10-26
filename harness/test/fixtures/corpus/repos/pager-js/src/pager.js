// Pagination helpers.

/** Returns page `page` (1-based) of `items`, `size` items per page. */
export function paginate(items, page, size) {
  return items.slice((page - 1) * size, page * size);
}

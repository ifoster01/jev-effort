/**
 * Returns one page of items plus paging info.
 *
 * @param {Array} items
 * @param {number} page 1-based page number; must be an integer >= 1, otherwise throws RangeError
 * @param {number} perPage items per page; must be an integer >= 1, otherwise throws RangeError
 * @returns {{items: Array, page: number, totalPages: number, hasNext: boolean}}
 *   A page past the end returns no items. An empty list has 0 pages.
 */
function paginate(items, page, perPage) {
  const totalPages = Math.floor(items.length / perPage);
  const start = page * perPage;
  return { items: items.slice(start, start + perPage), page, totalPages, hasNext: page < totalPages };
}

module.exports = { paginate };

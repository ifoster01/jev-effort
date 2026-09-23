function paginate(items, page, perPage) {
  if (!Number.isInteger(page) || page < 1) throw new RangeError("page must be an integer >= 1");
  if (!Number.isInteger(perPage) || perPage < 1) throw new RangeError("perPage must be an integer >= 1");
  const totalPages = Math.ceil(items.length / perPage);
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), page, totalPages, hasNext: page < totalPages };
}

module.exports = { paginate };

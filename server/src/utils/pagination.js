const SORT_DIR = new Set(['asc', 'desc']);

/** Parse page/limit safely (bounded integers). */
export function pagination(q = {}, { defaultLimit = 50, maxLimit = 500 } = {}) {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(q.limit, 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

/**
 * Whitelisted ORDER BY. `columns` maps public sort keys to SQL expressions.
 */
export function sortClause(q = {}, columns, fallback) {
  const key = String(q.sort || '');
  const dir = SORT_DIR.has(String(q.order || '').toLowerCase()) ? q.order.toUpperCase() : 'DESC';
  const col = columns[key];
  return col ? `ORDER BY ${col} ${dir} NULLS LAST` : `ORDER BY ${fallback}`;
}

import { query } from '../../config/database.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { franchiseContext, assertOutletAccess, assertBelongsToOrg, scopeSql, isUuid } from '../../services/permissions.js';
import { isIsoDate } from '../../utils/dates.js';

/**
 * Build a scoped WHERE clause for record listings that accept either
 * ?outletId= or ?orgId= (all outlets in the caller's scope).
 */
export async function scopedOutletWhere(req, permission, alias = 'o') {
  const { orgId, outletId, brandId, regionId, from, to } = req.query;
  const params = [];
  let where;
  if (outletId) {
    const { outlet } = await assertOutletAccess(req, outletId, permission);
    params.push(outlet.id);
    where = `${alias}.id = $1`;
  } else {
    const { scope } = await franchiseContext(req, orgId, permission);
    await assertBelongsToOrg('brands', brandId, orgId, 'brand');
    await assertBelongsToOrg('regions', regionId, orgId, 'region');
    params.push(orgId);
    where = `${alias}.org_id = $1 AND ${alias}.deleted_at IS NULL`;
    where += scopeSql(scope, params, `${alias}.id`);
    if (brandId) { params.push(brandId); where += ` AND ${alias}.brand_id = $${params.length}`; }
    if (regionId) { params.push(regionId); where += ` AND ${alias}.region_id = $${params.length}`; }
  }
  if (from && !isIsoDate(from)) throw new AppError('Invalid "from" date.', 400);
  if (to && !isIsoDate(to)) throw new AppError('Invalid "to" date.', 400);
  return { where, params, from, to };
}

/** Load a record joined to its outlet and authorise access to that outlet. */
export async function loadRecord(req, table, id, permission, label) {
  if (!isUuid(id)) throw new NotFoundError(label);
  const allowed = { sales_records: 1, operating_expenses: 1 };
  if (!allowed[table]) throw new Error('Unsupported table');
  const { rows } = await query(`SELECT * FROM ${table} WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!rows.length) throw new NotFoundError(label);
  try {
    const ctx = await assertOutletAccess(req, rows[0].outlet_id, permission);
    return { record: rows[0], ...ctx };
  } catch (err) {
    if (err.status === 404) throw new NotFoundError(label);
    throw err;
  }
}

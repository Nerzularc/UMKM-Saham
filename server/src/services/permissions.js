/**
 * Central permission model.
 *
 * Access to tenant data is decided in three steps, always on the server:
 *   1. Tenant  — the user must hold an active membership in the organisation.
 *   2. Role    — the membership's role must grant the named permission.
 *   3. Scope   — managers and staff only reach the outlets they are assigned to
 *                (outlet_assignments). Organisation owners reach every outlet.
 *
 * Anything not granted here is denied. Platform superadmins manage the platform
 * (organisations, users, integrations) but do NOT automatically read tenant
 * financial data; they need a membership like anyone else.
 *
 * Route handlers call these helpers instead of comparing role names.
 */
import { query } from '../config/database.js';
import { ForbiddenError, NotFoundError, AppError } from '../utils/errors.js';

export const PERMISSIONS = Object.freeze({
  ORG_READ:              'org.read',
  ORG_MANAGE:            'org.manage',
  MEMBERS_READ:          'org.members.read',
  MEMBERS_MANAGE:        'org.members.manage',
  AUDIT_READ:            'org.audit.read',
  STRUCTURE_MANAGE:      'franchise.structure.manage',   // brands, regions, outlets, products
  FRANCHISE_READ:        'franchise.read',               // outlets, operational data in scope
  FINANCIALS_READ:       'franchise.financials.read',    // profit, margins, P&L
  SALES_WRITE:           'franchise.sales.write',
  EXPENSES_WRITE:        'franchise.expenses.write',
  INVENTORY_WRITE:       'franchise.inventory.write',
  INVENTORY_TRANSFER:    'franchise.inventory.transfer',
  TARGETS_MANAGE:        'franchise.targets.manage',
  DATA_IMPORT:           'data.import',
  DATA_EXPORT:           'data.export',
  APPROVALS_REVIEW:      'approvals.review',
  INTEGRATIONS_MANAGE:   'integrations.manage',
});

const P = PERMISSIONS;

export const ROLE_PERMISSIONS = Object.freeze({
  org_owner: new Set(Object.values(P)),
  manager: new Set([
    P.ORG_READ, P.MEMBERS_READ, P.AUDIT_READ,
    P.FRANCHISE_READ, P.FINANCIALS_READ,
    P.SALES_WRITE, P.EXPENSES_WRITE, P.INVENTORY_WRITE, P.INVENTORY_TRANSFER,
    P.TARGETS_MANAGE, P.DATA_IMPORT, P.DATA_EXPORT, P.APPROVALS_REVIEW,
  ]),
  staff: new Set([
    P.ORG_READ, P.FRANCHISE_READ,
    P.SALES_WRITE, P.EXPENSES_WRITE, P.INVENTORY_WRITE, P.DATA_IMPORT,
  ]),
});

/** Roles that an organisation owner may assign. org_owner/superadmin are never assignable via API. */
export const ASSIGNABLE_ROLES = Object.freeze(['manager', 'staff']);

/** Roles whose outlet access is restricted to explicit outlet assignments. */
const SCOPED_ROLES = new Set(['manager', 'staff']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function assertUuid(value, label = 'identifier') {
  if (!isUuid(value)) throw new AppError(`Invalid ${label}.`, 400);
  return value;
}

export function roleHas(roleName, permission) {
  return ROLE_PERMISSIONS[roleName]?.has(permission) === true;
}

/**
 * Return the caller's membership in an organisation or throw 403.
 * The same error is used for "not a member" and "organisation does not exist"
 * so identifiers of other tenants cannot be probed.
 */
export function getMembership(req, orgId) {
  if (!isUuid(orgId)) throw new ForbiddenError('Organisation context required.');
  const membership = req.memberships?.find((m) => m.org_id === orgId);
  if (!membership) throw new ForbiddenError('You do not have access to this organisation.');
  return membership;
}

export function requirePermission(req, orgId, permission) {
  const membership = getMembership(req, orgId);
  if (!roleHas(membership.role_name, permission)) {
    throw new ForbiddenError('You do not have permission to perform this action.');
  }
  return membership;
}

export function requireModule(membership, moduleName) {
  const enabled = Array.isArray(membership.modules_enabled) ? membership.modules_enabled : [];
  if (!enabled.includes(moduleName)) {
    throw new ForbiddenError(`The ${moduleName} module is not enabled for this organisation.`);
  }
}

/**
 * Outlet scope of the caller within an organisation.
 * Returns { all: true } for owners, or { all: false, outletIds: [...] }.
 */
export async function getOutletScope(req, orgId) {
  const membership = getMembership(req, orgId);
  req._outletScope ??= new Map();
  if (req._outletScope.has(orgId)) return req._outletScope.get(orgId);

  let scope;
  if (!SCOPED_ROLES.has(membership.role_name)) {
    scope = { all: true, outletIds: null };
  } else {
    const { rows } = await query(
      `SELECT oa.outlet_id
         FROM outlet_assignments oa
         JOIN outlets o ON o.id = oa.outlet_id AND o.deleted_at IS NULL
        WHERE oa.user_id = $1 AND oa.is_active = TRUE AND o.org_id = $2`,
      [req.user.id, orgId],
    );
    scope = { all: false, outletIds: rows.map((r) => r.outlet_id) };
  }
  req._outletScope.set(orgId, scope);
  return scope;
}

/**
 * Append an outlet-scope condition to a parameterised WHERE clause.
 * @param {object} scope   result of getOutletScope
 * @param {any[]}  params  parameter array (mutated)
 * @param {string} column  SQL column holding the outlet id, e.g. "o.id"
 */
export function scopeSql(scope, params, column) {
  if (scope.all) return '';
  params.push(scope.outletIds);
  return ` AND ${column} = ANY($${params.length}::uuid[])`;
}

/**
 * Load an outlet and verify the caller may act on it with the given permission.
 * Responds 404 for outlets outside the caller's tenants (no existence leak).
 */
export async function assertOutletAccess(req, outletId, permission = P.FRANCHISE_READ) {
  if (!isUuid(outletId)) throw new AppError('Invalid outlet identifier.', 400);
  const { rows } = await query(
    'SELECT id, org_id, name, code, brand_id, region_id FROM outlets WHERE id = $1 AND deleted_at IS NULL',
    [outletId],
  );
  const outlet = rows[0];
  if (!outlet || !req.memberships?.some((m) => m.org_id === outlet.org_id)) {
    throw new NotFoundError('Outlet');
  }
  const membership = requirePermission(req, outlet.org_id, permission);
  requireModule(membership, 'franchise');
  const scope = await getOutletScope(req, outlet.org_id);
  if (!scope.all && !scope.outletIds.includes(outlet.id)) {
    throw new ForbiddenError('You are not assigned to this outlet.');
  }
  return { outlet, membership, scope };
}

/**
 * Franchise organisation context: membership + permission + module + scope.
 */
export async function franchiseContext(req, orgId, permission = P.FRANCHISE_READ) {
  const membership = requirePermission(req, orgId, permission);
  requireModule(membership, 'franchise');
  const scope = await getOutletScope(req, orgId);
  return { membership, scope };
}

/**
 * Optional filter ids (brand/region/outlet) must belong to the same organisation.
 * Prevents mixing another tenant's identifiers into a query.
 */
export async function assertBelongsToOrg(table, id, orgId, label) {
  if (id == null || id === '') return null;
  if (!isUuid(id)) throw new AppError(`Invalid ${label} identifier.`, 400);
  const allowed = { brands: 'brands', regions: 'regions', outlets: 'outlets', products: 'products' };
  const tbl = allowed[table];
  if (!tbl) throw new Error('Unsupported table');
  const { rows } = await query(
    `SELECT id FROM ${tbl} WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
    [id, orgId],
  );
  if (!rows.length) throw new NotFoundError(label.charAt(0).toUpperCase() + label.slice(1));
  return id;
}

/** Permission matrix for documentation/admin views. */
export function permissionMatrix() {
  return Object.fromEntries(
    Object.entries(ROLE_PERMISSIONS).map(([role, set]) => [role, [...set].sort()]),
  );
}

/**
 * Approval workflow for configurable high-risk financial changes.
 *
 * Organisation settings (organisations.settings.approvals):
 *   enabled             — turn the workflow on/off
 *   actions             — e.g. ["sales.update","sales.delete","expenses.update","expenses.delete"]
 *   separationOfDuties  — the requester may not approve their own change
 *
 * When an action requires approval, the change is stored in change_approvals
 * with the original and proposed values; nothing is modified until a reviewer
 * with approvals.review permission approves it.
 */
import { query, withTransaction } from '../../config/database.js';
import { AppError, ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { auditLog } from '../audit/audit.service.js';
import { randomUUID as uuidv4 } from 'crypto';

export async function getApprovalSettings(orgId) {
  const { rows } = await query('SELECT settings FROM organisations WHERE id = $1', [orgId]);
  const a = rows[0]?.settings?.approvals || {};
  return {
    enabled: a.enabled === true,
    actions: Array.isArray(a.actions) ? a.actions : [],
    separationOfDuties: a.separationOfDuties !== false,
  };
}

export async function requiresApproval(orgId, action) {
  const s = await getApprovalSettings(orgId);
  return s.enabled && s.actions.includes(action);
}

export async function createApproval(req, { orgId, resourceType, resourceId, action, oldValues, newValues, reason }) {
  if (!reason || String(reason).trim().length < 3) {
    throw new AppError('A reason is required for changes that need approval.', 422);
  }
  const { rows } = await query(
    `INSERT INTO change_approvals (id, org_id, resource_type, resource_id, action, old_values, new_values, reason, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [uuidv4(), orgId, resourceType, resourceId, action, JSON.stringify(oldValues || null),
      JSON.stringify(newValues || null), String(reason).trim(), req.user.id],
  );
  await auditLog({
    orgId, actorId: req.user.id, actorEmail: req.user.email, action: 'approval.requested',
    resourceType, resourceId, oldValues, newValues, metadata: { approvalId: rows[0].id, change: action, reason },
  });
  return rows[0];
}

/** Applies an approved change. Each entry runs inside the review transaction. */
const APPLIERS = {
  'sales_record:update': (c, a) => c.query(
    `UPDATE sales_records SET gross_sales = COALESCE($2, gross_sales), discounts = COALESCE($3, discounts),
       returns = COALESCE($4, returns), transaction_count = COALESCE($5, transaction_count), notes = COALESCE($6, notes)
     WHERE id = $1 AND deleted_at IS NULL`,
    [a.resource_id, a.new_values?.grossSales, a.new_values?.discounts, a.new_values?.returns,
      a.new_values?.transactionCount, a.new_values?.notes],
  ),
  'sales_record:delete': (c, a) => c.query('UPDATE sales_records SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL', [a.resource_id]),
  'operating_expense:update': (c, a) => c.query(
    `UPDATE operating_expenses SET amount = COALESCE($2, amount), expense_date = COALESCE($3, expense_date),
       description = COALESCE($4, description), expense_category_id = COALESCE($5, expense_category_id)
     WHERE id = $1 AND deleted_at IS NULL`,
    [a.resource_id, a.new_values?.amount, a.new_values?.expenseDate, a.new_values?.description, a.new_values?.expenseCategoryId],
  ),
  'operating_expense:delete': (c, a) => c.query('UPDATE operating_expenses SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL', [a.resource_id]),
};

export async function reviewApproval(req, approvalId, decision, notes) {
  const { rows } = await query('SELECT * FROM change_approvals WHERE id = $1', [approvalId]);
  const approval = rows[0];
  if (!approval || !req.memberships.some((m) => m.org_id === approval.org_id)) throw new NotFoundError('Approval');
  if (approval.status !== 'pending') throw new AppError('This request has already been reviewed.', 409);

  const settings = await getApprovalSettings(approval.org_id);
  if (settings.separationOfDuties && approval.requested_by === req.user.id && decision === 'approved') {
    throw new ForbiddenError('You cannot approve your own change (separation of duties).');
  }

  return withTransaction(async (client) => {
    const { rows: locked } = await client.query(
      "SELECT * FROM change_approvals WHERE id = $1 AND status = 'pending' FOR UPDATE", [approvalId],
    );
    if (!locked.length) throw new AppError('This request has already been reviewed.', 409);

    if (decision === 'approved') {
      const apply = APPLIERS[`${approval.resource_type}:${approval.action}`];
      if (!apply) throw new AppError('Unsupported approval type.', 400);
      await apply(client, approval);
    }
    const { rows: updated } = await client.query(
      `UPDATE change_approvals SET status = $2, reviewed_by = $3, reviewed_at = NOW(), review_notes = $4
       WHERE id = $1 RETURNING *`,
      [approvalId, decision, req.user.id, notes || null],
    );
    await auditLog({
      orgId: approval.org_id, actorId: req.user.id, actorEmail: req.user.email,
      action: `approval.${decision}`, resourceType: approval.resource_type, resourceId: approval.resource_id,
      oldValues: approval.old_values, newValues: decision === 'approved' ? approval.new_values : null,
      metadata: { approvalId, change: approval.action, notes },
    }, client);
    return updated[0];
  });
}

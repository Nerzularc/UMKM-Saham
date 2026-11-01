import { query } from '../../config/database.js';
import { logger } from '../../utils/logger.js';

const SENSITIVE_KEYS = /password|secret|token|api_?key|two_factor/i;

/** Remove credentials from any value recorded in the audit trail. */
export function scrub(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(scrub);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.test(k) ? '[REDACTED]' : scrub(v);
  }
  return out;
}

/**
 * Append-only audit log. Rows are protected by a database trigger against
 * UPDATE/DELETE. Failures are logged but never break the primary operation.
 */
export async function auditLog({
  orgId = null, actorId = null, actorEmail = null, action, resourceType, resourceId = null,
  oldValues = null, newValues = null, metadata = null, ipAddress = null, userAgent = null,
}, client = null) {
  try {
    const run = client ? client.query.bind(client) : query;
    await run(
      `INSERT INTO audit_events
         (org_id, actor_id, actor_email, action, resource_type, resource_id,
          old_values, new_values, metadata, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        orgId, actorId, actorEmail, action, resourceType, resourceId == null ? null : String(resourceId),
        oldValues ? JSON.stringify(scrub(oldValues)) : null,
        newValues ? JSON.stringify(scrub(newValues)) : null,
        metadata ? JSON.stringify(scrub(metadata)) : null,
        ipAddress ? String(ipAddress).replace(/^::ffff:/, '') : null,
        userAgent,
      ],
    );
  } catch (err) {
    logger.error({ err: err.message, action }, 'Audit log write failed');
  }
}

/** Convenience wrapper that fills actor and request metadata from an Express request. */
export function audit(req, entry, client = null) {
  return auditLog({
    actorId: req.user?.id || null,
    actorEmail: req.user?.email || null,
    ipAddress: req.ip,
    userAgent: req.get?.('User-Agent') || null,
    ...entry,
  }, client);
}

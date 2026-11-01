/**
 * Import workflow (shared by both modules):
 *   1. POST /imports                 upload file → parsed rows, headers, suggested column mapping
 *   2. POST /imports/:id/validate    apply mapping → per-row validation, duplicate detection, preview
 *   3. POST /imports/:id/confirm     insert valid, non-duplicate rows in one DB transaction
 *   GET  /imports/:id                status, counts and row errors
 *   GET  /imports/:id/errors.csv     downloadable error report
 *   GET  /imports/templates/:entity  CSV template
 *
 * Nothing is silently discarded: every rejected or skipped row is recorded in
 * import_row_errors with its row number, column and reason.
 */
import express from 'express';
import multer from 'multer';
import { createHash } from 'crypto';
import { requireAuth } from '../../middleware/auth.js';
import { query, getClient } from '../../config/database.js';
import { successResponse, createdResponse } from '../../utils/response.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { config } from '../../config/env.js';
import { audit } from '../audit/audit.service.js';
import { isUuid, PERMISSIONS as P, requirePermission } from '../../services/permissions.js';
import { parseSpreadsheet } from './parsers.js';
import { ENTITIES, suggestMapping, templateCsv, RowError } from './entities.js';
import { toCsv } from '../reports/export.service.js';
import { randomUUID as uuidv4 } from 'crypto';

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(csv|xlsx|txt)$/i.test(file.originalname);
    cb(ok ? null : new AppError('Only .csv and .xlsx files are accepted.', 415), ok);
  },
});

function contextFromBody(entity, body) {
  const def = ENTITIES[entity];
  const ctx = {};
  for (const key of def.context) {
    if (!isUuid(body[key])) throw new AppError(`${key} is required for ${entity} imports.`, 400);
    ctx[key] = body[key];
  }
  return ctx;
}

async function loadBatch(req, id) {
  if (!isUuid(id)) throw new NotFoundError('Import');
  const { rows } = await query('SELECT * FROM import_batches WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  if (!rows.length) throw new NotFoundError('Import');
  return rows[0];
}

function applyMapping(row, mapping) {
  const out = {};
  for (const [field, header] of Object.entries(mapping)) {
    if (header) out[field] = row[header];
  }
  return out;
}

/**
 * Validate every row. Returns { results, errors } where results are valid rows
 * annotated with { rowNumber, duplicate }.
 */
async function validateRows(def, batch, mapping, ctx) {
  const missing = def.fields.filter((f) => f.required && !mapping[f.key]).map((f) => f.key);
  if (missing.length) throw new AppError(`Map the required column(s): ${missing.join(', ')}.`, 422);
  const headers = batch.headers || [];
  for (const h of Object.values(mapping)) {
    if (h && !headers.includes(h)) throw new AppError(`Column "${h}" does not exist in the file.`, 422);
  }

  const results = [];
  const errors = [];
  const seen = new Set();
  const rows = batch.parsed_rows || [];
  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2; // header is row 1
    const mapped = applyMapping(rows[i], mapping);
    try {
      const v = await def.validate(mapped, ctx);
      if (seen.has(v.hash)) {
        errors.push({ rowNumber, column: null, code: 'DUPLICATE_IN_FILE', message: 'Same row appears earlier in this file — skipped', raw: rows[i] });
        continue;
      }
      seen.add(v.hash);
      results.push({ ...v, rowNumber, raw: rows[i] });
    } catch (err) {
      if (!(err instanceof RowError) && !(err instanceof AppError)) throw err;
      errors.push({ rowNumber, column: err.column || null, code: err.code || 'INVALID', message: err.message, raw: rows[i] });
    }
  }

  const existing = await def.existing(results, ctx);
  for (const r of results) {
    if (existing.has(r.hash)) {
      r.duplicate = true;
      errors.push({ rowNumber: r.rowNumber, column: null, code: 'DUPLICATE_EXISTING', message: 'Identical record already exists — skipped', raw: r.raw });
    }
  }
  return { results, errors };
}

async function saveErrors(batchId, errors) {
  await query('DELETE FROM import_row_errors WHERE batch_id = $1', [batchId]);
  for (let i = 0; i < errors.length; i += 500) {
    const chunk = errors.slice(i, i + 500);
    const params = [];
    const values = chunk.map((e, j) => {
      params.push(batchId, e.rowNumber, e.column, e.code, e.message, JSON.stringify(e.raw ?? null));
      const b = j * 6;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`;
    });
    await query(`INSERT INTO import_row_errors (batch_id, row_number, column_name, error_code, message, raw_data) VALUES ${values.join(',')}`, params);
  }
}

// GET /api/v1/imports/entities — available import types and their fields
router.get('/entities', (_req, res) => successResponse(res, Object.entries(ENTITIES).map(([key, d]) => ({
  key, label: d.label, module: d.module, context: d.context,
  fields: d.fields.map((f) => ({ key: f.key, required: !!f.required })),
}))));

// GET /api/v1/imports/templates/:entity
router.get('/templates/:entity', (req, res, next) => {
  try {
    const csv = templateCsv(req.params.entity);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="template-${req.params.entity}.csv"`);
    return res.send(csv);
  } catch (err) { next(err); }
});

// GET /api/v1/imports?orgId=&portfolioId=
router.get('/', async (req, res, next) => {
  try {
    const params = [req.user.id];
    let where = 'WHERE user_id = $1';
    if (isUuid(req.query.orgId)) { params.push(req.query.orgId); where += ` AND org_id = $${params.length}`; }
    const { rows } = await query(
      `SELECT id, org_id, module, entity_type, filename, file_size, total_rows, valid_rows, imported_rows, error_rows,
              duplicate_rows, status, context, created_at, completed_at, error_message
         FROM import_batches ${where} ORDER BY created_at DESC LIMIT 100`,
      params,
    );
    return successResponse(res, rows);
  } catch (err) { next(err); }
});

// POST /api/v1/imports  (multipart: file, entityType, orgId|portfolioId)
router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    const entity = req.body.entityType;
    const def = ENTITIES[entity];
    if (!def) throw new AppError('Unknown import type.', 400);
    if (!req.file) throw new AppError('No file uploaded.', 400);
    const ctxInput = contextFromBody(entity, req.body);
    const ctx = await def.loadContext(req, ctxInput);   // authorises the context
    if (def.module === 'franchise') requirePermission(req, ctxInput.orgId, P.DATA_IMPORT);

    const parsed = await parseSpreadsheet(req.file.buffer, req.file.originalname);
    if (!parsed.rows.length) throw new AppError('The file has a header row but no data rows.', 422);
    const fileHash = createHash('sha256').update(req.file.buffer).digest('hex');

    const { rows: previous } = await query(
      `SELECT id, completed_at FROM import_batches
        WHERE file_hash = $1 AND entity_type = $2 AND status = 'done' AND context = $3::jsonb
        ORDER BY completed_at DESC LIMIT 1`,
      [fileHash, entity, JSON.stringify(ctxInput)],
    );

    const id = uuidv4();
    const mapping = suggestMapping(entity, parsed.headers);
    await query(
      `INSERT INTO import_batches (id, org_id, user_id, module, entity_type, filename, file_size, total_rows, status,
                                   headers, parsed_rows, column_mapping, context, file_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'uploaded',$9,$10,$11,$12,$13)`,
      [id, ctx.orgId || null, req.user.id, def.module, entity, req.file.originalname.slice(0, 500), req.file.size,
        parsed.rows.length, JSON.stringify(parsed.headers), JSON.stringify(parsed.rows), JSON.stringify(mapping),
        JSON.stringify(ctxInput), fileHash],
    );
    await audit(req, { orgId: ctx.orgId || null, action: 'import.uploaded', resourceType: 'import_batch', resourceId: id, metadata: { entity, filename: req.file.originalname, rows: parsed.rows.length } });

    return createdResponse(res, {
      id, entityType: entity, filename: req.file.originalname, totalRows: parsed.rows.length, truncated: parsed.truncated,
      headers: parsed.headers, sampleRows: parsed.rows.slice(0, 10),
      fields: def.fields.map((f) => ({ key: f.key, required: !!f.required })),
      suggestedMapping: mapping,
      previouslyImported: previous[0] ? { batchId: previous[0].id, completedAt: previous[0].completed_at } : null,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/imports/:id/validate  { mapping }
router.post('/:id/validate', async (req, res, next) => {
  try {
    const batch = await loadBatch(req, req.params.id);
    if (['done', 'cancelled', 'importing'].includes(batch.status)) throw new AppError(`Import is already ${batch.status}.`, 409);
    const def = ENTITIES[batch.entity_type];
    const mapping = req.body?.mapping && typeof req.body.mapping === 'object' ? req.body.mapping : batch.column_mapping;
    const ctx = await def.loadContext(req, batch.context);
    const { results, errors } = await validateRows(def, batch, mapping, ctx);
    const valid = results.filter((r) => !r.duplicate);
    const dupCount = errors.filter((e) => e.code.startsWith('DUPLICATE')).length;
    await saveErrors(batch.id, errors);
    await query(
      `UPDATE import_batches SET status = 'validated', column_mapping = $2, valid_rows = $3, error_rows = $4, duplicate_rows = $5
       WHERE id = $1`,
      [batch.id, JSON.stringify(mapping), valid.length, errors.length - dupCount, dupCount],
    );
    return successResponse(res, {
      id: batch.id,
      totalRows: batch.total_rows,
      validRows: valid.length,
      duplicateRows: dupCount,
      errorRows: errors.length - dupCount,
      preview: valid.slice(0, 50).map((r) => ({ rowNumber: r.rowNumber, ...r.display })),
      errors: errors.slice(0, 200).map(({ raw, ...e }) => e),
    });
  } catch (err) { next(err); }
});

// POST /api/v1/imports/:id/confirm
router.post('/:id/confirm', async (req, res, next) => {
  let batch;
  try {
    batch = await loadBatch(req, req.params.id);
    if (batch.status === 'done') {
      return successResponse(res, { id: batch.id, status: 'done', importedRows: batch.imported_rows, alreadyCompleted: true });
    }
    if (batch.status !== 'validated') throw new AppError('Validate the import before confirming it.', 409);
    const def = ENTITIES[batch.entity_type];
    const ctx = await def.loadContext(req, batch.context);  // re-authorise at confirmation time
    if (def.module === 'franchise') requirePermission(req, batch.context.orgId, P.DATA_IMPORT);

    // Claim the batch so double-clicks cannot import twice.
    const { rowCount } = await query("UPDATE import_batches SET status = 'importing', started_at = NOW() WHERE id = $1 AND status = 'validated'", [batch.id]);
    if (!rowCount) throw new AppError('This import is already being processed.', 409);

    const { results, errors } = await validateRows(def, batch, batch.column_mapping, ctx);
    const toInsert = results.filter((r) => !r.duplicate);
    if (def.sortKey) toInsert.sort((a, b) => def.sortKey(a).localeCompare(def.sortKey(b)) || a.rowNumber - b.rowNumber);

    let imported = 0;
    const client = await getClient();
    try {
      await client.query('BEGIN');
      for (const r of toInsert) {
        await client.query('SAVEPOINT import_row');
        try {
          const inserted = await def.insert(client, r, ctx, batch.id);
          await client.query('RELEASE SAVEPOINT import_row');
          if (inserted) imported++;
          else errors.push({ rowNumber: r.rowNumber, code: 'DUPLICATE_EXISTING', message: 'Identical record already exists — skipped', raw: r.raw });
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT import_row');
          const isDataError = err instanceof AppError || /^2[23]/.test(err.code || '');
          if (!isDataError) throw err;
          errors.push({ rowNumber: r.rowNumber, column: null, code: 'REJECTED', message: err instanceof AppError ? err.message : 'Rejected by a data-integrity rule', raw: r.raw });
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    errors.sort((a, b) => a.rowNumber - b.rowNumber);
    const dupCount = errors.filter((e) => e.code.startsWith('DUPLICATE')).length;
    await saveErrors(batch.id, errors);
    await query(
      `UPDATE import_batches SET status = 'done', imported_rows = $2, error_rows = $3, duplicate_rows = $4,
         completed_at = NOW(), parsed_rows = NULL
       WHERE id = $1`,
      [batch.id, imported, errors.length - dupCount, dupCount],
    );
    await audit(req, {
      orgId: batch.org_id, action: 'import.completed', resourceType: 'import_batch', resourceId: batch.id,
      metadata: { entity: batch.entity_type, imported, errors: errors.length - dupCount, duplicates: dupCount },
    });
    return successResponse(res, { id: batch.id, status: 'done', importedRows: imported, errorRows: errors.length - dupCount, duplicateRows: dupCount });
  } catch (err) {
    if (batch && batch.status === 'validated') {
      await query("UPDATE import_batches SET status = 'failed', error_message = $2, completed_at = NOW() WHERE id = $1 AND status = 'importing'", [batch.id, err.status && err.status < 500 ? err.message : 'Import failed; no rows were written.']).catch(() => {});
    }
    next(err);
  }
});

// POST /api/v1/imports/:id/cancel
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const batch = await loadBatch(req, req.params.id);
    if (['done', 'importing'].includes(batch.status)) throw new AppError(`Import is already ${batch.status}.`, 409);
    await query("UPDATE import_batches SET status = 'cancelled', parsed_rows = NULL, completed_at = NOW() WHERE id = $1", [batch.id]);
    return successResponse(res, { id: batch.id, status: 'cancelled' });
  } catch (err) { next(err); }
});

// GET /api/v1/imports/:id
router.get('/:id', async (req, res, next) => {
  try {
    const batch = await loadBatch(req, req.params.id);
    const { rows: errors } = await query(
      'SELECT row_number, column_name, error_code, message FROM import_row_errors WHERE batch_id = $1 ORDER BY row_number LIMIT 500',
      [batch.id],
    );
    const { parsed_rows: _omit, ...rest } = batch;
    return successResponse(res, { ...rest, errors });
  } catch (err) { next(err); }
});

// GET /api/v1/imports/:id/errors.csv
router.get('/:id/errors.csv', async (req, res, next) => {
  try {
    const batch = await loadBatch(req, req.params.id);
    const { rows } = await query(
      'SELECT row_number, column_name, error_code, message, raw_data FROM import_row_errors WHERE batch_id = $1 ORDER BY row_number',
      [batch.id],
    );
    const csv = toCsv(
      [{ key: 'row_number', label: 'row' }, { key: 'column_name', label: 'column' }, { key: 'error_code', label: 'code' },
        { key: 'message', label: 'message' }, { key: 'raw', label: 'original_row' }],
      rows.map((r) => ({ ...r, raw: r.raw_data ? JSON.stringify(r.raw_data) : '' })),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="import-errors-${batch.id.slice(0, 8)}.csv"`);
    return res.send(csv);
  } catch (err) { next(err); }
});

export default router;

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import ExcelJS from 'exceljs';
import { login, query, ids, closePool } from '../helpers/api.js';

let owner; let personal; let id;
beforeAll(async () => {
  [owner, personal] = await Promise.all([login('owner@demo.local'), login('personal@demo.local')]);
  id = await ids();
});
afterAll(closePool);

async function upload(client, entityType, ctx, filename, content) {
  let req = client.post('/api/v1/imports').field('entityType', entityType);
  for (const [k, v] of Object.entries(ctx)) req = req.field(k, v);
  return req.attach('file', Buffer.isBuffer(content) ? content : Buffer.from(content), filename);
}

describe('CSV sales import', () => {
  const csv = [
    'Kode Outlet;Tanggal;Omzet;Diskon;Retur;Jumlah Transaksi;Catatan',
    'WKN-BDG;01/01/2026;1.500.000;50.000;0;30;import test',
    'WKN-BDG;02/01/2026;1.250.000;0;0;25;',
    'WKN-BDG;02/01/2026;1.250.000;0;0;25;',                // duplicate inside the file
    'NOPE-01;03/01/2026;100;0;0;1;',                       // unknown outlet
    'WKN-BDG;31/02/2026;100;0;0;1;',                       // impossible date
    'WKN-BDG;04/01/2026;abc;0;0;1;',                       // not a number
    'WKN-BDG;05/01/2026;=HYPERLINK("http://x");0;0;1;',    // formula text is just invalid data
  ].join('\n');

  let batchId;
  it('uploads, suggests a column mapping and previews rows', async () => {
    const res = await upload(owner, 'sales', { orgId: id.org1 }, 'penjualan.csv', csv);
    expect(res.status).toBe(201);
    expect(res.body.data.totalRows).toBe(7);
    expect(res.body.data.suggestedMapping).toMatchObject({ outlet_code: 'Kode Outlet', date: 'Tanggal', gross_sales: 'Omzet' });
    batchId = res.body.data.id;
  });

  it('validates rows and reports every problem', async () => {
    const res = await owner.post(`/api/v1/imports/${batchId}/validate`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.validRows).toBe(2);
    const codes = res.body.data.errors.map((e) => e.code).sort();
    expect(codes).toEqual(['DUPLICATE_IN_FILE', 'INVALID_DATE', 'NOT_A_NUMBER', 'NOT_A_NUMBER', 'UNKNOWN_OUTLET'].sort());
  });

  it('imports valid rows in one transaction and is idempotent', async () => {
    const res = await owner.post(`/api/v1/imports/${batchId}/confirm`);
    expect(res.status).toBe(200);
    expect(res.body.data.importedRows).toBe(2);
    const { rows } = await query("SELECT gross_sales, discounts FROM sales_records WHERE import_batch_id = $1 ORDER BY sale_date", [batchId]);
    expect(rows.map((r) => Number(r.gross_sales))).toEqual([1500000, 1250000]);
    expect(Number(rows[0].discounts)).toBe(50000);

    const again = await owner.post(`/api/v1/imports/${batchId}/confirm`);
    expect(again.body.data.alreadyCompleted).toBe(true);

    // Same file uploaded again → everything is detected as already imported
    const re = await upload(owner, 'sales', { orgId: id.org1 }, 'penjualan.csv', csv);
    expect(re.body.data.previouslyImported).not.toBeNull();
    await owner.post(`/api/v1/imports/${re.body.data.id}/validate`).send({});
    const second = await owner.post(`/api/v1/imports/${re.body.data.id}/confirm`);
    expect(second.body.data.importedRows).toBe(0);
    expect(second.body.data.duplicateRows).toBeGreaterThanOrEqual(2);
  });

  it('offers a downloadable error report', async () => {
    const res = await owner.get(`/api/v1/imports/${batchId}/errors.csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toMatch(/UNKNOWN_OUTLET/);
  });

  it('rejects unsupported and spoofed files', async () => {
    expect((await upload(owner, 'sales', { orgId: id.org1 }, 'evil.exe', 'MZ')).status).toBe(415);
    expect((await upload(owner, 'sales', { orgId: id.org1 }, 'fake.xlsx', 'not a zip')).status).toBe(422);
    expect((await upload(owner, 'sales', { orgId: id.org1 }, 'macro.xlsm', 'PK')).status).toBe(415);
  });

  it('requires a mapping for required fields', async () => {
    const res = await upload(owner, 'sales', { orgId: id.org1 }, 'x.csv', 'a,b\n1,2\n');
    const v = await owner.post(`/api/v1/imports/${res.body.data.id}/validate`).send({ mapping: { outlet_code: 'a' } });
    expect(v.status).toBe(422);
  });
});

describe('XLSX broker statement import', () => {
  it('imports stock transactions in date order and checks holdings', async () => {
    const p = (await personal.post('/api/v1/portfolios').send({ name: 'Import target' })).body.data;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Trades');
    ws.addRow(['Trade Date', 'Side', 'Ticker', 'Qty', 'Price', 'Commission']);
    ws.addRow(['2025-03-05', 'SELL', 'BBCA', 50, 9000, 2000]);   // listed first, executed after the buy
    ws.addRow([new Date('2025-03-03'), 'BUY', 'BBCA', 100, 8800, 1300]);
    ws.addRow(['2025-03-06', 'SELL', 'BBCA', 500, 9000, 0]);    // more than held → rejected at confirmation
    ws.addRow(['2025-03-07', 'BUY', 'ZZZZ', 1, 1, 0]);          // unsupported instrument
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const up = await upload(personal, 'stock_transactions', { portfolioId: p.id }, 'statement.xlsx', buf);
    expect(up.status).toBe(201);
    const v = await personal.post(`/api/v1/imports/${up.body.data.id}/validate`).send({});
    expect(v.body.data.validRows).toBe(3);
    const c = await personal.post(`/api/v1/imports/${up.body.data.id}/confirm`);
    expect(c.body.data.importedRows).toBe(2);
    expect(c.body.data.errorRows).toBe(2);
    const h = (await personal.get(`/api/v1/portfolios/${p.id}/holdings`)).body.data.holdings[0];
    expect(h.openQty).toBe(50);
  });

  it('cannot import into another user’s portfolio', async () => {
    const { rows } = await query("SELECT p.id FROM portfolios p JOIN users u ON u.id = p.user_id WHERE u.email = 'personal@demo.local' LIMIT 1");
    const res = await upload(owner, 'stock_transactions', { portfolioId: rows[0].id }, 's.csv', 'date,type\n2025-01-01,buy\n');
    expect(res.status).toBe(404);
  });
});

describe('exports', () => {
  it('exports CSV, XLSX and PDF with access control and audit', async () => {
    const csv = await owner.get(`/api/v1/exports/sales?orgId=${id.org1}&format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="sales-/);
    const xlsx = await owner.get(`/api/v1/exports/franchise-pnl?orgId=${id.org1}&format=xlsx`).buffer(true).parse((res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
    expect(xlsx.status).toBe(200);
    expect(xlsx.body.readUInt32LE(0)).toBe(0x04034b50);
    const pdf = await owner.get(`/api/v1/exports/outlet-comparison?orgId=${id.org1}&format=pdf`).buffer(true).parse((res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
    expect(pdf.body.slice(0, 4).toString()).toBe('%PDF');
    const { rows } = await query("SELECT COUNT(*)::int n FROM audit_events WHERE action LIKE 'export.%'");
    expect(rows[0].n).toBeGreaterThanOrEqual(3);
  });

  it('neutralises spreadsheet formulas in exported text', async () => {
    await owner.post('/api/v1/sales').send({ outletId: id.outlet['WKN-BDG'], saleDate: '2025-12-31', grossSales: 1, notes: '=cmd|" /C calc"!A0' });
    const csv = await owner.get(`/api/v1/exports/sales?orgId=${id.org1}&from=2025-12-31&to=2025-12-31`);
    expect(csv.text).toContain("'=cmd");
    expect(csv.text).not.toMatch(/,=cmd/);
  });

  it('exports personal transactions', async () => {
    const res = await personal.get('/api/v1/exports/stock-transactions?format=csv');
    expect(res.status).toBe(200);
    expect(res.text.split('\n').length).toBeGreaterThan(5);
  });
});

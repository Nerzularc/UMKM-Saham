/**
 * Export renderers: CSV, XLSX and PDF.
 * columns: [{ key, label, type?: 'money'|'number'|'percent'|'date'|'text' }]
 */
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

/** Neutralise spreadsheet formula injection for text cells. */
export function safeText(value) {
  const s = String(value ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function csvCell(v, type) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || ['money', 'number', 'percent'].includes(type)) {
    const n = Number(v);
    if (Number.isFinite(n)) return String(v);
  }
  const s = safeText(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns, rows) {
  const head = columns.map((c) => csvCell(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c.key], c.type)).join(','));
  // BOM so Excel opens UTF-8 correctly
  return `﻿${[head, ...body].join('\r\n')}\r\n`;
}

export async function toXlsx(columns, rows, { title, subtitle, disclaimer } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'UMKM Saham';
  wb.created = new Date();
  const ws = wb.addWorksheet((title || 'Export').slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  let r = 1;
  if (title) { ws.getCell(r, 1).value = title; ws.getCell(r, 1).font = { bold: true, size: 14 }; r++; }
  if (subtitle) { ws.getCell(r, 1).value = subtitle; r++; }
  if (disclaimer) { ws.getCell(r, 1).value = disclaimer; ws.getCell(r, 1).font = { italic: true, color: { argb: 'FFB45309' } }; r++; }
  if (r > 1) r++;
  const headerRow = ws.getRow(r);
  columns.forEach((c, i) => { headerRow.getCell(i + 1).value = c.label; });
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
  for (const row of rows) {
    r++;
    const xr = ws.getRow(r);
    columns.forEach((c, i) => {
      const v = row[c.key];
      const cell = xr.getCell(i + 1);
      if (v === null || v === undefined || v === '') { cell.value = null; return; }
      if (['money', 'number', 'percent'].includes(c.type) && Number.isFinite(Number(v))) {
        cell.value = Number(v);
        cell.numFmt = c.type === 'money' ? '#,##0.00' : c.type === 'percent' ? '0.00"%"' : '#,##0.########';
      } else {
        cell.value = safeText(v);
      }
    });
  }
  columns.forEach((c, i) => { ws.getColumn(i + 1).width = Math.min(40, Math.max(12, c.label.length + 2)); });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function fmt(v, type) {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'money') return Number(v).toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  if (type === 'percent') return `${Number(v).toFixed(2)}%`;
  if (type === 'number') return Number(v).toLocaleString('id-ID', { maximumFractionDigits: 8 });
  return String(v);
}

export function toPdf(columns, rows, { title, subtitle, disclaimer } = {}) {
  return new Promise((resolve, reject) => {
    const landscape = columns.length > 6;
    const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36, info: { Title: title || 'Export', Producer: 'UMKM Saham' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - 72;
    doc.fontSize(14).font('Helvetica-Bold').text(title || 'Export');
    if (subtitle) doc.fontSize(9).font('Helvetica').fillColor('#475569').text(subtitle);
    if (disclaimer) doc.fontSize(8).fillColor('#b45309').text(disclaimer);
    doc.fillColor('#000').moveDown(0.6);

    const colW = width / columns.length;
    const drawHeader = () => {
      const y = doc.y;
      doc.rect(36, y - 2, width, 16).fill('#e2e8f0').fillColor('#0f172a');
      doc.font('Helvetica-Bold').fontSize(7.5);
      columns.forEach((c, i) => doc.text(c.label, 36 + i * colW + 2, y + 2, { width: colW - 4, ellipsis: true, lineBreak: false, align: ['money', 'number', 'percent'].includes(c.type) ? 'right' : 'left' }));
      doc.y = y + 18;
      doc.font('Helvetica').fontSize(7.5);
    };
    drawHeader();
    rows.forEach((row, idx) => {
      if (doc.y > doc.page.height - 50) { doc.addPage(); drawHeader(); }
      const y = doc.y;
      if (idx % 2) doc.rect(36, y - 2, width, 13).fill('#f8fafc');
      doc.fillColor('#0f172a');
      columns.forEach((c, i) => doc.text(fmt(row[c.key], c.type), 36 + i * colW + 2, y, { width: colW - 4, ellipsis: true, lineBreak: false, align: ['money', 'number', 'percent'].includes(c.type) ? 'right' : 'left' }));
      doc.y = y + 13;
    });
    if (!rows.length) doc.text('No data for the selected filters.');
    doc.moveDown().fontSize(7).fillColor('#64748b').text(`Generated ${new Date().toISOString()} · ${rows.length} row(s)`, 36);
    doc.end();
  });
}

export async function render(format, columns, rows, meta) {
  if (format === 'xlsx') return { body: await toXlsx(columns, rows, meta), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
  if (format === 'pdf') return { body: await toPdf(columns, rows, meta), type: 'application/pdf', ext: 'pdf' };
  return { body: toCsv(columns, rows), type: 'text/csv; charset=utf-8', ext: 'csv' };
}

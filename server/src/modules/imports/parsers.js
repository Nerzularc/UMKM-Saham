/**
 * Safe spreadsheet parsing.
 *  - Only .csv and .xlsx are accepted (no .xls/.xlsm: legacy/macro formats).
 *  - XLSX files must start with the ZIP signature; formulas are never evaluated,
 *    only their cached results are read.
 *  - Row and column counts are capped.
 */
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { AppError } from '../../utils/errors.js';

export const MAX_ROWS = parseInt(process.env.MAX_IMPORT_ROWS || '10000', 10);
const MAX_COLS = 60;

export function detectFormat(filename, buffer) {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    if (buffer.includes(0)) throw new AppError('The CSV file contains binary data.', 422);
    return 'csv';
  }
  if (name.endsWith('.xlsx')) {
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw new AppError('The file is not a valid .xlsx workbook.', 422);
    return 'xlsx';
  }
  throw new AppError('Unsupported file type. Upload a .csv or .xlsx file.', 415);
}

function normaliseHeader(h, i) {
  const s = String(h ?? '').replace(/^﻿/, '').trim();
  return s || `column_${i + 1}`;
}

function cellValue(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);      // formula → cached result only
    if ('text' in v) return String(v.text);             // hyperlink
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('error' in v) return '';
    return '';
  }
  return typeof v === 'string' ? v.trim() : v;
}

export async function parseSpreadsheet(buffer, filename) {
  const format = detectFormat(filename, buffer);
  let headers;
  let rows;

  if (format === 'csv') {
    const text = buffer.toString('utf8');
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const delimiter = [';', '\t', ','].reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ',');
    let records;
    try {
      records = parseCsv(text, { delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, bom: true, to_line: MAX_ROWS + 1 });
    } catch (e) {
      throw new AppError(`Could not read CSV: ${e.message}`, 422);
    }
    if (!records.length) throw new AppError('The file is empty.', 422);
    headers = records[0].slice(0, MAX_COLS).map(normaliseHeader);
    rows = records.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
  } else {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer);
    } catch {
      throw new AppError('The workbook could not be read.', 422);
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new AppError('The workbook has no worksheets.', 422);
    headers = [];
    rows = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const values = row.values.slice(1, MAX_COLS + 1).map(cellValue);
      if (rowNumber === 1 || !headers.length) {
        headers = values.map(normaliseHeader);
        return;
      }
      if (rows.length >= MAX_ROWS) return;
      if (values.every((v) => v === '' || v == null)) return;
      rows.push(Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ''])));
    });
    if (!headers.length) throw new AppError('The file is empty.', 422);
  }

  if (rows.length > MAX_ROWS) rows = rows.slice(0, MAX_ROWS);
  return { format, headers, rows, truncated: rows.length >= MAX_ROWS };
}

/** Parse numbers written as 1.234.567,89 (id-ID) or 1,234,567.89 (en-US). */
export function parseNumber(value) {
  if (value === '' || value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : NaN;
  let s = String(value).trim().replace(/\s|Rp|IDR|USD|\$/gi, '');
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    const decimals = s.length - lastComma - 1;
    s = (s.match(/,/g).length === 1 && decimals !== 3) ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (lastDot > -1 && (s.match(/\./g).length > 1 || s.length - lastDot - 1 === 3)) {
    // "1.500.000" → thousands separators
    s = s.replace(/\./g, '');
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return neg ? `-${s}` : s;
}

/** Accepts YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, and Excel serial dates. */
export function parseDate(value) {
  if (value === '' || value == null) return null;
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return valid(m[3], m[2], m[1]); // day-first (Indonesian convention)
  return 'invalid';
}

function valid(y, mo, d) {
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === iso ? iso : 'invalid';
}

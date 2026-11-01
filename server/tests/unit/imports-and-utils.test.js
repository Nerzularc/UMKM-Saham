import { describe, it, expect } from '@jest/globals';
import { parseNumber, parseDate, detectFormat, parseSpreadsheet } from '../../src/modules/imports/parsers.js';
import { suggestMapping, fingerprint } from '../../src/modules/imports/entities.js';
import { safeText, toCsv } from '../../src/modules/reports/export.service.js';
import { totp, verifyTotp, base32Encode, base32Decode, encryptSecret, decryptSecret, generateSecret } from '../../src/utils/totp.js';
import { roleHas, PERMISSIONS as P, ASSIGNABLE_ROLES, isUuid } from '../../src/services/permissions.js';
import { proratedTarget, targetRange } from '../../src/modules/franchise/franchise.service.js';
import { resolvePeriod, previousPeriod } from '../../src/utils/dates.js';

describe('number parsing (Indonesian and English formats)', () => {
  it.each([
    ['1.500.000', '1500000'], ['1.500.000,50', '1500000.50'], ['1,500,000.50', '1500000.50'],
    ['Rp 25.000', '25000'], ['12,5', '12.5'], ['(1.000)', '-1000'], ['9750', '9750'], [42, '42'], ['', null],
  ])('%s → %s', (input, expected) => expect(parseNumber(input)).toBe(expected));
  it('flags text as NaN', () => expect(parseNumber('abc')).toBeNaN());
});

describe('date parsing', () => {
  it('accepts ISO, day-first and Excel serials; rejects impossible dates', () => {
    expect(parseDate('2026-01-31')).toBe('2026-01-31');
    expect(parseDate('31/01/2026')).toBe('2026-01-31');
    expect(parseDate('5-1-2026')).toBe('2026-01-05');
    expect(parseDate(45658)).toBe('2025-01-01');
    expect(parseDate('31/02/2026')).toBe('invalid');
    expect(parseDate('yesterday')).toBe('invalid');
  });
});

describe('file handling', () => {
  it('detects formats by extension and signature', () => {
    expect(detectFormat('a.csv', Buffer.from('a,b'))).toBe('csv');
    expect(() => detectFormat('a.xlsx', Buffer.from('nope'))).toThrow();
    expect(() => detectFormat('a.xls', Buffer.from('x'))).toThrow();
  });
  it('parses semicolon CSV with BOM', async () => {
    const r = await parseSpreadsheet(Buffer.from('﻿a;b\n1;2\n'), 'x.csv');
    expect(r.headers).toEqual(['a', 'b']);
    expect(r.rows).toEqual([{ a: '1', b: '2' }]);
  });
  it('suggests column mappings from aliases', () => {
    expect(suggestMapping('sales', ['Kode Outlet', 'Tanggal', 'Omzet'])).toEqual({ outlet_code: 'Kode Outlet', date: 'Tanggal', gross_sales: 'Omzet' });
  });
  it('produces stable fingerprints', () => {
    expect(fingerprint('sales', ['a', 1])).toBe(fingerprint('sales', ['a', '1']));
    expect(fingerprint('sales', ['a', 1])).not.toBe(fingerprint('sales', ['a', 2]));
  });
});

describe('export safety', () => {
  it('prefixes formula-like text', () => {
    expect(safeText('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(safeText('@cmd')).toBe("'@cmd");
    expect(safeText('normal')).toBe('normal');
  });
  it('keeps numbers numeric and quotes separators', () => {
    const csv = toCsv([{ key: 'a', label: 'A', type: 'money' }, { key: 'b', label: 'B' }], [{ a: '-100.50', b: 'x,y' }]);
    expect(csv).toContain('-100.50,"x,y"');
  });
});

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 test vector', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totp(secret, 59 * 1000)).toBe('287082');
    expect(totp(secret, 1111111109 * 1000)).toBe('081804');
    expect(verifyTotp(secret, '287082', 59 * 1000)).toBe(true);
    expect(verifyTotp(secret, '000000', 59 * 1000)).toBe(false);
  });
  it('round-trips base32 and encrypts secrets', () => {
    const s = generateSecret();
    expect(base32Encode(base32Decode(s))).toBe(s);
    const enc = encryptSecret(s);
    expect(enc).not.toContain(s);
    expect(decryptSecret(enc)).toBe(s);
  });
});

describe('permission model', () => {
  it('denies by default and grants only listed permissions', () => {
    expect(roleHas('org_owner', P.MEMBERS_MANAGE)).toBe(true);
    expect(roleHas('manager', P.MEMBERS_MANAGE)).toBe(false);
    expect(roleHas('staff', P.FINANCIALS_READ)).toBe(false);
    expect(roleHas('staff', P.DATA_EXPORT)).toBe(false);
    expect(roleHas('unknown', P.FRANCHISE_READ)).toBe(false);
    expect(ASSIGNABLE_ROLES).not.toContain('org_owner');
    expect(isUuid('x')).toBe(false);
  });
});

describe('targets and periods', () => {
  it('computes target ranges', () => {
    expect(targetRange({ period_type: 'monthly', period_year: 2026, period_value: 2 })).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(targetRange({ period_type: 'weekly', period_year: 2026, period_value: 1 })).toEqual({ from: '2025-12-29', to: '2026-01-04' });
    expect(targetRange({ period_type: 'yearly', period_year: 2026 })).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });
  it('pro-rates targets for partial periods', () => {
    const t = [{ period_type: 'monthly', period_year: 2026, period_value: 4, target_amount: '30000000' }];
    expect(proratedTarget(t, { from: '2026-04-01', to: '2026-04-10' })).toBe(10000000);
    expect(proratedTarget(t, { from: '2026-03-01', to: '2026-05-31' })).toBe(30000000);
    expect(proratedTarget(t, { from: '2026-05-01', to: '2026-05-31' })).toBeNull();
  });
  it('builds comparable previous periods', () => {
    const p = resolvePeriod({ from: '2026-03-01', to: '2026-03-31' });
    expect(previousPeriod(p)).toEqual({ from: '2026-01-29', to: '2026-02-28', days: 31 });
    expect(() => resolvePeriod({ from: '2026-04-01', to: '2026-03-01' })).toThrow();
  });
});

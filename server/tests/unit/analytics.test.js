import { describe, it, expect } from '@jest/globals';
import { calcTWR, calcXIRR, cashEffect, calcWAC, calcFIFO, calcHoldingMetrics } from '../../src/services/financialCalculations.js';

describe('cashEffect', () => {
  it('signs every transaction type in base currency', () => {
    expect(cashEffect({ transaction_type: 'deposit', total_amount: '100' }).toNumber()).toBe(100);
    expect(cashEffect({ transaction_type: 'withdrawal', total_amount: '40' }).toNumber()).toBe(-40);
    expect(cashEffect({ transaction_type: 'buy', quantity: '10', price: '5', fee: '1', exchange_rate: '2' }).toNumber()).toBe(-102);
    expect(cashEffect({ transaction_type: 'sell', quantity: '10', price: '5', fee: '1' }).toNumber()).toBe(49);
    expect(cashEffect({ transaction_type: 'dividend', total_amount: '3', exchange_rate: '10' }).toNumber()).toBe(30);
    expect(cashEffect({ transaction_type: 'fee', total_amount: '2' }).toNumber()).toBe(-2);
    expect(cashEffect({ transaction_type: 'split', quantity: '2' }).toNumber()).toBe(0);
  });
});

describe('calcTWR', () => {
  it('chains sub-period returns and neutralises external flows', () => {
    // 100 → 110 (+10%), then +100 deposit and value 221 → 10% again: TWR = 21%
    const twr = calcTWR([{ value: 100, flow: 0 }, { value: 110, flow: 0 }, { value: 221, flow: 100 }]);
    expect(twr).toBeCloseTo(21, 6);
  });
  it('ignores periods with no capital and returns null without data', () => {
    expect(calcTWR([{ value: 0, flow: 0 }, { value: 100, flow: 100 }, { value: 105, flow: 0 }])).toBeCloseTo(5, 6);
    expect(calcTWR([{ value: 0, flow: 0 }])).toBeNull();
  });
});

describe('calcXIRR', () => {
  it('finds the annual rate for a one-year 10% gain', () => {
    expect(calcXIRR([{ date: '2024-01-01', amount: -1000 }, { date: '2024-12-31', amount: 1100 }])).toBeCloseTo(10.03, 1);
  });
  it('differs from TWR when money arrives late (money-weighted)', () => {
    const mwr = calcXIRR([
      { date: '2024-01-01', amount: -100 }, { date: '2024-07-01', amount: -1000 }, { date: '2024-12-31', amount: 1150 },
    ]);
    expect(mwr).toBeGreaterThan(0);
    expect(mwr).toBeLessThan(10);
  });
  it('returns null when undeterminable', () => {
    expect(calcXIRR([{ date: '2024-01-01', amount: 100 }])).toBeNull();
    expect(calcXIRR([{ date: '2024-01-01', amount: -100 }, { date: '2024-02-01', amount: -5 }])).toBeNull();
  });
});

describe('return on invested capital', () => {
  it('keeps a return % for fully closed positions', () => {
    const state = calcWAC([
      { transaction_type: 'buy', quantity: 10, price: 100, fee: 0 },
      { transaction_type: 'sell', quantity: 10, price: 120, fee: 0 },
    ]);
    const m = calcHoldingMetrics(state, 130);
    expect(m.openQty).toBe(0);
    expect(m.realisedPnl).toBe(200);
    expect(m.totalReturnPct).toBe(20);
  });
  it('FIFO and WAC agree on totals once a position is closed', () => {
    const txs = [
      { transaction_type: 'buy', quantity: 10, price: 100, fee: 1 },
      { transaction_type: 'buy', quantity: 10, price: 200, fee: 1 },
      { transaction_type: 'sell', quantity: 20, price: 180, fee: 2 },
    ];
    expect(calcFIFO(txs).realisedPnl).toBe(calcWAC(txs).realisedPnl);
  });
  it('does not double count fees', () => {
    const s = calcWAC([{ transaction_type: 'buy', quantity: 1, price: 100, fee: 10 }]);
    const m = calcHoldingMetrics(s, 100);
    expect(m.costBasis).toBe(110);
    expect(m.unrealisedPnl).toBe(-10);
    expect(m.totalReturn).toBe(-10);
  });
});

import { describe, it, expect } from '@jest/globals';
import {
  calcWAC,
  calcFIFO,
  calcHoldingMetrics,
  calcFranchisePnL,
  calcTargetAchievement,
  calcGrowth,
  calcATV,
  toFixed,
  safeDivide,
} from '../../src/services/financialCalculations.js';

// ── WAC Tests ─────────────────────────────────────────────────────────────────
describe('calcWAC', () => {
  it('calculates simple buy position', () => {
    const txns = [
      { transaction_type: 'buy', quantity: 100, price: 1000, fee: 5000, exchange_rate: 1 },
    ];
    const result = calcWAC(txns);
    // Cost = 100 * 1000 + 5000 = 105000
    expect(result.openQty).toBe(100);
    expect(result.totalCostBasis).toBe(105000);
    expect(result.wac).toBe(1050);
    expect(result.realisedPnl).toBe(0);
  });

  it('calculates WAC across multiple buys', () => {
    const txns = [
      { transaction_type: 'buy', quantity: 100, price: 1000, fee: 0, exchange_rate: 1 },
      { transaction_type: 'buy', quantity: 100, price: 1200, fee: 0, exchange_rate: 1 },
    ];
    const result = calcWAC(txns);
    expect(result.openQty).toBe(200);
    expect(result.wac).toBe(1100);
    expect(result.totalCostBasis).toBe(220000);
  });

  it('calculates realised P&L on sell using WAC', () => {
    const txns = [
      { transaction_type: 'buy',  quantity: 100, price: 1000, fee: 0, exchange_rate: 1 },
      { transaction_type: 'sell', quantity: 50,  price: 1200, fee: 0, exchange_rate: 1 },
    ];
    const result = calcWAC(txns);
    // WAC = 1000. Sell 50 at 1200. Proceeds = 60000, cost = 50000. Gain = 10000
    expect(result.openQty).toBe(50);
    expect(result.realisedPnl).toBe(10000);
    expect(result.totalCostBasis).toBe(50000);
  });

  it('tracks dividends separately', () => {
    const txns = [
      { transaction_type: 'buy',      quantity: 100,  price: 1000, fee: 0, exchange_rate: 1 },
      { transaction_type: 'dividend', quantity: null, price: null, fee: 0, exchange_rate: 1, total_amount: 5000 },
    ];
    const result = calcWAC(txns);
    expect(result.dividends).toBe(5000);
    expect(result.totalCostBasis).toBe(100000); // cost basis unchanged by dividend
  });

  it('applies exchange rate to buy cost', () => {
    const txns = [
      { transaction_type: 'buy', quantity: 10, price: 100, fee: 0, exchange_rate: 15000 },
    ];
    const result = calcWAC(txns);
    // 10 * 100 * 15000 = 15,000,000
    expect(result.totalCostBasis).toBe(15000000);
    expect(result.wac).toBe(1500000);
  });

  it('handles sell beyond available quantity gracefully', () => {
    const txns = [
      { transaction_type: 'buy',  quantity: 10, price: 100, fee: 0, exchange_rate: 1 },
      { transaction_type: 'sell', quantity: 15, price: 120, fee: 0, exchange_rate: 1 },
    ];
    const result = calcWAC(txns);
    expect(result.openQty).toBe(0); // clamps to 0
    expect(result.totalCostBasis).toBe(0);
  });

  it('handles stock split correctly', () => {
    const txns = [
      { transaction_type: 'buy',   quantity: 100, price: 2000, fee: 0, exchange_rate: 1 },
      { transaction_type: 'split', quantity: 2,   price: null, fee: 0, exchange_rate: 1 },
    ];
    const result = calcWAC(txns);
    expect(result.openQty).toBe(200);
    expect(result.totalCostBasis).toBe(200000); // unchanged
    expect(result.wac).toBe(1000); // halved
  });
});

// ── FIFO Tests ────────────────────────────────────────────────────────────────
describe('calcFIFO', () => {
  it('calculates FIFO realised P&L correctly', () => {
    const txns = [
      { transaction_type: 'buy',  quantity: 100, price: 1000, fee: 0, exchange_rate: 1, transaction_date: '2024-01-01' },
      { transaction_type: 'buy',  quantity: 100, price: 1200, fee: 0, exchange_rate: 1, transaction_date: '2024-02-01' },
      { transaction_type: 'sell', quantity: 50,  price: 1300, fee: 0, exchange_rate: 1, transaction_date: '2024-03-01' },
    ];
    const result = calcFIFO(txns);
    // First 50 shares at cost 1000. Sell at 1300. Gain = 50 * (1300-1000) = 15000
    expect(result.realisedPnl).toBe(15000);
    expect(result.openQty).toBe(150);
  });

  it('uses correct lots for FIFO sell', () => {
    const txns = [
      { transaction_type: 'buy',  quantity: 100, price: 1000, fee: 0, exchange_rate: 1, transaction_date: '2024-01-01' },
      { transaction_type: 'buy',  quantity: 100, price: 1200, fee: 0, exchange_rate: 1, transaction_date: '2024-02-01' },
      { transaction_type: 'sell', quantity: 150, price: 1300, fee: 0, exchange_rate: 1, transaction_date: '2024-03-01' },
    ];
    const result = calcFIFO(txns);
    // First 100 at 1000 → gain 300 each = 30000
    // Next 50 at 1200  → gain 100 each = 5000
    // Total = 35000
    expect(result.realisedPnl).toBe(35000);
    expect(result.openQty).toBe(50);
  });
});

// ── calcHoldingMetrics Tests ──────────────────────────────────────────────────
describe('calcHoldingMetrics', () => {
  it('computes unrealised P&L and percentages', () => {
    const holding = { openQty: 100, totalCostBasis: 100000, realisedPnl: 0, dividends: 0, fees: 0, wac: 1000 };
    const metrics = calcHoldingMetrics(holding, 1200);
    expect(metrics.marketValue).toBe(120000);
    expect(metrics.unrealisedPnl).toBe(20000);
    expect(metrics.unrealisedPct).toBe(20);
  });

  it('handles zero price gracefully', () => {
    const holding = { openQty: 100, totalCostBasis: 100000, realisedPnl: 0, dividends: 0, fees: 0, wac: 1000 };
    const metrics = calcHoldingMetrics(holding, 0);
    expect(metrics.marketValue).toBe(0);
    expect(metrics.unrealisedPnl).toBe(-100000);
  });

  it('returns null percentage when cost basis is zero', () => {
    const holding = { openQty: 0, totalCostBasis: 0, realisedPnl: 5000, dividends: 0, fees: 0, wac: 0 };
    const metrics = calcHoldingMetrics(holding, 1200);
    expect(metrics.unrealisedPct).toBeNull();
  });
});

// ── Franchise P&L Tests ───────────────────────────────────────────────────────
describe('calcFranchisePnL', () => {
  it('computes standard P&L correctly', () => {
    const result = calcFranchisePnL({
      grossSales: 100000000,
      discounts: 5000000,
      returns: 1000000,
      cogs: 40000000,
      operatingExpenses: 25000000,
    });
    expect(result.netSales).toBe(94000000);
    expect(result.grossProfit).toBe(54000000);
    expect(result.grossMarginPct).toBeCloseTo(57.45, 1);
    expect(result.operatingProfit).toBe(29000000);
    expect(result.netProfit).toBe(29000000);
    expect(result.netMarginPct).toBeCloseTo(30.85, 1);
  });

  it('handles zero sales without division error', () => {
    const result = calcFranchisePnL({
      grossSales: 0, discounts: 0, returns: 0, cogs: 0, operatingExpenses: 0,
    });
    expect(result.grossMarginPct).toBe(0);
    expect(result.netMarginPct).toBe(0);
  });

  it('handles negative profit (loss) correctly', () => {
    const result = calcFranchisePnL({
      grossSales: 10000000,
      discounts: 0, returns: 0,
      cogs: 8000000,
      operatingExpenses: 5000000,
    });
    expect(result.operatingProfit).toBe(-3000000);
    expect(result.netMarginPct).toBeLessThan(0);
  });
});

// ── Target achievement ────────────────────────────────────────────────────────
describe('calcTargetAchievement', () => {
  it('calculates 100% achievement', () => {
    expect(calcTargetAchievement(50000000, 50000000)).toBe(100);
  });

  it('calculates partial achievement', () => {
    expect(calcTargetAchievement(45000000, 50000000)).toBe(90);
  });

  it('calculates over-achievement', () => {
    expect(calcTargetAchievement(60000000, 50000000)).toBe(120);
  });
});

// ── Growth ────────────────────────────────────────────────────────────────────
describe('calcGrowth', () => {
  it('calculates positive growth', () => {
    expect(calcGrowth(110, 100)).toBe(10);
  });

  it('calculates negative growth', () => {
    expect(calcGrowth(90, 100)).toBe(-10);
  });

  it('returns null for zero previous period', () => {
    expect(calcGrowth(50, 0)).toBeNull();
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
describe('safeDivide', () => {
  it('returns 0 for zero denominator by default', () => {
    const result = safeDivide(100, 0);
    expect(result.toNumber()).toBe(0);
  });

  it('divides correctly', () => {
    const result = safeDivide(10, 4);
    expect(result.toNumber()).toBe(2.5);
  });
});

describe('toFixed', () => {
  it('rounds to 2 decimal places', () => {
    expect(toFixed(10.555, 2)).toBe(10.56);
  });

  it('handles null/undefined gracefully', () => {
    expect(toFixed(null, 2)).toBe(0);
  });
});

describe('calcATV', () => {
  it('calculates average transaction value', () => {
    expect(calcATV(100000, 50)).toBe(2000);
  });

  it('returns 0 for zero transaction count', () => {
    expect(calcATV(100000, 0)).toBe(0);
  });
});

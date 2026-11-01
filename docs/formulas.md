# Financial definitions

All calculations live in `server/src/services/financialCalculations.js`,
`modules/stocks/portfolio.service.js` and `modules/franchise/franchise.service.js`,
use `decimal.js`, and are covered by unit/integration tests.

## Stock portfolios

**Amounts in base currency.** Each transaction stores `exchange_rate` (transaction
currency → portfolio base currency). If not supplied, the latest stored rate on or
before the transaction date is used; if none exists the transaction is rejected.
Current valuation uses the latest stored rate. Different base currencies are never
summed together.

| Item | Rule |
|---|---|
| Buy cost | (quantity × price + fee) × rate — fees are capitalised into cost basis |
| Sale proceeds | (quantity × price − fee) × rate |
| WAC | cost basis ÷ open quantity; a sale removes `WAC × qty` from cost basis |
| FIFO | sales consume the oldest lots first; each lot's cost/unit includes its buy fee |
| Realised P/L | net sale proceeds − cost basis of units sold |
| Market value | current price × rate × open quantity |
| Unrealised P/L | market value − remaining cost basis |
| Dividends | `total_amount` = **net** cash received × rate (no further deduction) |
| Account fees | `fee` transactions (custody etc.) |
| Total return | realised + unrealised + dividends − account fees (trading fees are already inside cost/proceeds, so nothing is double counted) |
| Return % | total return ÷ invested capital (sum of all purchase costs), so closed positions keep a % |
| Split | quantity × ratio; total cost basis unchanged (WAC per unit ÷ ratio) |
| Cash | deposits − withdrawals − buy costs + sale proceeds + dividends − account fees |

Overselling (selling more than held on that date) is rejected, as are edits/deletes
that would leave a later sale uncovered.

**Missing prices.** A holding with no price or no FX rate is reported with
`marketValue = null` and a warning; portfolio totals mark `complete = false`.
Prices older than 24 h are flagged stale.

### Performance measures (not interchangeable)

- **Time-weighted return (TWR):** daily (or sampled) sub-period returns
  `r_t = (V_t − F_t) / V_{t−1} − 1`, chained geometrically. `F_t` is the net external
  flow on day t, assumed at end of day. Removes the effect of when money was added.
- **Money-weighted return (MWR):** annualised internal rate of return (XIRR, solved
  by bisection) of the investor's cash flows plus the ending value. Reflects timing
  and size of contributions.
- **External flows:** portfolios with deposits/withdrawals use those flows and value
  = positions + cash. Holdings-only portfolios treat purchases as contributions and
  sale proceeds/dividends as distributions; value = positions.
- **Valuation price on date d:** latest close in `price_observations` on/before d;
  if none exists yet, the latest recorded trade price (noted in the response).
- Long histories are sampled to ≤ ~370 points; returns are computed on those points.

## Franchise

| Metric | Formula |
|---|---|
| Net sales | gross sales − discounts − returns/refunds (stored as a generated column) |
| Gross profit | net sales − COGS (expense categories of type `cogs`) |
| Gross margin % | gross profit ÷ net sales × 100 |
| Operating profit | gross profit − operating expenses (`operating`) |
| Net profit | operating profit − non-operating expenses (`non_operating`) − taxes (`tax`) |
| Net margin % | net profit ÷ net sales × 100 |
| ATV | net sales ÷ completed transactions |
| Target achievement % | actual net sales ÷ target × 100 |
| Growth % | (current − previous) ÷ \|previous\| × 100; previous = the equally long period immediately before |

- Zero denominators return 0 for margins/ATV and `null` for growth/achievement
  (shown as "—"). Negative results are kept as negative values.
- **Taxes, cancelled transactions:** sales are recorded net of VAT/PB1 collected on
  behalf of the government; cancelled transactions are not recorded (refunds of
  completed sales go to *returns*). Income tax is an expense of type `tax`.
- **Targets:** each target covers a date range (daily = day-of-year, weekly = ISO
  week, monthly, yearly). For an arbitrary period the target is **pro-rated by
  overlapping days**: a 30 M monthly target over 10 of 30 days counts as 10 M.
- **Partial periods:** outlets that opened after the period start are flagged
  `partialPeriod` in comparisons. Outlets are *underperforming* when achievement
  < 80% or net profit < 0.
- **Inventory value:** quantity × product unit cost, only for products with a cost;
  the number of unvalued items is reported.
- All figures are actual recorded amounts — nothing is estimated or extrapolated.

## Rounding
Money is rounded half-up to 2 decimals at the API boundary; prices to 6, quantities
to 8, FX rates to 8. Intermediate values keep 28 significant digits.

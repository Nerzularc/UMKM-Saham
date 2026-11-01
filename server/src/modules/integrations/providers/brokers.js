/**
 * Broker integration registry.
 *
 * Adapter interface (for future providers):
 *   name, capabilities: { statementImport, readOnlySync, orderExecution },
 *   configured(): boolean,
 *   syncHoldings(connection), syncTransactions(connection, since),
 *   submitOrder(connection, order, { idempotencyKey })   // only if orderExecution
 *
 * No broker API adapter ships with this release: Indonesian retail brokers do
 * not offer a public, documented trading/sync API that can be integrated here
 * without a commercial agreement. Broker statements can be imported as CSV/XLSX
 * through the import framework ("stock_transactions" entity).
 */
export const BROKER_ADAPTERS = [];

export const CSV_STATEMENT_IMPORT = {
  name: 'csv_statement',
  label: 'Broker statement (CSV/XLSX import)',
  capabilities: { statementImport: true, readOnlySync: false, orderExecution: false },
  configured: true,
};

export function brokerStatus() {
  return {
    adapters: [CSV_STATEMENT_IMPORT, ...BROKER_ADAPTERS.map((a) => ({ name: a.name, capabilities: a.capabilities, configured: a.configured() }))],
    orderExecutionAvailable: BROKER_ADAPTERS.some((a) => a.capabilities.orderExecution && a.configured()),
  };
}

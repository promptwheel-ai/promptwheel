/**
 * Database adapter exports
 */
export {
  type QueryResult,
  type TransactionClient,
  type Migration,
  type MigrationResult,
  type QueryLogConfig,
  type QueryStats,
  type DatabaseAdapter,
  type DatabaseAdapterFactory,
  type DatabaseConfig,
  detectDatabaseType,
  getDefaultDatabaseUrl,
} from './adapter.js';

// Contract tests
export {
  runAdapterContract,
  formatContractResults,
  type ContractTestResult,
  type ContractSuiteResult,
} from './contract.js';

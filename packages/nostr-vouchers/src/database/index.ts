/**
 * Database exports
 */

export {
  createSharedDatabase,
  openSharedDatabase,
  sharedDatabaseExists,
  deleteSharedDatabase,
  getSharedDatabaseInfo,
  upgradeSharedDatabase,
  VOUCHER_STORES,
  VOUCHER_STORE_INDEXES,
  VOUCHER_STORE_DEFINITIONS,
  DEFAULT_SHARED_DB_NAME,
  DEFAULT_SHARED_DB_VERSION,
  type StoreDefinition,
  type SharedDatabaseConfig,
} from './SharedDatabase';

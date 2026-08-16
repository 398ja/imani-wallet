/**
 * Default adapter implementations for @imani/dm-poll
 */

export {
  BrowserStorageAdapter,
  createBrowserStorageAdapter,
} from './BrowserStorageAdapter';
export type { BrowserStorageAdapterOptions } from './BrowserStorageAdapter';

export {
  NoopUiAdapter,
  createNoopUiAdapter,
} from './NoopUiAdapter';

export {
  ConsoleUiAdapter,
  createConsoleUiAdapter,
} from './ConsoleUiAdapter';
export type { ConsoleUiAdapterOptions } from './ConsoleUiAdapter';

export {
  DefaultCryptoAdapter,
  createDefaultCryptoAdapter,
} from './DefaultCryptoAdapter';
export type { DefaultCryptoAdapterOptions } from './DefaultCryptoAdapter';

/**
 * Test setup file
 * Configures fake-indexeddb for testing
 */

import 'fake-indexeddb/auto';

// Set up global mocks for browser APIs
if (typeof globalThis.crypto === 'undefined') {
  // Use Node.js crypto for tests
  const { webcrypto } = await import('crypto');
  globalThis.crypto = webcrypto as Crypto;
}
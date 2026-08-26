/**
 * Token Security Integration Module
 *
 * Bridges the @imani/token-security package with the vanilla JS wallet apps.
 * Provides SHA-256 based token fingerprinting and global redemption locking.
 *
 * Features:
 * - SHA-256 token fingerprinting using sorted proof secrets + mint URL
 * - Global redemption mutex to prevent race conditions
 * - Token decoding utilities (cashuA/cashuB)
 *
 * Usage:
 * 1. Load token-security.browser.js before this script
 * 2. Call TokenSecurityIntegration.init() after page load
 * 3. Use TokenSecurity.getFingerprint(token) for duplicate detection
 * 4. Use TokenSecurity.acquireLock(fp, source) before redemption
 *
 * @module tokenSecurityIntegration
 */

console.log('[tokenSecurityIntegration] Module loaded v1');

/**
 * Token size and chunk limits (OWASP A10: DoS Prevention)
 */
const TOKEN_LIMITS = {
  /** Maximum token size in bytes (100KB) */
  MAX_TOKEN_SIZE_BYTES: 100 * 1024,

  /** Maximum number of chunks for NIP-60 events (50 chunks) */
  MAX_CHUNK_COUNT: 50,

  /** Maximum proof count per token */
  MAX_PROOF_COUNT: 1000
};

const TokenSecurityIntegration = {
  // Integration state
  _initialized: false,
  _fingerprinter: null,
  _lock: null,

  /**
   * Initialize the token security integration.
   * Must be called before using TokenSecurity functions.
   *
   * @returns {boolean} True if initialization succeeded
   */
  init() {
    if (this._initialized) {
      console.log('[tokenSecurityIntegration] Already initialized');
      return true;
    }

    if (typeof ImaniTokenSecurity === 'undefined') {
      console.error('[tokenSecurityIntegration] ImaniTokenSecurity not loaded. Include lib/token-security.browser.js');
      return false;
    }

    try {
      // Create the browser crypto adapter
      const cryptoAdapter = new ImaniTokenSecurity.BrowserCryptoAdapter();

      // Create the fingerprinter
      this._fingerprinter = new ImaniTokenSecurity.TokenFingerprinter({
        crypto: cryptoAdapter,
      });

      // Get the global redemption lock singleton
      this._lock = ImaniTokenSecurity.getGlobalRedemptionLock();

      this._initialized = true;
      console.log('[tokenSecurityIntegration] Initialized successfully');
      return true;
    } catch (error) {
      console.error('[tokenSecurityIntegration] Initialization failed:', error);
      return false;
    }
  },

  /**
   * Check if the integration is initialized.
   *
   * @returns {boolean} True if initialized
   */
  isInitialized() {
    return this._initialized;
  },

  /**
   * Get the fingerprinter instance.
   *
   * @returns {TokenFingerprinter|null} The fingerprinter or null if not initialized
   */
  getFingerprinter() {
    return this._fingerprinter;
  },

  /**
   * Get the redemption lock instance.
   *
   * @returns {RedemptionLock|null} The lock or null if not initialized
   */
  getLock() {
    return this._lock;
  },
};

/**
 * Token validation result
 * @typedef {Object} TokenValidationResult
 * @property {boolean} valid - Whether the token passes all checks
 * @property {string} [error] - Error message if invalid
 * @property {number} [size] - Token size in bytes
 * @property {number} [proofCount] - Number of proofs
 */

/**
 * Global token security utilities.
 * Exposed on window for use by other modules.
 */
const TokenSecurity = {
  /**
   * Token size and chunk limits
   */
  LIMITS: TOKEN_LIMITS,

  /**
   * Validate token size and structure (OWASP A10: DoS Prevention)
   *
   * @param {string} token - The token string
   * @returns {TokenValidationResult} Validation result
   */
  validateTokenLimits(token) {
    if (!token || typeof token !== 'string') {
      return { valid: false, error: 'Invalid token: not a string' };
    }

    // Check size limit
    const sizeBytes = new Blob([token]).size;
    if (sizeBytes > TOKEN_LIMITS.MAX_TOKEN_SIZE_BYTES) {
      console.warn('[TokenSecurity] Token exceeds size limit:', sizeBytes, 'bytes');
      return {
        valid: false,
        error: `Token too large: ${sizeBytes} bytes exceeds ${TOKEN_LIMITS.MAX_TOKEN_SIZE_BYTES} byte limit`,
        size: sizeBytes
      };
    }

    // Check if this is a cashuB token (CBOR-encoded, V4)
    // We can't decode cashuB tokens client-side without CBOR library
    // Just validate size and let the backend handle full validation
    const normalizedToken = token.trim().toLowerCase();
    const isCashuB = normalizedToken.startsWith('cashub') ||
                     (normalizedToken.startsWith('cashu:') && normalizedToken.slice(6).startsWith('cashub'));
    if (isCashuB) {
      console.log('[TokenSecurity] cashuB token detected, skipping decode validation (size:', sizeBytes, 'bytes)');
      return { valid: true, size: sizeBytes, proofCount: -1 }; // -1 indicates unknown
    }

    // Try to decode and check proof count (cashuA tokens only)
    try {
      // Pass validateSize=false since we already validated above
      const decoded = this.decodeToken(token, false);
      if (!decoded) {
        return { valid: false, error: 'Failed to decode token', size: sizeBytes };
      }

      // Count total proofs
      let proofCount = 0;
      if (decoded.token) {
        for (const entry of decoded.token) {
          if (entry.proofs) {
            proofCount += entry.proofs.length;
          }
        }
      }

      if (proofCount > TOKEN_LIMITS.MAX_PROOF_COUNT) {
        console.warn('[TokenSecurity] Token exceeds proof count limit:', proofCount);
        return {
          valid: false,
          error: `Too many proofs: ${proofCount} exceeds ${TOKEN_LIMITS.MAX_PROOF_COUNT} limit`,
          size: sizeBytes,
          proofCount
        };
      }

      return { valid: true, size: sizeBytes, proofCount };
    } catch (error) {
      return { valid: false, error: `Validation failed: ${error.message}`, size: sizeBytes };
    }
  },

  /**
   * Validate chunk count for NIP-60 events (OWASP A10: DoS Prevention)
   *
   * @param {number} chunkCount - Number of chunks
   * @returns {boolean} True if within limits
   */
  validateChunkCount(chunkCount) {
    if (typeof chunkCount !== 'number' || chunkCount < 0) {
      return false;
    }
    if (chunkCount > TOKEN_LIMITS.MAX_CHUNK_COUNT) {
      console.warn('[TokenSecurity] Chunk count exceeds limit:', chunkCount);
      return false;
    }
    return true;
  },

  /**
   * Compute SHA-256 fingerprint for a Cashu token.
   * Uses sorted proof secrets + mint URL for collision-resistant identification.
   *
   * @param {string} token - The Cashu token (cashuA or cashuB format)
   * @returns {Promise<string>} 64-character hex fingerprint
   */
  async getFingerprint(token) {
    if (!TokenSecurityIntegration._initialized) {
      // Auto-initialize if possible
      if (!TokenSecurityIntegration.init()) {
        // Fallback to simple hash if not available
        console.warn('[TokenSecurity] Not initialized, using fallback fingerprint');
        return this._fallbackFingerprint(token);
      }
    }

    try {
      return await TokenSecurityIntegration._fingerprinter.computeFingerprint(token);
    } catch (error) {
      console.error('[TokenSecurity] Fingerprint computation failed:', error);
      return this._fallbackFingerprint(token);
    }
  },

  /**
   * Fallback fingerprint using simple hash.
   * Used when the security module is not loaded.
   *
   * @param {string} token - The token string
   * @returns {string} Simple fingerprint
   * @private
   */
  _fallbackFingerprint(token) {
    if (!token) return '';
    // Use prefix + length as basic fingerprint
    return `fallback_${token.substring(0, 50)}_${token.length}`;
  },

  /**
   * Try to acquire a lock for redemption.
   *
   * @param {string} fingerprint - Token fingerprint
   * @param {string} source - Lock source identifier (e.g., 'dm-poll', 'receive-screen')
   * @returns {boolean} True if lock acquired, false if already locked
   */
  acquireLock(fingerprint, source) {
    if (!TokenSecurityIntegration._initialized) {
      TokenSecurityIntegration.init();
    }

    if (!TokenSecurityIntegration._lock) {
      console.warn('[TokenSecurity] Lock not available');
      return true; // Allow operation if lock unavailable
    }

    return TokenSecurityIntegration._lock.acquire(fingerprint, source);
  },

  /**
   * Release a lock after redemption.
   *
   * @param {string} fingerprint - Token fingerprint
   */
  releaseLock(fingerprint) {
    if (TokenSecurityIntegration._lock) {
      TokenSecurityIntegration._lock.release(fingerprint);
    }
  },

  /**
   * Check if a token is currently locked.
   *
   * @param {string} fingerprint - Token fingerprint
   * @returns {boolean} True if locked
   */
  isLocked(fingerprint) {
    if (!TokenSecurityIntegration._lock) {
      return false;
    }
    return TokenSecurityIntegration._lock.isLocked(fingerprint);
  },

  /**
   * Get lock info for debugging.
   *
   * @param {string} fingerprint - Token fingerprint
   * @returns {Object|null} Lock info or null
   */
  getLockInfo(fingerprint) {
    if (!TokenSecurityIntegration._lock) {
      return null;
    }
    return TokenSecurityIntegration._lock.getLockInfo(fingerprint);
  },

  /**
   * Get the number of active locks.
   *
   * @returns {number} Number of locks
   */
  getLockCount() {
    if (!TokenSecurityIntegration._lock) {
      return 0;
    }
    return TokenSecurityIntegration._lock.getLockCount();
  },

  /**
   * Cleanup stale locks.
   *
   * @returns {number} Number of locks removed
   */
  cleanupStaleLocks() {
    if (!TokenSecurityIntegration._lock) {
      return 0;
    }
    return TokenSecurityIntegration._lock.cleanupStale();
  },

  /**
   * Decode a Cashu token with size validation.
   *
   * @param {string} token - The token string
   * @param {boolean} [validateSize=true] - Whether to validate size limits
   * @returns {Object|null} Decoded token or null if invalid/too large
   */
  decodeToken(token, validateSize = true) {
    // Check size limit first (OWASP A10)
    if (validateSize && token && typeof token === 'string') {
      const sizeBytes = new Blob([token]).size;
      if (sizeBytes > TOKEN_LIMITS.MAX_TOKEN_SIZE_BYTES) {
        console.warn('[TokenSecurity] Rejecting oversized token:', sizeBytes, 'bytes');
        return null;
      }
    }

    if (typeof ImaniTokenSecurity !== 'undefined') {
      return ImaniTokenSecurity.decodeToken(token);
    }
    return null;
  },

  /**
   * Get token version (A or B).
   *
   * @param {string} token - The token string
   * @returns {'A'|'B'|null} Token version
   */
  getTokenVersion(token) {
    if (typeof ImaniTokenSecurity !== 'undefined') {
      return ImaniTokenSecurity.getTokenVersion(token);
    }
    return null;
  },

  /**
   * Get total token amount.
   *
   * @param {string} token - The token string
   * @returns {number} Total amount or 0
   */
  getTokenAmount(token) {
    if (!TokenSecurityIntegration._initialized) {
      TokenSecurityIntegration.init();
    }
    if (TokenSecurityIntegration._fingerprinter) {
      return TokenSecurityIntegration._fingerprinter.getTokenAmount(token);
    }
    return 0;
  },

  /**
   * Get mint URL from token.
   *
   * @param {string} token - The token string
   * @returns {string|null} Mint URL or null
   */
  getMintUrl(token) {
    if (!TokenSecurityIntegration._initialized) {
      TokenSecurityIntegration.init();
    }
    if (TokenSecurityIntegration._fingerprinter) {
      return TokenSecurityIntegration._fingerprinter.getMintUrl(token);
    }
    return null;
  },
};

// Expose globally
if (typeof window !== 'undefined') {
  window.TokenSecurityIntegration = TokenSecurityIntegration;
  window.TokenSecurity = TokenSecurity;
  window.TOKEN_LIMITS = TOKEN_LIMITS;
}

console.log('[tokenSecurityIntegration] Token limits:', TOKEN_LIMITS);

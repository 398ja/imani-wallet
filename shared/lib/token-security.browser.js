"use strict";
var ImaniTokenSecurity = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/index.ts
  var src_exports = {};
  __export(src_exports, {
    BrowserCryptoAdapter: () => BrowserCryptoAdapter,
    DuplicateTokenError: () => DuplicateTokenError,
    LockAcquisitionError: () => LockAcquisitionError,
    RedemptionLock: () => RedemptionLock,
    TokenDecodeError: () => TokenDecodeError,
    TokenFingerprinter: () => TokenFingerprinter,
    TokenSecurityError: () => TokenSecurityError,
    base64UrlDecode: () => base64UrlDecode,
    decodeToken: () => decodeToken,
    getGlobalRedemptionLock: () => getGlobalRedemptionLock,
    getTokenVersion: () => getTokenVersion,
    resetGlobalRedemptionLock: () => resetGlobalRedemptionLock
  });

  // src/core/TokenDecoder.ts
  function base64UrlDecode(base64url) {
    let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
    const padding = base64.length % 4;
    if (padding) {
      base64 += "=".repeat(4 - padding);
    }
    if (typeof Buffer !== "undefined") {
      return Buffer.from(base64, "base64").toString("utf-8");
    }
    return atob(base64);
  }
  function decodeToken(token) {
    try {
      let payload = token.trim();
      if (payload.startsWith("cashu:")) {
        payload = payload.slice(6);
      }
      if (payload.startsWith("cashuA")) {
        payload = payload.slice(6);
      } else if (payload.startsWith("cashuB")) {
        payload = payload.slice(6);
      }
      const json = base64UrlDecode(payload);
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
  function getTokenVersion(token) {
    const trimmed = token.trim();
    const payload = trimmed.startsWith("cashu:") ? trimmed.slice(6) : trimmed;
    if (payload.startsWith("cashuA")) return "A";
    if (payload.startsWith("cashuB")) return "B";
    return null;
  }

  // src/core/TokenFingerprinter.ts
  var TokenFingerprinter = class {
    crypto;
    constructor(config) {
      this.crypto = config.crypto;
    }
    /**
     * Computes strong fingerprint for Cashu token.
     *
     * @param token - cashuA or cashuB encoded token
     * @returns 64-character hex fingerprint
     */
    async computeFingerprint(token) {
      const trimmed = token.trim();
      try {
        const decoded = decodeToken(trimmed);
        if (decoded?.token?.length) {
          const secrets = decoded.token.flatMap((t) => t.proofs || []).map((p) => p.secret).filter(Boolean).sort();
          if (secrets.length > 0) {
            const mintUrl = decoded.token[0]?.mint || "";
            const input = secrets.join("|") + "||" + mintUrl;
            return await this.crypto.sha256(input);
          }
        }
      } catch (e) {
        console.warn("[TokenFingerprinter] Proof-based fingerprint failed, using fallback:", e);
      }
      return await this.crypto.sha256(trimmed);
    }
    /**
     * Extracts proof secrets from token for debugging.
     *
     * @param token - Token to analyze
     * @returns Array of proof secrets
     */
    getProofSecrets(token) {
      const decoded = decodeToken(token.trim());
      if (!decoded?.token) return [];
      return decoded.token.flatMap((t) => t.proofs || []).map((p) => p.secret).filter(Boolean);
    }
    /**
     * Computes total amount from token proofs.
     *
     * @param token - Token to analyze
     * @returns Total amount or 0 if invalid
     */
    getTokenAmount(token) {
      const decoded = decodeToken(token.trim());
      if (!decoded?.token) return 0;
      return decoded.token.flatMap((t) => t.proofs || []).reduce((sum, p) => sum + (p.amount || 0), 0);
    }
    /**
     * Gets the mint URL from a token.
     *
     * @param token - Token to analyze
     * @returns Mint URL or null if invalid
     */
    getMintUrl(token) {
      const decoded = decodeToken(token.trim());
      return decoded?.token?.[0]?.mint || null;
    }
  };

  // src/core/RedemptionLock.ts
  var RedemptionLock = class {
    locks = /* @__PURE__ */ new Map();
    timeoutMs;
    constructor(config = {}) {
      this.timeoutMs = config.timeoutMs ?? 6e4;
    }
    /**
     * Attempts to acquire lock for a token fingerprint.
     *
     * @param fingerprint - Token fingerprint (from TokenFingerprinter)
     * @param source - Caller identifier (e.g., 'dm-auto', 'manual-paste', 'scan')
     * @returns True if lock acquired, false if already locked
     */
    acquire(fingerprint, source) {
      const existing = this.locks.get(fingerprint);
      if (existing) {
        const elapsed = Date.now() - existing.timestamp;
        if (elapsed < this.timeoutMs) {
          console.log(`[RedemptionLock] Lock held by ${existing.source}, rejecting ${source}`);
          return false;
        }
        console.warn(`[RedemptionLock] Releasing stale lock from ${existing.source} (${elapsed}ms old)`);
      }
      this.locks.set(fingerprint, { timestamp: Date.now(), source });
      console.log(`[RedemptionLock] Lock acquired by ${source} for ${fingerprint.slice(0, 8)}...`);
      return true;
    }
    /**
     * Releases lock for a token fingerprint.
     *
     * @param fingerprint - Token fingerprint to release
     */
    release(fingerprint) {
      const entry = this.locks.get(fingerprint);
      if (entry) {
        console.log(`[RedemptionLock] Lock released by ${entry.source} for ${fingerprint.slice(0, 8)}...`);
        this.locks.delete(fingerprint);
      }
    }
    /**
     * Checks if fingerprint is currently locked.
     *
     * @param fingerprint - Token fingerprint to check
     * @returns True if locked and not stale
     */
    isLocked(fingerprint) {
      const entry = this.locks.get(fingerprint);
      if (!entry) return false;
      const elapsed = Date.now() - entry.timestamp;
      return elapsed < this.timeoutMs;
    }
    /**
     * Gets information about a lock.
     *
     * @param fingerprint - Token fingerprint
     * @returns Lock entry or undefined
     */
    getLockInfo(fingerprint) {
      return this.locks.get(fingerprint);
    }
    /**
     * Gets current lock count (for debugging/monitoring).
     */
    getLockCount() {
      return this.locks.size;
    }
    /**
     * Clears all locks (for testing or recovery).
     */
    clearAll() {
      console.warn("[RedemptionLock] Clearing all locks");
      this.locks.clear();
    }
    /**
     * Cleans up stale locks.
     * Call periodically to prevent memory leaks.
     *
     * @returns Number of stale locks removed
     */
    cleanupStale() {
      const now = Date.now();
      let removed = 0;
      for (const [fingerprint, entry] of this.locks) {
        if (now - entry.timestamp >= this.timeoutMs) {
          this.locks.delete(fingerprint);
          removed++;
        }
      }
      if (removed > 0) {
        console.log(`[RedemptionLock] Cleaned up ${removed} stale locks`);
      }
      return removed;
    }
  };
  var globalLock = null;
  function getGlobalRedemptionLock() {
    if (!globalLock) {
      globalLock = new RedemptionLock();
    }
    return globalLock;
  }
  function resetGlobalRedemptionLock() {
    if (globalLock) {
      globalLock.clearAll();
    }
    globalLock = null;
  }

  // src/defaults/BrowserCryptoAdapter.ts
  var BrowserCryptoAdapter = class {
    /**
     * Computes SHA-256 hash using Web Crypto API.
     * @param input - String to hash
     * @returns 64-character hex string
     */
    async sha256(input) {
      const encoder = new TextEncoder();
      const data = encoder.encode(input);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      return this.bufferToHex(hashBuffer);
    }
    /**
     * Generates random bytes using Web Crypto API.
     * @param length - Number of bytes
     * @returns Cryptographically secure random bytes
     */
    randomBytes(length) {
      return crypto.getRandomValues(new Uint8Array(length));
    }
    /**
     * Converts ArrayBuffer to hex string.
     */
    bufferToHex(buffer) {
      return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  };

  // src/errors.ts
  var TokenSecurityError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "TokenSecurityError";
    }
  };
  var LockAcquisitionError = class extends TokenSecurityError {
    /** The fingerprint that couldn't be locked */
    fingerprint;
    /** The source that currently holds the lock */
    heldBy;
    constructor(fingerprint, heldBy) {
      const msg = heldBy ? `Lock for ${fingerprint.slice(0, 8)}... is held by ${heldBy}` : `Lock for ${fingerprint.slice(0, 8)}... could not be acquired`;
      super(msg);
      this.name = "LockAcquisitionError";
      this.fingerprint = fingerprint;
      this.heldBy = heldBy;
    }
  };
  var DuplicateTokenError = class extends TokenSecurityError {
    /** The fingerprint of the duplicate token */
    fingerprint;
    /** Where the duplicate was detected */
    detectedAt;
    constructor(fingerprint, detectedAt) {
      const location = detectedAt === "local" ? "locally" : "on server";
      super(`Token ${fingerprint.slice(0, 8)}... already received ${location}`);
      this.name = "DuplicateTokenError";
      this.fingerprint = fingerprint;
      this.detectedAt = detectedAt;
    }
  };
  var TokenDecodeError = class extends TokenSecurityError {
    /** The (possibly truncated) token that failed to decode */
    tokenPreview;
    constructor(token) {
      const preview = token.length > 20 ? token.slice(0, 20) + "..." : token;
      super(`Failed to decode token: ${preview}`);
      this.name = "TokenDecodeError";
      this.tokenPreview = preview;
    }
  };
  return __toCommonJS(src_exports);
})();
//# sourceMappingURL=token-security.browser.global.js.map
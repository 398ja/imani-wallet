/**
 * Gateway API Client
 * Handles all communication with the Imani Gateway REST API
 *
 * Can use ImaniSDK (if loaded) or direct fetch calls as fallback.
 */

const PROFILE_BACKEND_MIRROR_KEY = 'imani_profile_backend_mirror_pending';
const PROFILE_BACKEND_MIRROR_RETRY_COOLDOWN_MS = 30 * 1000;

class GatewayAPI {
  constructor(baseUrl = '') {
    // Use relative URL by default to leverage nginx proxy, avoiding CORS issues
    // Fall back to absolute URL only if explicitly provided
    this.baseUrl = baseUrl || '';
    // NIP-98 auth URL must match the Host header the gateway receives.
    // When an absolute baseUrl is provided, derive authBaseUrl from its origin so
    // NIP-98 signatures match the actual request destination. Otherwise use the
    // browser origin (for proxied requests) or fall back to the production URL.
    if (this.baseUrl && /^https?:\/\//i.test(this.baseUrl)) {
      try {
        this.authBaseUrl = new URL(this.baseUrl).origin;
      } catch (e) {
        this.authBaseUrl = (typeof window !== 'undefined' && window.location) ? window.location.origin : '';
      }
    } else {
      this.authBaseUrl = (typeof window !== 'undefined' && window.location) ? window.location.origin : '';
    }
    this.apiKey = null;
    this.apiSecret = null;
    this._sdkClient = null;
    // Relay URL and Lightning domain come from GatewayConfig (/api/v1/config,
    // which the backend serves from env vars). Never hardcode a domain.
    // These are snapshotted now for first-use and refreshed on getConfig().
    // If /api/v1/config has not yet resolved, they are empty until it does.
    this.infraRelay = GatewayConfig.relayUrl;
    this.lightningDomain = GatewayConfig.lightningDomain;
    // When GatewayConfig finishes loading, refresh cached values so code
    // that captured them early picks up the real env-backed domain.
    if (typeof GatewayConfig.whenReady === 'function') {
      GatewayConfig.whenReady((c) => {
        if (c?.relay_url) this.infraRelay = c.relay_url;
        if (c?.lightning_domain) this.lightningDomain = c.lightning_domain;
      });
    }
    // NIP-98 authentication credentials
    this._nostrPublicKey = null;
    this._nostrPrivateKey = null;
    // Cached public config
    this._config = null;
  }

  setApiKey(key) {
    this.apiKey = key;
    this._sdkClient = null; // Reset SDK client when key changes
  }

  setApiSecret(secret) {
    this.apiSecret = secret;
    this._sdkClient = null;
  }

  getApiKey() {
    return this.apiKey;
  }

  /**
   * Set Nostr credentials for NIP-98 authentication
   * @param {string} publicKeyHex - Public key in hex format
   * @param {string} privateKeyHex - Private key in hex format
   */
  setNostrCredentials(publicKeyHex, privateKeyHex = null) {
    this._nostrPublicKey = publicKeyHex;
    this._nostrPrivateKey = privateKeyHex;
    // Sync with NostrApiClient if available
    if (typeof nostrApi !== 'undefined') {
      nostrApi.setCredentials(publicKeyHex, privateKeyHex);
    }
  }

  /**
   * Clear Nostr credentials
   */
  clearNostrCredentials() {
    this._nostrPublicKey = null;
    this._nostrPrivateKey = null;
    // Sync with NostrApiClient if available
    if (typeof nostrApi !== 'undefined') {
      nostrApi.clearCredentials();
    }
  }

  /**
   * Check if we have signing capability (private key)
   */
  hasSigningCapability() {
    // Has private key locally
    return !!this._nostrPrivateKey;
  }

  /**
   * Build a NIP-98 Authorization header for an arbitrary gateway path, signed
   * with the stored credentials against `authBaseUrl` — the SAME url the
   * request() pipeline signs against, so the gateway's signature check passes.
   * Lets non-api.js callers (e.g. the push-subscription package) authenticate
   * against NIP-98-protected endpoints. Returns null when unavailable.
   * @param {string} method - HTTP method
   * @param {string} path - request path incl. any query string (e.g. /api/v1/push/subscriptions/<pk>)
   * @param {string|null} body - request body string (for the payload hash), or null
   * @returns {Promise<string|null>}
   */
  async buildNip98AuthHeader(method, path, body = null) {
    if (!this._nostrPublicKey || typeof NostrUtils === 'undefined') return null;
    try {
      const authUrl = `${this.authBaseUrl}${path}`;
      return await NostrUtils.createNip98AuthHeader(
        authUrl,
        method,
        this._nostrPublicKey,
        this._nostrPrivateKey,
        body || null
      );
    } catch (e) {
      console.error('[api] buildNip98AuthHeader failed:', e);
      return null;
    }
  }

  _getSyncLedgerIntegration() {
    if (typeof window !== 'undefined' && window.SyncLedgerIntegration) {
      return window.SyncLedgerIntegration;
    }
    if (typeof globalThis !== 'undefined' && globalThis.SyncLedgerIntegration) {
      return globalThis.SyncLedgerIntegration;
    }
    return null;
  }

  _profileSyncType(scope) {
    return scope === 'merchant' ? 'merchant-profile' : 'profile';
  }

  _truncateLogIdentifier(value, length = 12) {
    if (typeof value !== 'string' || !value) return null;
    return value.length <= length ? value : `${value.slice(0, length)}...`;
  }

  _summarizeSignedEventForLog(signedEvent) {
    if (!signedEvent) return null;
    return {
      id: this._truncateLogIdentifier(signedEvent.id),
      kind: signedEvent.kind,
      contentLength: signedEvent.content?.length || 0,
      tagCount: Array.isArray(signedEvent.tags) ? signedEvent.tags.length : 0,
    };
  }

  async _ensureSyncLedgerProfileSync(pubkey) {
    const syncLedger = this._getSyncLedgerIntegration();
    if (!syncLedger?.initSyncLedger || !this._nostrPublicKey || !this._nostrPrivateKey) {
      return null;
    }
    await syncLedger.initSyncLedger(pubkey || this._nostrPublicKey, this._nostrPrivateKey);
    return syncLedger;
  }

  _buildPendingProfileMirrorFromSyncItem(scope, pubkey, item) {
    if (!item?.data) {
      return null;
    }
    const remoteSync = item.meta?.remoteSync || {};
    const pending = item.status === 'reconciling' || remoteSync.reconciliationPending === true;
    if (!pending) {
      return null;
    }
    return {
      scope,
      pubkey,
      profile: { ...item.data },
      eventId: item.eventId || remoteSync.eventId || null,
      updatedAt: remoteSync.updatedAt || new Date(item.updatedAt || Date.now()).toISOString(),
      lastAttemptAt: remoteSync.updatedAt || new Date(item.updatedAt || Date.now()).toISOString(),
      attempts: Number(item.meta?.postPublish?.retryCount || 0),
      lastError: remoteSync.lastError || null,
      backendMirrored: remoteSync.backendMirrored === true,
    };
  }

  _storageGet(key) {
    try {
      if (typeof scopedGet === 'function') {
        return scopedGet(key);
      }
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  _storageSet(key, value) {
    try {
      if (typeof scopedSet === 'function') {
        scopedSet(key, value);
        return;
      }
      localStorage.setItem(key, value);
    } catch (e) {
      console.warn('[api] Failed to persist profile mirror state:', e.message);
    }
  }

  _storageRemove(key) {
    try {
      if (typeof scopedRemove === 'function') {
        scopedRemove(key);
        return;
      }
      localStorage.removeItem(key);
    } catch (e) {
      console.warn('[api] Failed to clear profile mirror state:', e.message);
    }
  }

  _getProfileMirrorQueue() {
    try {
      const raw = this._storageGet(PROFILE_BACKEND_MIRROR_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.warn('[api] Failed to parse profile mirror queue:', e.message);
      return {};
    }
  }

  _saveProfileMirrorQueue(queue) {
    if (!queue || Object.keys(queue).length === 0) {
      this._storageRemove(PROFILE_BACKEND_MIRROR_KEY);
      return;
    }
    this._storageSet(PROFILE_BACKEND_MIRROR_KEY, JSON.stringify(queue));
  }

  _getProfileMirrorEntryKey(scope, pubkey) {
    return `${scope}:${String(pubkey || '').toLowerCase()}`;
  }

  async _getPendingProfileMirror(scope, pubkey) {
    const normalizedPubkey = String(pubkey || '').toLowerCase();
    const currentPubkey = String(this._nostrPublicKey || '').toLowerCase();
    if (normalizedPubkey && normalizedPubkey === currentPubkey) {
      const syncLedger = await this._ensureSyncLedgerProfileSync(pubkey).catch(() => null);
      if (syncLedger?.getProfileSyncItem) {
        try {
          const item = await syncLedger.getProfileSyncItem(this._profileSyncType(scope));
          return this._buildPendingProfileMirrorFromSyncItem(scope, pubkey, item);
        } catch (e) {
          console.warn('[api] Failed to read pending profile sync state from sync-ledger:', e.message);
        }
      }
    }

    const queue = this._getProfileMirrorQueue();
    return queue[this._getProfileMirrorEntryKey(scope, pubkey)] || null;
  }

  _setPendingProfileMirror(scope, pubkey, entry) {
    const queue = this._getProfileMirrorQueue();
    queue[this._getProfileMirrorEntryKey(scope, pubkey)] = entry;
    this._saveProfileMirrorQueue(queue);
  }

  _clearPendingProfileMirror(scope, pubkey) {
    const queue = this._getProfileMirrorQueue();
    delete queue[this._getProfileMirrorEntryKey(scope, pubkey)];
    this._saveProfileMirrorQueue(queue);
  }

  _buildBackendMirrorPayload(signedEvent) {
    return {
      id: signedEvent.id,
      pubkey: signedEvent.pubkey,
      createdAt: signedEvent.created_at ?? signedEvent.createdAt,
      kind: signedEvent.kind,
      tags: signedEvent.tags,
      content: signedEvent.content,
      sig: signedEvent.sig
    };
  }

  _buildProfileSyncStatus(scope, options = {}) {
    return {
      scope,
      relayAccepted: options.relayAccepted === true,
      backendMirrored: options.backendMirrored === true,
      reconciliationPending: options.reconciliationPending === true,
      eventId: options.eventId || null,
      lastError: options.lastError || null,
      updatedAt: options.updatedAt || new Date().toISOString()
    };
  }

  _decorateProfileWithSyncStatus(profile, syncStatus) {
    if (!profile) return profile;
    return {
      ...profile,
      _syncStatus: syncStatus
    };
  }

  _mergePendingProfileData(profile, pendingEntry) {
    if (!pendingEntry?.profile) {
      return profile;
    }
    if (!profile) {
      return { ...pendingEntry.profile };
    }
    return { ...profile, ...pendingEntry.profile };
  }

  async _mirrorSignedEventToBackend(signedEvent) {
    return this.request('POST', `/api/v1/nostr/events`, this._buildBackendMirrorPayload(signedEvent));
  }

  async _recordPendingProfileMirror(scope, pubkey, profile, signedEvent, errorMessage) {
    const existing = await this._getPendingProfileMirror(scope, pubkey);
    const now = new Date().toISOString();
    this._setPendingProfileMirror(scope, pubkey, {
      scope,
      pubkey,
      profile,
      event: this._buildBackendMirrorPayload(signedEvent),
      eventId: signedEvent.id,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      lastAttemptAt: now,
      attempts: (existing?.attempts || 0) + 1,
      lastError: errorMessage || null,
    });
  }

  async _reconcilePendingProfileMirror(scope, pubkey, options = {}) {
    const normalizedPubkey = String(pubkey || '').toLowerCase();
    const currentPubkey = String(this._nostrPublicKey || '').toLowerCase();
    if (normalizedPubkey && normalizedPubkey === currentPubkey) {
      const syncLedger = await this._ensureSyncLedgerProfileSync(pubkey).catch(() => null);
      if (syncLedger?.getProfileSyncItem && syncLedger?.pushToRemote) {
        try {
          const type = this._profileSyncType(scope);
          const item = await syncLedger.getProfileSyncItem(type);
          const pendingFromLedger = this._buildPendingProfileMirrorFromSyncItem(scope, pubkey, item);
          if (!pendingFromLedger) {
            return null;
          }

          const lastAttemptMs = pendingFromLedger.lastAttemptAt ? Date.parse(pendingFromLedger.lastAttemptAt) : 0;
          if (!options.force && lastAttemptMs && (Date.now() - lastAttemptMs) < PROFILE_BACKEND_MIRROR_RETRY_COOLDOWN_MS) {
            return pendingFromLedger;
          }

          await syncLedger.pushToRemote(type);
          const refreshedItem = await syncLedger.getProfileSyncItem(type);
          return this._buildPendingProfileMirrorFromSyncItem(scope, pubkey, refreshedItem);
        } catch (e) {
          console.warn('[api] Sync-ledger reconciliation attempt failed:', e.message);
        }
        return null;
      }
    }

    const pending = await this._getPendingProfileMirror(scope, pubkey);
    if (!pending?.event) {
      return null;
    }

    const lastAttemptMs = pending.lastAttemptAt ? Date.parse(pending.lastAttemptAt) : 0;
    if (!options.force && lastAttemptMs && (Date.now() - lastAttemptMs) < PROFILE_BACKEND_MIRROR_RETRY_COOLDOWN_MS) {
      return pending;
    }

    try {
      await this.request('POST', `/api/v1/nostr/events`, pending.event);
      console.log('[api] Reconciled backend mirror for', scope, pubkey.substring(0, 16) + '...');
      this._clearPendingProfileMirror(scope, pubkey);
      return null;
    } catch (error) {
      const nextEntry = {
        ...pending,
        updatedAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        attempts: (pending.attempts || 0) + 1,
        lastError: error.message,
      };
      this._setPendingProfileMirror(scope, pubkey, nextEntry);
      console.warn('[api] Backend mirror reconciliation still pending for', scope, ':', error.message);
      return nextEntry;
    }
  }

  /**
   * Get or create ImaniSDK client instance
   */
  _getSDKClient() {
    if (this._sdkClient) return this._sdkClient;

    if (typeof ImaniSDK !== 'undefined' && this.apiKey) {
      this._sdkClient = new ImaniSDK.ImaniClient({
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        apiSecret: this.apiSecret,
        debug: false,
      });
    }
    return this._sdkClient;
  }

  // ==================== Public Config & Registration ====================

  /**
   * Get public configuration (cached)
   */
  async getConfig() {
    if (this._config) return this._config;
    this._config = await this.request('GET', '/api/v1/config');
    // Update instance defaults from config
    if (this._config?.relay_url) this.infraRelay = this._config.relay_url;
    if (this._config?.lightning_domain) this.lightningDomain = this._config.lightning_domain;
    return this._config;
  }

  /**
   * Get NIP-05 default domain from config
   */
  async getNip05Domain() {
    const config = await this.getConfig();
    return config?.nip05_domain || null;
  }

  /**
   * Get gateway config with defaultDomain for NIP-05
   */
  async getGatewayConfig() {
    const config = await this.getConfig();
    return {
      defaultDomain: config?.nip05_domain || config?.defaultDomain || config?.default_domain || ''
    };
  }

  /**
   * Get the primary relay URL from config
   */
  async getRelayUrl() {
    const config = await this.getConfig();
    return config?.relay_url || this.infraRelay;
  }

  /**
   * Get the Lightning address domain from config
   */
  async getLightningDomain() {
    const config = await this.getConfig();
    return config?.lightning_domain || this.lightningDomain;
  }

  /**
   * Create a NIP-05 identity for a pubkey
   * @param {Object} params - { username, pubkey }
   */
  async createNip05(params) {
    return this.request('POST', '/api/v1/nip05', {
      username: params.username,
      pubkey: params.pubkey
    });
  }

  /**
   * Register a new account with username and bunker passphrase.
   * Creates a new identity in the bunker with the passphrase encrypting the key at rest.
   * Also registers NIP-05 identity with Bottin.
   *
   * @param {Object} params - Registration parameters
   * @param {string} params.username - Username for NIP-05 (e.g., 'alice' becomes alice@domain)
   * @param {string} params.passphrase - Passphrase to encrypt the key in the bunker (min 8 chars)
   * @param {string} [params.display_name] - Optional display name
   * @param {string} [params.lightning_address] - Optional Lightning address
   * @returns {Object} AccountResponse with npub, nip05, bunker connection info, etc.
   */
  async registerAccount(params) {
    const body = {
      username: params.username,
      passphrase: params.passphrase
    };
    if (params.display_name) {
      body.display_name = params.display_name;
    }
    if (params.lightning_address) {
      body.lightning_address = params.lightning_address;
    }
    return this.request('POST', '/api/v1/accounts/register', body);
  }

  /**
   * Create a new identity with name and passphrase
   * This is the simpler registration flow using the identities endpoint
   */
  async createIdentitySimple(name, passphrase) {
    return this.request('POST', '/api/v1/identities', {
      name,
      passphrase
    });
  }

  /**
   * Check if a username is available by resolving the NIP-05 identifier
   */
  async checkUsernameAvailability(username, domain) {
    if (!domain) {
      const config = await this.getConfig();
      domain = config?.nip05_domain || config?.default_domain || '';
      if (!domain) throw new Error('NIP-05 domain not configured (GET /api/v1/config)');
    }
    try {
      const nip05 = `${username}@${domain}`;
      await this.resolveNip05(nip05);
      // If we get here, NIP-05 exists - not available
      return { available: false, username };
    } catch (error) {
      // 404 means not found = available
      if (error.status === 404) {
        return { available: true, username };
      }
      throw error;
    }
  }

  /**
   * Resolve NIP-05 to pubkey
   */
  async resolveNip05(nip05) {
    return this.request('GET',
      `/api/v1/resolve/${encodeURIComponent(nip05)}`
    );
  }

  /**
   * Reverse lookup: Find NIP-05 by pubkey
   * Used to check if a user already has a registered NIP-05 in bottin
   * @param {string} pubkey - Public key in hex format (64 characters)
   * @returns {Object|null} - { nip05, npub, hexPubkey, relays, source } or null if not found
   */
  async getNip05ByPubkey(pubkey) {
    try {
      return await this.request('GET', `/api/v1/resolve/pubkey/${pubkey}`);
    } catch (error) {
      // 404 means no NIP-05 registered for this pubkey
      if (error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get identity by NIP-05 (local part is used in path)
   */
  async getIdentityByNip05(nip05) {
    const parts = nip05.split('@');
    if (parts.length !== 2) {
      throw new Error('Invalid NIP-05 format');
    }
    return this.request('GET', `/api/v1/identities/${encodeURIComponent(parts[0])}`);
  }

  /**
   * Request token recovery
   */
  async requestTokenRecovery(nip05, verificationProof) {
    return this.request('POST', '/api/v1/accounts/recover', {
      nip05,
      verification_proof: verificationProof
    });
  }

  /**
   * Unlock a locked identity in the bunker.
   * Required when the identity's nsec is encrypted with a passphrase.
   *
   * @param {string} name - The identity name in the bunker
   * @param {string} passphrase - The bunker passphrase to unlock the key
   * @returns {Object} IdentityResponse
   */
  async unlockIdentity(name, passphrase) {
    return this.request('POST', `/api/v1/identities/${encodeURIComponent(name)}/unlock`, {
      passphrase
    });
  }

  /**
   * Import an existing identity (nsec) into the bunker for backup and co-signing.
   * This enables the hybrid security model where the nsec is stored both locally
   * and in the bunker.
   *
   * @param {string} name - Unique name for the identity in the bunker
   * @param {string} nsec - The private key in nsec (bech32) format
   * @param {string} passphrase - Passphrase to protect the key in the bunker
   * @param {string} description - Optional description
   * @returns {Promise<Object>} Identity response with npub, pubkey_hex, etc.
   */
  async importIdentity(name, nsec, passphrase, description = null) {
    const body = {
      name,
      nsec
    };
    // Only include passphrase if it's actually provided (not null/undefined/empty)
    // This ensures the key is stored unencrypted and auto-started by nsecbunkerd
    if (passphrase) {
      body.passphrase = passphrase;
    }
    if (description) {
      body.description = description;
    }
    return this.request('POST', '/api/v1/identities/import', body);
  }

  /**
   * Create an access token for a bunker identity.
   * This token allows the client to request signatures from the bunker.
   *
   * @param {string} identityName - Name of the identity in the bunker
   * @param {string} clientName - Name for this client/device
   * @param {object} options - Optional settings
   * @param {string} options.policyId - Policy to attach to the token
   * @param {number} options.expiresInSeconds - Token expiration time in seconds
   * @returns {Promise<Object>} Token response with connection_string, relay, etc.
   */
  async createAccessToken(identityName, clientName, options = {}) {
    const body = {
      identity_name: identityName,
      client_name: clientName
    };
    if (options.policyId) {
      body.policy_id = options.policyId;
    }
    if (options.expiresInSeconds) {
      body.expires_in_seconds = options.expiresInSeconds;
    }
    return this.request('POST', `/api/v1/identities/${encodeURIComponent(identityName)}/tokens`, body);
  }

  /**
   * Check if a path requires NIP-98 authentication
   * @param {string} path - API path
   * @param {string} method - HTTP method
   * @returns {boolean}
   */
  _requiresNip98Auth(path, method) {
    // Profile endpoints use NIP-98 for write operations
    if (path.startsWith('/api/v1/profiles/')) {
      // Write methods require NIP-98 auth
      return ['PUT', 'POST', 'PATCH', 'DELETE'].includes(method.toUpperCase());
    }
    // Nostr event storage requires NIP-98 auth
    if (path.startsWith('/api/v1/nostr/events')) {
      return ['POST'].includes(method.toUpperCase());
    }
    // DM endpoints always require NIP-98 auth (not API key)
    if (path.startsWith('/api/v1/dm/')) {
      return true;
    }
    // Atomic send/purchase require NIP-98 for ALL methods (ownership verification).
    // /api/v1/atomic/* covers atomic-purchase aliases and the voucher-inspect endpoint.
    if (path.startsWith('/api/v1/atomic-send')
            || path.startsWith('/api/v1/atomic-purchase')
            || path.startsWith('/api/v1/atomic/')) {
      return true;
    }
    // Portal endpoints require NIP-98 for all operations except SSE stream (uses stream token)
    if (path.startsWith('/api/v1/portal/')) {
      // SSE stream endpoint uses stream token auth, not NIP-98
      if (path.startsWith('/api/v1/portal/events') && !path.includes('/session')) {
        return false;
      }
      return true;
    }
    // Cash payment endpoints require NIP-98 for write operations
    // and for SSE event streams (GET .../events).
    if (path.startsWith('/api/v1/cash/')) {
      const methodUpper = method.toUpperCase();
      // Write methods require NIP-98
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(methodUpper)) {
        return true;
      }
      // Cash SSE endpoints use GET but still require NIP-98
      if (methodUpper === 'GET' && path.includes('/events')) {
        return true;
      }
      return false;
    }
    // Spec 014: payment-receipts always require NIP-98 (recipient enqueue +
    // sender drain/ack). Backend's GatewaySecurityConfiguration registers
    // the prefix as nip98-protected.
    if (path.startsWith('/api/v1/payment-receipts')) {
      return true;
    }
    // Spec 018 T044: incoming-notifications drain pulls envelopes for the
    // authenticated recipient. Same NIP-98 contract as spec 014.
    if (path.startsWith('/api/v1/incoming-notifications')) {
      return true;
    }
    return false;
  }

  /**
   * Check if a path should use NIP-98 when no API key is available
   * @param {string} path - API path
   * @param {string} method - HTTP method
   * @returns {boolean}
   */
  _canUseNip98Fallback(path, method) {
    const methodUpper = method.toUpperCase();

    // Public GET endpoints do not need NIP-98 fallback and can trigger replay
    // rejections when multiple same-second requests generate identical events.
    if (methodUpper === 'GET' && (
      path.startsWith('/api/v1/nip05') ||
      path.startsWith('/api/v1/resolve/') ||
      path.startsWith('/api/v1/profiles/')
    )) {
      return false;
    }

    // Wallet, DM, identity, atomic, and cash endpoints can use NIP-98 as fallback.
    // HIGH-13: NIP-05 registration (POST /api/v1/nip05) also uses NIP-98 as a
    // best-effort proof of the pubkey being registered — so the backend can
    // gate NIP-05 creation on it and prevent username squatting. (GET
    // /api/v1/nip05 is excluded above.)
    return path.startsWith('/api/v1/wallet/') ||
           path.startsWith('/api/v1/dm/') ||
           path.startsWith('/api/v1/identities/') ||
           path.startsWith('/api/v1/nip05') ||
           path.startsWith('/api/v1/atomic-send') ||
           path.startsWith('/api/v1/atomic-purchase') ||
           path.startsWith('/api/v1/cash/');
  }

  async request(method, path, body = null) {
    const headers = { 'Content-Type': 'application/json' };
    const fullUrl = `${this.baseUrl}${path}`;
    // NIP-98 auth URL must use the actual backend URL for signature verification
    const authUrl = `${this.authBaseUrl}${path}`;
    const bodyJson = body ? JSON.stringify(body) : null;

    // Use NIP-98 auth for profile endpoints, API key for others
    if (this._requiresNip98Auth(path, method)) {
      if (this._nostrPublicKey && typeof NostrUtils !== 'undefined') {
        try {
          const authHeader = await NostrUtils.createNip98AuthHeader(
            authUrl,
            method,
            this._nostrPublicKey,
            this._nostrPrivateKey,
            bodyJson
          );
          headers['Authorization'] = authHeader;
        } catch (error) {
          console.error('Failed to create NIP-98 auth header:', error);
          const err = new Error('NIP-98 auth required and signing failed: ' + error.message);
          err.code = 'NO_AUTH';
          throw err;
        }
      } else {
        const err = new Error('NIP-98 authentication required but Nostr credentials not set');
        err.code = 'NO_AUTH';
        throw err;
      }
    } else if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    } else if (this._canUseNip98Fallback(path, method) && this._nostrPublicKey && typeof NostrUtils !== 'undefined') {
      // Use NIP-98 as fallback for wallet endpoints when no API key is available
      try {
        const authHeader = await NostrUtils.createNip98AuthHeader(
          authUrl,
          method,
          this._nostrPublicKey,
          this._nostrPrivateKey,
          bodyJson
        );
        headers['Authorization'] = authHeader;
      } catch (error) {
        console.warn('NIP-98 fallback auth failed:', error);
        // Continue without auth - server will decide if it's allowed
      }
    }

    const options = {
      method,
      headers,
    };

    if (bodyJson && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = bodyJson;
    }

    const response = await fetch(fullUrl, options);

    if (response.status === 204) {
      return null;
    }

    let data;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    if (!response.ok) {
      // Handle nested error object format: { error: { code, message } }
      const errorData = data.error || data;
      const errorMessage = errorData.message || errorData.error || 'API request failed';
      const error = new Error(errorMessage);
      error.status = response.status;
      error.code = errorData.code || data.code || 'UNKNOWN_ERROR';
      error.data = data;
      throw error;
    }

    return data;
  }

  // ==================== Identity Endpoints ====================

  /**
   * Create a new identity (registration)
   * This is a public endpoint that doesn't require an API key
   * @param {Object} params - { npub, signed_event, display_name? }
   * @returns {Object} - { api_key, identity_id, npub }
   */
  async createIdentity(params) {
    return this.request('POST', '/api/v1/identities', {
      npub: params.npub,
      signed_event: params.signed_event,
      display_name: params.display_name,
    });
  }

  /**
   * Get current identity info
   */
  async getIdentity() {
    return this.request('GET', '/api/v1/identities/me');
  }

  /**
   * Update identity display name
   */
  async updateIdentity(params) {
    return this.request('PATCH', '/api/v1/identities/me', params);
  }

  /**
   * Resolve a username (or full NIP-05) to identity info via the bottin-backed
   * resolve endpoint. The previous bunker-backed `/api/v1/identities/{name}`
   * path was deployment-gated on `gateway.bunker.mock=false` and is
   * permanently 404 on staging; bottin is the canonical "name → pubkey + relays"
   * source on every environment.
   *
   * @param {string} name - Either a bare username or a full NIP-05 (`name@domain`).
   * @returns {Promise<Object|null>} - { name, npub, pubkey_hex, nip05, relays } or null if not found.
   */
  async getIdentityByName(name) {
    if (!name) return null;
    let username = name;
    let domain = null;
    if (name.includes('@')) {
      const parts = name.split('@');
      username = parts[0];
      domain = parts[1] || null;
    }
    if (!domain) {
      domain = await this.getNip05Domain();
      if (!domain) {
        throw new Error('NIP-05 domain not configured (GET /api/v1/config)');
      }
    }
    const nip05 = `${username}@${domain}`;
    try {
      const resolution = await this.resolveNip05(nip05);
      if (!resolution) return null;
      return {
        name: username,
        npub: resolution.npub,
        pubkey_hex: resolution.hex_pubkey || resolution.hexPubkey,
        nip05: resolution.nip05 || nip05,
        relays: resolution.relays || [],
      };
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  // ==================== Mint Quote Endpoints ====================

  async createMintQuote(amount, unit = 'sat') {
    return this.request('POST', '/api/v1/wallet/mint/quote', { amount, unit });
  }

  async getMintQuote(quoteId) {
    return this.request('GET', `/api/v1/wallet/mint/quote/${quoteId}`);
  }

  /**
   * Subscribe to real-time payment status updates via SSE.
   * @param {string} quoteId - The quote ID to monitor
   * @param {Object} callbacks - { onPaid, onError, onConnected }
   * @returns {EventSource} - The EventSource instance
   */
  subscribeToQuoteStatus(quoteId, callbacks = {}) {
    let url = `${this.baseUrl}/api/v1/wallet/mint/quote/${quoteId}/subscribe`;
    
    // Pass API key in query since EventSource doesn't support headers
    if (this.apiKey) {
      const separator = url.includes('?') ? '&' : '?';
      url += `${separator}api_key=${encodeURIComponent(this.apiKey)}`;
    }

    const eventSource = new EventSource(url);

    eventSource.onopen = () => {
      console.log(`[api] SSE connected for quote ${quoteId}`);
      if (callbacks.onConnected) callbacks.onConnected();
    };

    eventSource.addEventListener('payment_confirmed', (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log(`[api] Payment confirmed for quote ${quoteId}`, data);
        if (callbacks.onPaid) callbacks.onPaid(data);
        eventSource.close();
      } catch (e) {
        console.error('[api] Failed to parse SSE event data', e);
      }
    });

    eventSource.onerror = (error) => {
      console.warn(`[api] SSE error for quote ${quoteId}:`, error);
      if (callbacks.onError) callbacks.onError(error);
      // Don't auto-close on error, let the browser retry or caller decide
    };

    return eventSource;
  }

  async mintTokens(quoteId) {
    return this.request('POST', `/api/v1/wallet/mint/${quoteId}`);
  }

  // ==================== Card Payment (Stripe) ====================

  /**
   * Create a Stripe checkout session for card payment
   * @param {Object} params - { amount, amount_eur, currency, success_url, cancel_url }
   * @returns {Object} - { quote_id, checkout_url, amount_fiat, currency, expiry }
   */
  async createCardCheckout(params) {
    return this.request('POST', '/api/v1/wallet/mint/quote', {
      amount: params.amount,
      amount_fiat: params.amount_eur,
      currency: params.currency || 'eur',
      method: 'card',
      success_url: params.success_url,
      cancel_url: params.cancel_url
    });
  }

  // ==================== Voucher Endpoints ====================

  /**
   * Create a new voucher (gift card) with MINIMAL backing strategy support
   * @param {Object} params - Voucher creation parameters
   * @param {number} params.faceValue - Face value in minor units (e.g., cents for EUR)
   * @param {string} [params.faceUnit='EUR'] - Face value currency (EUR, USD, GBP, etc.)
   * @param {number} [params.faceDecimals=2] - Decimal places for the face currency
   * @param {string} [params.backingStrategy='FULL'] - Backing strategy (MINIMAL, FULL)
   * @param {string} [params.mintUrl] - Mint URL (optional, uses server default)
   * @param {string} [params.issuerId] - Issuer identifier (optional, uses current identity)
   * @param {string} [params.description=''] - Optional description
   * @param {Object} [params.merchantMetadata] - Optional merchant metadata
   * @param {number} [params.expiresInDays=null] - Days until expiration (null = indefinite/no expiry)
   * @returns {Object} Response with backing metadata:
   *   - voucher_id: Unique voucher identifier
   *   - token: Cashu token for the voucher
   *   - face_value: Face value in minor units
   *   - face_unit: Currency code (EUR, USD, etc.)
   *   - face_decimals: Decimal places
   *   - token_amount: Sats backing the token
   *   - token_unit: Always 'sat'
   *   - issuance_ratio: face_value / token_amount
   *   - backing_strategy: 'MINIMAL' | 'FULL'
   *   - platform_fee: Fee in face currency minor units
   *   - cost: Total cost in face currency minor units
   *   - expires_at: Expiration timestamp
   */
  async createVoucher(params) {
    const {
      faceValue,
      faceUnit,
      faceDecimals,
      backingStrategy = 'FULL',
      mintUrl,
      issuerId,
      description = '',
      merchantMetadata = null,
      expiresInDays = null, // null = indefinite/no expiry
      // Legacy support
      unit,
      memo
    } = params;

    // Determine effective unit (prefer faceUnit, fallback to legacy unit)
    const effectiveUnit = faceUnit || unit || 'EUR';

    // Auto-detect decimals based on unit if not explicitly provided
    const effectiveDecimals = faceDecimals !== undefined
      ? faceDecimals
      : (effectiveUnit === 'sat' ? 0 : 2);

    const body = {
      face_value: faceValue,
      face_unit: effectiveUnit,
      face_decimals: effectiveDecimals,
      backing_strategy: backingStrategy,
      description: description || memo || ''
    };

    // Only include optional fields if provided
    if (expiresInDays !== null && expiresInDays !== undefined) {
      body.expires_in_days = expiresInDays;
    }
    if (mintUrl) body.mint_url = mintUrl;
    if (issuerId) body.issuer_id = issuerId;
    if (merchantMetadata) body.merchant_metadata = merchantMetadata;

    return this.request('POST', '/api/v1/wallet/vouchers', body);
  }

  async getVoucher(voucherId) {
    return this.request('GET', `/api/v1/wallet/vouchers/${voucherId}`);
  }

  async listVouchers(status = null) {
    const path = status ? `/api/v1/wallet/vouchers?status=${status}` : '/api/v1/wallet/vouchers';
    return this.request('GET', path);
  }

  /**
   * Redeem voucher by voucher ID (legacy method)
   * @param {string} voucherId - Voucher ID
   * @param {number} amount - Amount to redeem
   * @param {string} [redeemerId] - Redeemer identifier
   * @returns {Object} - Redemption result
   * @deprecated Use redeemByToken for MINIMAL backing strategy
   */
  async redeemVoucher(voucherId, amount, redeemerId = null) {
    const body = { amount };
    if (redeemerId) body.redeemer_id = redeemerId;
    return this.request('POST', `/api/v1/wallet/vouchers/${voucherId}/redeem`, body);
  }

  // ==================== Split Endpoints (Phase 7 - MINIMAL backing) ====================

  /**
   * Preview a voucher split operation
   * Shows rounding info before executing the split
   * @param {string} token - Cashu token to split
   * @param {number} sendFaceValue - Face value to send (in minor units, e.g., cents)
   * @returns {Object} Split preview:
   *   - requested_face_value: Original requested amount
   *   - actual_face_value: Actual amount after rounding
   *   - rounding_delta: Difference due to rounding
   *   - rounding_mode: 'FLOOR' | 'CEIL' | 'ROUND'
   *   - keep_face_value: Face value remaining after split
   *   - send_token_amount: Sats in the send token
   *   - keep_token_amount: Sats in the keep token
   */
  async splitPreview(token, sendFaceValue) {
    return this.request('POST', '/api/v1/wallet/vouchers/split/preview', {
      token,
      send_face_value: sendFaceValue
    });
  }

  /**
   * Execute a voucher split operation
   * Splits a token into two parts based on face value
   * @param {string} token - Cashu token to split
   * @param {number} sendFaceValue - Face value to send (in minor units)
   * @param {string} [memo] - Optional memo/message to embed in the send token (max 255 chars)
   * @returns {Object} Split result:
   *   - send_token: Token to send to recipient
   *   - keep_token: Token to keep
   *   - send_face_value: Face value of send token
   *   - keep_face_value: Face value of keep token
   *   - send_token_amount: Sats in send token
   *   - keep_token_amount: Sats in keep token
   *   - rounding_applied: Whether rounding was applied
   *   - rounding_mode: Rounding mode used
   */
  async splitExecute(token, sendFaceValue, memo = null, allowSwap = true) {
    const body = {
      token,
      send_face_value: sendFaceValue,
      is_swap_allowed: allowSwap
    };
    if (memo && memo.trim()) {
      body.memo = memo.trim().substring(0, 255);
    }
    return this.request('POST', '/api/v1/wallet/vouchers/split', body);
  }

  /**
   * Consolidate multiple vouchers into a single voucher
   * Vouchers must share the same unit, merchant, and expiry date
   * @param {string[]} tokens - Array of Cashu tokens to consolidate (minimum 2)
   * @returns {Object} Consolidated voucher:
   *   - voucher_id: New consolidated voucher ID
   *   - token: Consolidated Cashu token
   *   - face_value: Summed face value (in minor units)
   *   - face_unit: Currency code
   *   - face_decimals: Decimal places
   *   - display_face_value: Formatted display value
   *   - token_amount: Summed token amount in sats
   *   - issuance_ratio: Recalculated ratio
   *   - backing_strategy: Backing strategy
   *   - issuer_id: Merchant identifier
   *   - expires_at: Expiry timestamp
   *   - consolidated_count: Number of vouchers merged
   */
  async consolidateVouchers(tokens, idempotencyKey = null) {
    const headers = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return this.requestWithHeaders('POST', '/api/v1/wallet/vouchers/consolidate', { tokens }, headers);
  }

  // ==================== Token-based Redemption (Phase 7) ====================

  /**
   * Redeem a voucher by token (MINIMAL backing strategy)
   * Preferred method for Phase 7+ vouchers
   * @param {string} token - Cashu token to redeem
   * @param {string} [merchantId] - Merchant identifier (optional)
   * @param {number} [chargeFaceValue] - Amount to charge in face value minor units (optional, full redemption if not specified)
   * @returns {Object} Redemption result:
   *   - face_value: Face value redeemed
   *   - face_unit: Currency code
   *   - token_amount: Sats recovered
   *   - sats_recovered: Alias for token_amount
   *   - change_token: Token for remaining value (if partial redemption)
   *   - change_face_value: Face value of change token
   */
  async redeemByToken(token, merchantId = null, chargeFaceValue = null) {
    const body = { token };
    if (merchantId) body.merchant_id = merchantId;
    if (chargeFaceValue !== null) body.charge_face_value = chargeFaceValue;
    return this.request('POST', '/api/v1/wallet/redeem', body);
  }

  /**
   * Get voucher metadata from a token
   * Fetches face value, backing strategy, and other metadata without redeeming
   * @param {string} token - Cashu token
   * @returns {Object} Voucher metadata:
   *   - face_value: Face value in minor units
   *   - face_unit: Currency code
   *   - face_decimals: Decimal places
   *   - token_amount: Sats backing
   *   - backing_strategy: 'MINIMAL' | 'FULL' | 'LEGACY'
   *   - issuance_ratio: face_value / token_amount
   *   - expires_at: Expiration timestamp
   *   - merchant_metadata: Optional merchant info
   */
  async getTokenMetadata(token) {
    return this.request('POST', '/api/v1/wallet/token/metadata', { token });
  }

  /**
   * Validate a Cashu token by checking proof state against the mint
   * Uses NUT-07 checkstate to verify proofs are still unspent
   * @param {string} token - Cashu token to validate
   * @returns {Object} Validation result:
   *   - valid: boolean - true if all proofs are unspent
   *   - state: 'UNSPENT' | 'PENDING' | 'SPENT' - overall state
   *   - proofs: Array of { Y, state } for each proof
   */
  async validateToken(token) {
    return this.request('POST', '/api/v1/wallet/token/validate', { token });
  }

  // ==================== Wallet Endpoints ====================
  async getBalance() {
    return this.request('GET', '/api/v1/wallet/balance');
  }

  async send(amount, fromVoucherId) {
    return this.request('POST', '/api/v1/wallet/send', {
      amount,
      from_voucher_id: fromVoucherId
    });
  }

  /**
   * Receive/redeem a Cashu token
   * @param {string} token - The Cashu token to receive
   * @param {Object} [options] - Optional parameters
   * @param {string} [options.idempotencyKey] - Idempotency key to prevent duplicate processing
   * @returns {Promise<Object>} Receive response with voucher details
   */
  async receive(token, options = {}) {
    const extraHeaders = {};

    // Add idempotency key if provided
    if (options.idempotencyKey) {
      extraHeaders['Idempotency-Key'] = options.idempotencyKey;
    }

    return this.requestWithHeaders('POST', '/api/v1/wallet/receive', { token }, extraHeaders);
  }

  /**
   * Acknowledge successful save of fresh proofs from a receive operation.
   * Call this after saveVoucher() succeeds to release the backend escrow.
   * @param {string} receiveId - The escrow receive ID from the receive response
   * @returns {Promise<void>}
   */
  async acknowledgeReceive(receiveId) {
    return this.requestWithHeaders('POST', `/api/v1/wallet/receive/${receiveId}/ack`, {});
  }

  /**
   * Get pending (unacknowledged) receive escrows for the authenticated user.
   * Call on app startup to recover proofs from failed localStorage saves.
   * @returns {Promise<Array>} List of pending receive escrows with fresh tokens
   */
  async getPendingReceives() {
    return this.requestWithHeaders('GET', '/api/v1/wallet/receive/pending', null);
  }

  /**
   * Make a request with additional custom headers
   * @param {string} method - HTTP method
   * @param {string} path - API path
   * @param {Object} body - Request body
   * @param {Object} extraHeaders - Additional headers to include
   * @returns {Promise<*>} Response data
   */
  async requestWithHeaders(method, path, body = null, extraHeaders = {}) {
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    const fullUrl = `${this.baseUrl}${path}`;
    const authUrl = `${this.authBaseUrl}${path}`;
    const bodyJson = body ? JSON.stringify(body) : null;

    // Use NIP-98 auth for profile endpoints, API key for others
    if (this._requiresNip98Auth(path, method)) {
      if (this._nostrPublicKey && typeof NostrUtils !== 'undefined') {
        try {
          const authHeader = await NostrUtils.createNip98AuthHeader(
            authUrl,
            method,
            this._nostrPublicKey,
            this._nostrPrivateKey,
            bodyJson
          );
          headers['Authorization'] = authHeader;
        } catch (error) {
          console.error('Failed to create NIP-98 auth header:', error);
          const err = new Error('NIP-98 auth required and signing failed: ' + error.message);
          err.code = 'NO_AUTH';
          throw err;
        }
      } else {
        const err = new Error('NIP-98 authentication required but Nostr credentials not set');
        err.code = 'NO_AUTH';
        throw err;
      }
    } else if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    } else if (this._canUseNip98Fallback(path, method) && this._nostrPublicKey && typeof NostrUtils !== 'undefined') {
      try {
        const authHeader = await NostrUtils.createNip98AuthHeader(
          authUrl,
          method,
          this._nostrPublicKey,
          this._nostrPrivateKey,
          bodyJson
        );
        headers['Authorization'] = authHeader;
      } catch (error) {
        console.warn('NIP-98 fallback auth failed:', error);
      }
    }

    const options = { method, headers };

    if (bodyJson && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = bodyJson;
    }

    const response = await fetch(fullUrl, options);

    if (response.status === 204) {
      return null;
    }

    let data;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    if (!response.ok) {
      const errorData = data.error || data;
      const errorMessage = errorData.message || errorData.error || 'API request failed';
      const error = new Error(errorMessage);
      error.status = response.status;
      // Backend's ErrorResponse uses `error.code`. The 009-prevent-self-sends
      // contract document used `error_code`; accept both spellings so the
      // frontend can branch on a single canonical `error.code` field.
      error.code = errorData.code
        || errorData.error_code
        || data.code
        || data.error_code
        || 'UNKNOWN_ERROR';
      error.data = data;
      throw error;
    }

    return data;
  }

  // ==================== Token DM Endpoints (NIP-44) ====================

  /**
   * Send a Cashu token via Nostr DM (NIP-44).
   * Backend accepts npub or hex for recipient_pubkey.
   * @param {string} token - Cashu token to send
   * @param {string} recipientPubkey - Recipient npub or hex
   * @param {Object} [options] - { memo, faceValue, faceUnit, tokenAmount, backingStrategy, relayUrls }
   * @returns {Object} SendTokenDmResponse
   */
  async sendTokenDm(token, recipientPubkey, options = {}) {
    const body = {
      token,
      recipient_pubkey: recipientPubkey
    };

    if (options.memo && options.memo.trim()) {
      body.memo = options.memo.trim();
    }

    // Include voucher metadata for proper face value display on recipient side
    if (options.faceValue != null) {
      body.face_value = options.faceValue;
    }
    if (options.faceUnit) {
      body.face_unit = options.faceUnit;
    }
    if (options.tokenAmount != null) {
      body.token_amount = options.tokenAmount;
    }
    if (options.backingStrategy) {
      body.backing_strategy = options.backingStrategy;
    }
    if (options.issuerId) {
      body.issuer_id = options.issuerId;
    }

    // Use provided relays or fall back to single infra relay
    const relays = options.relayUrls && options.relayUrls.length > 0
      ? options.relayUrls
      : (this.infraRelay ? [this.infraRelay] : []);
    if (relays.length > 0) {
      body.relay_urls = relays;
    }

    // Debug logging for DM send request
    console.log('[api] sendTokenDm body:', {
      recipient_pubkey: recipientPubkey?.slice(0, 16) + '...',
      face_value: body.face_value,
      face_unit: body.face_unit,
      token_amount: body.token_amount,
      backing_strategy: body.backing_strategy,
      relay_urls: body.relay_urls
    });

    return this.request('POST', '/api/v1/dm/tokens/send', body);
  }

  // Spec 038 T022 — DELETED: listTokenDms (GET /api/v1/dm/tokens?…).
  // The legacy 30-second poll loop that consumed this endpoint
  // (DmPollService.startApiPolling + DmPollService.poll) was removed
  // in T021; this helper is its sole consumer and goes with it. The
  // unified receive pipeline (NIP-17 SSE + catch-up via runCatchupTick)
  // queries gift wraps via /api/v1/nostr/query, NOT this endpoint.
  // The backend controller method is deprecated in Phase 7 (T054).

  /**
   * Get a specific received token DM by event ID.
   * @param {string} eventId - Nostr event ID
   * @returns {Object} ReceivedTokenDm
   */
  async getTokenDm(eventId) {
    return this.request('GET', `/api/v1/dm/tokens/${eventId}`);
  }

  /**
   * Claim a received token DM and add it to wallet balance.
   * @param {string} eventId - Nostr event ID
   * @returns {Object} ClaimTokenDmResponse
   */
  async claimTokenDm(eventId) {
    return this.request('POST', `/api/v1/dm/tokens/${eventId}/claim`);
  }

  /**
   * Inspects a raw Cashu voucher token and returns its embedded provenance
   * fields (issuer_id, voucher_id, face_value, face_unit, face_decimals,
   * backing_strategy). Stateless — used to backfill legacy vouchers in
   * localStorage that lack these fields so the home-screen voucher card
   * can resolve the merchant's display name.
   */
  async inspectVoucher(token) {
    return this.request('POST', '/api/v1/atomic/vouchers/inspect', { token });
  }

  /**
   * Spec 015 Defense E-2: fetch the per-part redemption status for an entire
   * bundle from the server-side `dm_token_inbox` table (Defense E-1, separate
   * spec / repo).
   *
   * Returns the JSON array of inbox rows on 200, or `null` on 404 (bundle
   * not yet ingested by the customer-wallet, or E-1 endpoint not deployed).
   * All other errors (5xx, network, malformed) propagate to the caller.
   *
   * @param {string} bundleId - 32-char hex bundle identifier.
   * @returns {Promise<Array<Object>|null>}
   */
  async fetchDmTokenInboxBundle(bundleId) {
    if (!bundleId || typeof bundleId !== 'string') {
      throw new Error('fetchDmTokenInboxBundle requires bundleId');
    }
    try {
      return await this.request(
        'GET',
        `/api/v1/dm/inbox/bundle/${encodeURIComponent(bundleId)}`
      );
    } catch (error) {
      if (error && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Reject a received token DM (does not delete event on relay).
   * @param {string} eventId - Nostr event ID
   * @returns {null}
   */
  async rejectTokenDm(eventId) {
    return this.request('POST', `/api/v1/dm/tokens/${eventId}/reject`);
  }

  /**
   * Delete a token DM from local list (server-side list).
   * @param {string} eventId - Nostr event ID
   * @returns {null}
   */
  async deleteTokenDm(eventId) {
    return this.request('DELETE', `/api/v1/dm/tokens/${eventId}`);
  }

  // Melt (Withdrawal) Endpoints
  async createMeltQuote(bolt11, unit = 'sat') {
    return this.request('POST', '/api/v1/wallet/melt/quote', { bolt11, unit });
  }

  async melt(quoteId) {
    return this.request('POST', '/api/v1/wallet/melt', { quote_id: quoteId });
  }

  // Transactions
  async getTransactions(limit = 50, offset = 0) {
    return this.request('GET', `/api/v1/wallet/transactions?limit=${limit}&offset=${offset}`);
  }

  // ==================== Token Backup Endpoints ====================

  /**
   * Backup tokens to server for cross-device sync and recovery
   * @param {Object[]} tokens - Array of token objects to backup
   * @returns {Object} - { backed_up: string[], failed: string[] }
   */
  async backupTokens(tokens) {
    return this.request('POST', '/api/v1/wallet/tokens/backup', { tokens });
  }

  /**
   * Fetch all backed up tokens from server
   * @returns {Object} - { tokens: Object[], last_modified: string }
   */
  async fetchBackedUpTokens() {
    return this.request('GET', '/api/v1/wallet/tokens/backup');
  }

  /**
   * Delete a token backup from server
   * @param {string} voucherId - Voucher ID to delete
   * @returns {Object} - { success: boolean }
   */
  async deleteTokenBackup(voucherId) {
    return this.request('DELETE', `/api/v1/wallet/tokens/backup/${voucherId}`);
  }

  /**
   * Delete multiple token backups from server
   * @param {string[]} voucherIds - Array of voucher IDs to delete
   * @returns {Object} - { deleted: string[], failed: string[] }
   */
  async deleteTokenBackups(voucherIds) {
    return this.request('POST', '/api/v1/wallet/tokens/backup/delete', { voucher_ids: voucherIds });
  }

  // ==================== Profile Endpoints ====================

  /**
   * Get profile metadata for a public key
   * Uses browser cache for faster retrieval, with fallback to API
   * @param {string} pubkey - Public key (hex format)
   * @param {boolean} [skipCache=false] - Skip cache and fetch fresh data
   * @returns {Object} - Profile metadata
   */
  _shouldUseProfileService() {
    if (typeof window === 'undefined') {
      return false;
    }

    try {
      return localStorage.getItem('imani_use_profile_service') !== 'false';
    } catch {
      return true;
    }
  }

  async _getProfileLegacy(pubkey, skipCache = false) {
    // Check cache first (if storage.js is loaded and not skipping cache)
    if (!skipCache && typeof getCachedProfile === 'function') {
      const cached = getCachedProfile(pubkey);
      if (cached) {
        console.log('[api] Profile loaded from cache:', pubkey.substring(0, 16) + '...');
        const pending = await this._getPendingProfileMirror('profile', pubkey);
        const mergedCached = this._mergePendingProfileData(cached, pending);
        if (pending) {
          return this._decorateProfileWithSyncStatus(
            mergedCached,
            this._buildProfileSyncStatus('profile', {
              relayAccepted: true,
              backendMirrored: false,
              reconciliationPending: true,
              eventId: pending.eventId,
              lastError: pending.lastError,
              updatedAt: pending.updatedAt,
            }),
          );
        }
        return mergedCached;
      }
    }

    // Fetch from API
    let profile = null;
    try {
      profile = await this.request('GET', `/api/v1/profiles/${pubkey}`);
    } catch (error) {
      const pending = await this._getPendingProfileMirror('profile', pubkey);
      if (pending?.profile) {
        return this._decorateProfileWithSyncStatus(
          { ...pending.profile },
          this._buildProfileSyncStatus('profile', {
            relayAccepted: true,
            backendMirrored: false,
            reconciliationPending: true,
            eventId: pending.eventId,
            lastError: pending.lastError || error.message,
            updatedAt: pending.updatedAt,
          }),
        );
      }
      throw error;
    }

    const pending = await this._getPendingProfileMirror('profile', pubkey);
    const mergedProfile = this._mergePendingProfileData(profile, pending);

    // Cache the result (if storage.js is loaded)
    if (mergedProfile && typeof setCachedProfile === 'function') {
      setCachedProfile(pubkey, mergedProfile);
      console.log('[api] Profile cached:', pubkey.substring(0, 16) + '...');
    }

    if (pending) {
      return this._decorateProfileWithSyncStatus(
        mergedProfile,
        this._buildProfileSyncStatus('profile', {
          relayAccepted: true,
          backendMirrored: false,
          reconciliationPending: true,
          eventId: pending.eventId,
          lastError: pending.lastError,
          updatedAt: pending.updatedAt,
        }),
      );
    }

    return mergedProfile;
  }

  async getProfile(pubkey, skipCache = false) {
    await this._reconcilePendingProfileMirror('profile', pubkey);

    if (this._shouldUseProfileService()) {
      try {
        const { getProfile: getProfileFromService } = await import('./profileService.js');
        const profile = await getProfileFromService(pubkey, {
          getProfile: this._getProfileLegacy.bind(this)
        }, skipCache);
        const pending = await this._getPendingProfileMirror('profile', pubkey);
        const mergedProfile = this._mergePendingProfileData(profile, pending);
        if (mergedProfile && typeof setCachedProfile === 'function') {
          setCachedProfile(pubkey, mergedProfile);
        }
        if (pending) {
          return this._decorateProfileWithSyncStatus(
            mergedProfile,
            this._buildProfileSyncStatus('profile', {
              relayAccepted: true,
              backendMirrored: false,
              reconciliationPending: true,
              eventId: pending.eventId,
              lastError: pending.lastError,
              updatedAt: pending.updatedAt,
            }),
          );
        }
        return mergedProfile;
      } catch (e) {
        console.warn('[api] Profile service failed, falling back to legacy:', e.message);
      }
    }

    return this._getProfileLegacy(pubkey, skipCache);
  }

  /**
   * Update profile metadata (NIP-01 kind-0 event)
   * Saves locally first for instant feedback, then publishes to relay.
   * Uses client-side signing when private key is available.
   * @param {string} pubkey - Public key (hex format)
   * @param {Object} profile - { name, about, picture, nip05, lud16, banner, website }
   * @returns {Object} - Updated profile
   */
  async updateProfile(pubkey, profile) {
    console.log('updateProfile called with:', { pubkey: pubkey.substring(0, 16) + '...', profile });
    console.log('Nostr credentials:', {
      hasPublicKey: !!this._nostrPublicKey,
      hasPrivateKey: !!this._nostrPrivateKey,
      hasNostrUtils: typeof NostrUtils !== 'undefined'
    });

    // Step 1: Get existing profile - try cache first, then fetch from relay
    let existingProfile = {};
    if (typeof getCachedProfile === 'function') {
      existingProfile = getCachedProfile(pubkey) || {};
    }

    // If cache is empty, fetch current profile from relay to avoid overwriting
    if (Object.keys(existingProfile).length === 0) {
      console.log('[api] Cache empty, fetching current profile from relay...');
      try {
        const fetchedProfile = await this.getProfile(pubkey, true); // skipCache=true
        if (fetchedProfile) {
          existingProfile = fetchedProfile;
          console.log('[api] Fetched existing profile:', Object.keys(existingProfile).join(', '));
        }
      } catch (e) {
        console.warn('[api] Could not fetch existing profile:', e.message);
      }
    }

    const updatedProfile = { ...existingProfile, pubkey, ...profile };
    if (typeof setCachedProfile === 'function') {
      setCachedProfile(pubkey, updatedProfile);
      console.log('[api] Profile saved locally:', pubkey.substring(0, 16) + '...');
    }

    // Step 2: Publish to relay (send full profile, not just changes)
    // CRITICAL: Only include NIP-01 compliant fields - NEVER publish private keys or sensitive data!
    // FR-009: this app does NOT write the `merchant` field on kind-0; POSSA Merchant owns that field.
    const safeProfileData = {
      name: updatedProfile.name || updatedProfile.displayName,
      about: updatedProfile.about,
      picture: updatedProfile.picture,
      nip05: updatedProfile.nip05,
      lud16: updatedProfile.lud16,
      banner: updatedProfile.banner,
      website: updatedProfile.website
    };
    // Remove undefined/null values
    Object.keys(safeProfileData).forEach(key => {
      if (safeProfileData[key] === undefined || safeProfileData[key] === null) {
        delete safeProfileData[key];
      }
    });

    // Spec 042 (fail-closed beta): do NOT write lud16 (Lightning Address) to the
    // published kind-0 while Bitcoin/Lightning features are disabled. This is the
    // single chokepoint for all profile publishes (editor, onboarding, sync). The
    // local cache (set above) keeps lud16 for re-activation; only the on-relay
    // profile omits it. Fail-closed: strip unless the gate affirmatively reports
    // enabled.
    let _bitcoinEnabled = false;
    try {
      const _bf = (typeof BitcoinFeatures !== 'undefined' && BitcoinFeatures)
        || (typeof globalThis !== 'undefined' && globalThis.BitcoinFeatures);
      if (_bf && typeof _bf.isBitcoinEnabledAsync === 'function') {
        _bitcoinEnabled = (await _bf.isBitcoinEnabledAsync()) === true;
      }
    } catch (_e) {
      _bitcoinEnabled = false;
    }
    if (!_bitcoinEnabled && 'lud16' in safeProfileData) {
      delete safeProfileData.lud16;
      console.log('[api] lud16 omitted from published kind-0 (Bitcoin features disabled — spec 042)');
    }

    if (this._nostrPublicKey && this._nostrPrivateKey) {
      const syncLedger = await this._ensureSyncLedgerProfileSync(pubkey);
      if (syncLedger?.updateProfile) {
        const syncResult = await syncLedger.updateProfile(safeProfileData);
        return { ...updatedProfile, ...syncResult };
      }
    }

    // Fallback: local relay publish without sync-ledger support
    if (this._nostrPublicKey && this._nostrPrivateKey && typeof NostrUtils !== 'undefined') {
      try {
        console.log('Creating signed profile event...');
        const signedEvent = await NostrUtils.createProfileEvent(
          this._nostrPublicKey,
          this._nostrPrivateKey,
          safeProfileData  // Only safe NIP-01 fields
        );
        console.log('[api] Signed profile event created:', this._summarizeSignedEventForLog(signedEvent));

        // Publish directly to relay (not through backend API)
        const published = await NostrUtils.publishEvent(signedEvent);
        if (!published) {
          throw new Error('Relay publish returned false');
        }
        console.log('[api] Profile published to relay successfully');

        // Also store in backend nostrdb for local queries (gateway uses different relay)
        try {
          await this._mirrorSignedEventToBackend(signedEvent);
          this._clearPendingProfileMirror('profile', pubkey);
          console.log('[api] Profile stored in backend nostrdb');
        } catch (backendError) {
          console.warn('[api] Failed to store in backend nostrdb:', backendError.message);
          await this._recordPendingProfileMirror('profile', pubkey, updatedProfile, signedEvent, backendError.message);
          return this._decorateProfileWithSyncStatus(
            updatedProfile,
            this._buildProfileSyncStatus('profile', {
              relayAccepted: true,
              backendMirrored: false,
              reconciliationPending: true,
              eventId: signedEvent.id,
              lastError: backendError.message,
            }),
          );
        }

        return this._decorateProfileWithSyncStatus(
          updatedProfile,
          this._buildProfileSyncStatus('profile', {
            relayAccepted: true,
            backendMirrored: true,
            reconciliationPending: false,
            eventId: signedEvent.id,
          }),
        );
      } catch (error) {
        console.error('Failed to publish profile to relay:', error);
        // Profile is already saved locally, so we can return it
        // but warn that relay sync failed
        console.warn('[api] Profile saved locally but relay sync failed');
        throw new Error('Profile saved locally but failed to sync to relay: ' + error.message);
      }
    }

    // Fallback to server-side signing
    // This happens when: no private key available locally
    console.log('Falling back to server-side signing (no local private key)...');
    console.log('Local signing unavailable:', {
      hasPublicKey: !!this._nostrPublicKey,
      hasPrivateKey: !!this._nostrPrivateKey,
      hasNostrUtils: typeof NostrUtils !== 'undefined'
    });
    try {
      const result = await this.request('PUT', `/api/v1/profiles/${pubkey}`, safeProfileData);
      console.log('[api] Profile published to relay successfully');
      this._clearPendingProfileMirror('profile', pubkey);
      return result || updatedProfile;
    } catch (error) {
      console.error('Failed to publish profile to relay:', error);
      console.warn('[api] Profile saved locally but relay sync failed');
      throw new Error('Profile saved locally but failed to sync to relay: ' + error.message);
    }
  }

  /**
   * Get merchant profile for a public key
   * Uses browser cache for faster retrieval, with fallback to API
   * @param {string} pubkey - Public key (hex format)
   * @param {boolean} [skipCache=false] - Skip cache and fetch fresh data
   * @returns {Object} - Merchant profile
   */
  async _getMerchantProfileLegacy(pubkey, skipCache = false) {
    // Check cache first
    if (!skipCache && typeof getCachedMerchantProfile === 'function') {
      const cached = getCachedMerchantProfile(pubkey);
      if (cached) {
        console.log('[api] Merchant profile loaded from cache:', pubkey.substring(0, 16) + '...');
        const pending = await this._getPendingProfileMirror('merchant', pubkey);
        const mergedCached = this._normalizeMerchantProfile(this._mergePendingProfileData(cached, pending));
        if (pending) {
          return this._decorateProfileWithSyncStatus(
            mergedCached,
            this._buildProfileSyncStatus('merchant', {
              relayAccepted: true,
              backendMirrored: false,
              reconciliationPending: true,
              eventId: pending.eventId,
              lastError: pending.lastError,
              updatedAt: pending.updatedAt,
            }),
          );
        }
        return mergedCached;
      }
    }

    // Fetch from API
    let profile = null;
    try {
      profile = await this.request('GET', `/api/v1/profiles/${pubkey}/merchant`);
    } catch (error) {
      const pending = await this._getPendingProfileMirror('merchant', pubkey);
      if (pending?.profile) {
        const mergedPending = this._normalizeMerchantProfile({ ...pending.profile });
        return this._decorateProfileWithSyncStatus(
          mergedPending,
          this._buildProfileSyncStatus('merchant', {
            relayAccepted: true,
            backendMirrored: false,
            reconciliationPending: true,
            eventId: pending.eventId,
            lastError: pending.lastError || error.message,
            updatedAt: pending.updatedAt,
          }),
        );
      }
      throw error;
    }

    // Normalize first, then cache the normalized result
    const pending = await this._getPendingProfileMirror('merchant', pubkey);
    const normalizedProfile = this._normalizeMerchantProfile(this._mergePendingProfileData(profile, pending));

    // Cache the normalized result
    if (normalizedProfile && typeof setCachedMerchantProfile === 'function') {
      setCachedMerchantProfile(pubkey, normalizedProfile);
      console.log('[api] Merchant profile cached:', pubkey.substring(0, 16) + '...');
    }

    if (pending) {
      return this._decorateProfileWithSyncStatus(
        normalizedProfile,
        this._buildProfileSyncStatus('merchant', {
          relayAccepted: true,
          backendMirrored: false,
          reconciliationPending: true,
          eventId: pending.eventId,
          lastError: pending.lastError,
          updatedAt: pending.updatedAt,
        }),
      );
    }

    return normalizedProfile;
  }

  async getMerchantProfile(pubkey, skipCache = false) {
    await this._reconcilePendingProfileMirror('merchant', pubkey);

    if (this._shouldUseProfileService()) {
      try {
        const { getMerchantProfile: getMerchantProfileFromService } = await import('./profileService.js');
        const profile = await getMerchantProfileFromService(pubkey, {
          getMerchantProfile: this._getMerchantProfileLegacy.bind(this)
        }, skipCache);
        // Still normalize for consistency
        const pending = await this._getPendingProfileMirror('merchant', pubkey);
        const normalized = this._normalizeMerchantProfile(this._mergePendingProfileData(profile, pending));
        // Cache the profile service result locally so subsequent loads are instant
        if (normalized && typeof setCachedMerchantProfile === 'function') {
          // Merge with existing cache to preserve fields the API may not return
          const existing = typeof getCachedMerchantProfile === 'function'
            ? getCachedMerchantProfile(pubkey) || {}
            : {};
          setCachedMerchantProfile(pubkey, { ...existing, ...normalized });
        }
        if (pending) {
          return this._decorateProfileWithSyncStatus(
            normalized,
            this._buildProfileSyncStatus('merchant', {
              relayAccepted: true,
              backendMirrored: false,
              reconciliationPending: true,
              eventId: pending.eventId,
              lastError: pending.lastError,
              updatedAt: pending.updatedAt,
            }),
          );
        }
        return normalized;
      } catch (e) {
        console.warn('[api] Profile service failed for merchant, falling back to legacy:', e.message);
      }
    }

    return this._getMerchantProfileLegacy(pubkey, skipCache);
  }

  /**
   * Helper to normalize the active field in merchant profiles
   * @param {Object} profile - Merchant profile
   * @returns {Object} - Normalized profile
   */
  _normalizeMerchantProfile(profile) {
    if (!profile) return profile;
    // Normalize active flag - handle all possible truthy representations
    const originalActive = profile.active;
    let isActive = false;

    if (typeof originalActive === 'boolean') {
      isActive = originalActive;
    } else if (typeof originalActive === 'string') {
      // Handle string representations: 'true', '1', 'yes', 'active'
      const lowerVal = originalActive.toLowerCase().trim();
      isActive = lowerVal === 'true' || lowerVal === '1' || lowerVal === 'yes' || lowerVal === 'active';
    } else if (typeof originalActive === 'number') {
      // Handle numeric: 1 = true, 0 = false
      isActive = originalActive === 1;
    }

    profile.active = isActive;
    console.log('[api] Merchant profile active:', isActive, '(original:', originalActive, ', type:', typeof originalActive, ')');
    return profile;
  }

  /**
   * Get contact list (follows) for a public key from Nostr relays.
   * Fetches the kind-3 contact list event (NIP-02).
   * @param {string} pubkey - Public key (hex format)
   * @returns {Object} - { pubkey, contacts: string[], count: number }
   */
  async getContacts(pubkey) {
    return this.request('GET', `/api/v1/profiles/${pubkey}/contacts`);
  }

  /**
   * Create or update merchant profile (NIP-78 kind-30078 event)
   * Saves locally first for instant feedback, then publishes to relay.
   * Uses client-side signing when private key is available.
   * @param {string} pubkey - Public key (hex format)
   * @param {Object} merchantProfile - { active, categories, storeDescription, location, operatingHours, paymentMethods }
   * @returns {Object} - Updated merchant profile
   */
  async updateMerchantProfile(pubkey, merchantProfile) {
    // Step 1: Merge with existing cached merchant profile and save locally
    let existingProfile = {};
    if (typeof getCachedMerchantProfile === 'function') {
      const cached = getCachedMerchantProfile(pubkey) || {};
      // Skip merging if cached profile is a placeholder "no profile exists" response
      if (!cached.message?.includes('No merchant profile exists')) {
        existingProfile = cached;
      }
    }
    // Strip undefined values from incoming profile so partial updates don't clobber existing fields
    const definedUpdates = Object.fromEntries(
      Object.entries(merchantProfile).filter(([, v]) => v !== undefined)
    );
    // Remove any stale message field from the profile data
    const { message, ...cleanProfile } = { ...existingProfile, pubkey, ...definedUpdates };
    // Normalize: remove snake_case duplicates that conflict with camelCase fields.
    // The backend may return snake_case (e.g. payment_methods) while the frontend saves camelCase
    // (paymentMethods). If both exist, the backend picks the snake_case (old) value on next read.
    const snakeToCamel = {
      payment_methods: 'paymentMethods',
      business_name: 'businessName',
      business_type: 'businessType',
      voucher_validity_days: 'voucherValidityDays',
      issuance_currency: 'issuanceCurrency',
      issuance_ratio: 'issuanceRatio',
      created_at: 'createdAt',
      verified_at: 'verifiedAt',
    };
    for (const [snake, camel] of Object.entries(snakeToCamel)) {
      if (snake in cleanProfile && camel in cleanProfile) {
        // Keep camelCase (frontend canonical), drop snake_case
        delete cleanProfile[snake];
      }
    }
    const updatedProfile = cleanProfile;
    if (typeof setCachedMerchantProfile === 'function') {
      setCachedMerchantProfile(pubkey, updatedProfile);
      console.log('[api] Merchant profile saved locally:', pubkey.substring(0, 16) + '...');
    }

    // Step 2: Publish to relay
    const { pubkey: _, ...profileData } = updatedProfile;

    if (this._nostrPublicKey && this._nostrPrivateKey) {
      const syncLedger = await this._ensureSyncLedgerProfileSync(pubkey);
      if (syncLedger?.updateMerchantProfile) {
        const syncResult = await syncLedger.updateMerchantProfile(profileData);
        return { ...updatedProfile, ...syncResult };
      }
    }

    // Fallback: local relay publish without sync-ledger support
    if (this._nostrPublicKey && this._nostrPrivateKey && typeof NostrUtils !== 'undefined') {
      try {
        const signedEvent = await NostrUtils.createMerchantProfileEvent(
          this._nostrPublicKey,
          this._nostrPrivateKey,
          profileData
        );
        // Publish directly to relay
        const published = await NostrUtils.publishEvent(signedEvent);
        if (!published) {
          throw new Error('Relay publish returned false');
        }
        console.log('[api] Merchant profile published to relay successfully');

        // Also store in backend nostrdb for local queries (gateway uses different relay)
        try {
          await this._mirrorSignedEventToBackend(signedEvent);
          this._clearPendingProfileMirror('merchant', pubkey);
          console.log('[api] Merchant profile stored in backend nostrdb');
        } catch (backendError) {
          console.warn('[api] Failed to store in backend nostrdb:', backendError.message);
          await this._recordPendingProfileMirror('merchant', pubkey, updatedProfile, signedEvent, backendError.message);
          return this._decorateProfileWithSyncStatus(
            updatedProfile,
            this._buildProfileSyncStatus('merchant', {
              relayAccepted: true,
              backendMirrored: false,
              reconciliationPending: true,
              eventId: signedEvent.id,
              lastError: backendError.message,
            }),
          );
        }

        return this._decorateProfileWithSyncStatus(
          updatedProfile,
          this._buildProfileSyncStatus('merchant', {
            relayAccepted: true,
            backendMirrored: true,
            reconciliationPending: false,
            eventId: signedEvent.id,
          }),
        );
      } catch (error) {
        console.error('Failed to publish merchant profile to relay:', error);
        console.warn('[api] Merchant profile saved locally but relay sync failed');
        throw new Error('Merchant profile saved locally but failed to sync to relay: ' + error.message);
      }
    }

    // Fallback to server-side signing (requires bunker)
    try {
      const result = await this.request('PUT', `/api/v1/profiles/${pubkey}/merchant`, profileData);
      console.log('[api] Merchant profile published to relay successfully');
      this._clearPendingProfileMirror('merchant', pubkey);
      return result || updatedProfile;
    } catch (error) {
      console.error('Failed to publish merchant profile to relay:', error);
      console.warn('[api] Merchant profile saved locally but relay sync failed');
      throw new Error('Merchant profile saved locally but failed to sync to relay: ' + error.message);
    }
  }

  /**
   * Delete merchant profile
   * @param {string} pubkey - Public key (hex format)
   */
  async deleteMerchantProfile(pubkey) {
    const result = await this.request('DELETE', `/api/v1/profiles/${pubkey}/merchant`);
    this._clearPendingProfileMirror('merchant', pubkey);
    return result;
  }

  /**
   * List all identities (registered users)
   * @param {number} [page=1] - Page number (1-based)
   * @param {number} [pageSize=20] - Number of items per page
   * @returns {Object} - { identities: [{name, npub, pubkey_hex, ...}], total, page, page_size }
   */
  async listIdentities(page = 1, pageSize = 20) {
    return this.request('GET', `/api/v1/identities?page=${page}&page_size=${pageSize}`);
  }

  // ==================== Voucher Purchase Endpoints ====================

  /**
   * Create a voucher purchase intent (customer flow)
   * Customer pays full face value in sats to merchant's lud16
   * @param {Object} params - Purchase parameters
   * @param {number} params.face_value - Face value in minor units (e.g., cents)
   * @param {string} params.face_unit - Face value currency (EUR, USD, etc.)
   * @param {number} params.amount_sats - Amount in sats (from exchange rate)
   * @param {string} params.merchant_lud16 - Merchant's Lightning address
   * @param {string} params.bolt11 - BOLT11 invoice from LNURL-pay
   * @param {string} params.customer_pubkey - Customer's Nostr pubkey for Nutzap delivery
   * @param {string} [params.merchant_pubkey] - Merchant's pubkey (hex) for issuer identification
   * @returns {Object} - { purchase_id, payment_hash, status, expires_at, created_at }
   */
  async createVoucherPurchase(params) {
    const body = {
      face_value: params.face_value,
      face_unit: params.face_unit,
      amount_sats: params.amount_sats,
      merchant_lud16: params.merchant_lud16,
      bolt11: params.bolt11,
      customer_pubkey: params.customer_pubkey,
      backing_strategy: params.backing_strategy || 'PROPORTIONAL'
    };
    // Include merchant pubkey for issuer identification in SignedVoucher
    if (params.merchant_pubkey) {
      body.merchant_pubkey = params.merchant_pubkey;
    }
    if (params.voucher_validity_days != null) {
      body.voucher_validity_days = params.voucher_validity_days;
    }
    return this.request('POST', '/api/v1/voucher-purchase', body);
  }

  /**
   * Confirm a voucher purchase with payment preimage
   * Backend verifies SHA256(preimage) == payment_hash, creates voucher, sends via Nutzap
   * @param {Object} params - Confirmation parameters
   * @param {string} params.purchase_id - Purchase ID from createVoucherPurchase
   * @param {string} params.payment_preimage - 64-character hex preimage from Lightning payment
   * @returns {Object} - { purchase_id, status, voucher_id, nutzap_event_id, token, face_value, face_unit, confirmed_at, message }
   */
  async confirmVoucherPurchase(params) {
    return this.request('POST', `/api/v1/voucher-purchase/${params.purchase_id}/confirm`, {
      payment_preimage: params.payment_preimage
    });
  }

  /**
   * Get the status of a voucher purchase
   * @param {string} purchaseId - Purchase ID
   * @returns {Object} - { purchase_id, status, face_value, face_unit, amount_sats, merchant_lud16, payment_hash, voucher_id, nutzap_event_id, created_at, expires_at, confirmed_at }
   */
  async getVoucherPurchaseStatus(purchaseId) {
    return this.request('GET', `/api/v1/voucher-purchase/${purchaseId}`);
  }

  /**
   * List voucher purchases by customer (buyer's view)
   * @param {string} customerPubkey - Customer's hex pubkey
   * @param {Object} [options] - Pagination options
   * @param {number} [options.limit=20] - Max results (max 100)
   * @param {number} [options.offset=0] - Pagination offset
   * @returns {Array} - List of purchase records (as buyer)
   */
  async listVoucherPurchasesByCustomer(customerPubkey, { limit = 20, offset = 0 } = {}) {
    const params = new URLSearchParams({
      customer_pubkey: customerPubkey,
      limit: limit.toString(),
      offset: offset.toString()
    });
    return this.request('GET', `/api/v1/voucher-purchase?${params}`);
  }

  /**
   * List voucher sales by merchant (seller's view)
   * These are confirmed purchases where the user is the merchant receiving payment.
   * @param {string} merchantPubkey - Merchant's hex pubkey
   * @param {Object} [options] - Pagination options
   * @param {number} [options.limit=20] - Max results (max 100)
   * @param {number} [options.offset=0] - Pagination offset
   * @returns {Array} - List of sale records (as seller)
   */
  async listVoucherSalesByMerchant(merchantPubkey, { limit = 20, offset = 0 } = {}) {
    const params = new URLSearchParams({
      merchant_pubkey: merchantPubkey,
      limit: limit.toString(),
      offset: offset.toString()
    });
    return this.request('GET', `/api/v1/voucher-purchase?${params}`);
  }

  /**
   * Get list of available payment methods
   * @returns {Array} - List of payment method objects
   */
  async getPaymentMethods() {
    return this.request('GET', '/api/v1/profiles/payment-methods');
  }

  // ============================================================================
  // Atomic Purchase API (Escrow-based flow)
  // ============================================================================

  /**
   * Create a quote for an atomic voucher purchase.
   * The quote locks in the exchange rate and merchant details.
   * @param {Object} params - Quote parameters
   * @param {string} params.merchantId - Merchant's NIP-05 or pubkey (hex)
   * @param {number} params.faceValue - Face value in minor units (e.g., cents)
   * @param {string} params.faceUnit - Currency code (e.g., 'EUR', 'KES')
   * @param {string} params.paymentMethod - Payment method ('balance' or 'lightning')
   * @returns {Object} - { quoteId, merchantId, faceValue, faceUnit, amountSats, paymentMethod, expiresAt }
   */
  async createAtomicQuote(params) {
    const body = {
      merchant_id: params.merchantId,
      face_value: params.faceValue,
      face_unit: params.faceUnit,
      payment_method: params.paymentMethod,
      backing_strategy: params.backingStrategy || 'PROPORTIONAL'
    };
    if (params.voucherValidityDays != null) {
      body.voucher_validity_days = params.voucherValidityDays;
    }
    return this.request('POST', '/api/v1/atomic-purchase/quote', body);
  }

  /**
   * Initiate an atomic voucher purchase with escrow protection.
   * This starts the saga: escrow hold → mint voucher → release payment → deliver.
   * @param {Object} params - Initiation parameters
   * @param {string} params.quoteId - Quote ID from createAtomicQuote
   * @param {string} params.customerPubkey - Customer's Nostr pubkey (hex)
   * @param {string} [params.customerLnbitsAdminKey] - Customer's LNbits admin key for balance transfer (optional)
   * @param {string} [idempotencyKey] - Idempotency key for retry safety
   * @returns {Object} - { purchaseId, status, escrow, progress, canCancel, expiresAt }
   */
  async initiateAtomicPurchase(params, idempotencyKey = null) {
    const headers = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    const body = {
      quote_id: params.quoteId,
      customer_pubkey: params.customerPubkey
    };
    // Include LNbits admin key if provided (for actual balance transfer)
    if (params.customerLnbitsAdminKey) {
      body.customer_lnbits_admin_key = params.customerLnbitsAdminKey;
    }
    return this.requestWithHeaders('POST', '/api/v1/atomic-purchase', body, headers);
  }

  /**
   * Get the status of an atomic purchase.
   * Returns full progress information including current saga step.
   * @param {string} purchaseId - Purchase ID from initiateAtomicPurchase
   * @returns {Object} - { purchaseId, status, quote, merchant, escrow, progress, voucher, refund, canCancel, canClaim }
   */
  async getAtomicPurchaseStatus(purchaseId) {
    return this.requestWithHeaders('GET', `/api/v1/atomic-purchase/${purchaseId}`);
  }

  /**
   * Confirm escrow payment (for Lightning flow).
   * Called after customer pays the escrow invoice.
   * @param {string} purchaseId - Purchase ID
   * @param {string} [idempotencyKey] - Idempotency key for retry safety
   * @returns {Object} - { purchaseId, status, progress }
   */
  async confirmAtomicEscrow(purchaseId, idempotencyKey = null) {
    const headers = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return this.requestWithHeaders('POST', `/api/v1/atomic-purchase/${purchaseId}/escrow-confirm`, {}, headers);
  }

  /**
   * Cancel an atomic purchase (before escrow is held).
   * @param {string} purchaseId - Purchase ID
   * @param {string} [idempotencyKey] - Idempotency key for retry safety
   * @returns {Object} - { purchaseId, status: 'CANCELLED' }
   */
  async cancelAtomicPurchase(purchaseId, idempotencyKey = null) {
    const headers = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return this.requestWithHeaders('POST', `/api/v1/atomic-purchase/${purchaseId}/cancel`, {}, headers);
  }

  /**
   * Request a refund for an atomic purchase.
   * Only available if purchase is in a refundable state.
   * @param {string} purchaseId - Purchase ID
   * @param {string} [reason] - Optional reason for refund
   * @param {string} [customerLud16] - Customer's Lightning address for refund
   * @param {string} [idempotencyKey] - Idempotency key for retry safety
   * @returns {Object} - { purchaseId, status, refund }
   */
  async refundAtomicPurchase(purchaseId, reason = null, customerLud16 = null, idempotencyKey = null) {
    const headers = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    const body = {};
    if (reason) body.reason = reason;
    if (customerLud16) body.customer_lud16 = customerLud16;
    return this.requestWithHeaders('POST', `/api/v1/atomic-purchase/${purchaseId}/refund`, body, headers);
  }

  /**
   * Claim a voucher that failed automatic delivery.
   * Available when purchase is in DELIVERY_PENDING state.
   * @param {string} purchaseId - Purchase ID
   * @param {string} customerPubkey - Customer's Nostr pubkey (for authorization)
   * @param {string} [idempotencyKey] - Idempotency key for retry safety
   * @returns {Object} - { purchaseId, status: 'DELIVERED', voucher }
   */
  async claimAtomicVoucher(purchaseId, customerPubkey, idempotencyKey = null) {
    const headers = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return this.requestWithHeaders('POST', `/api/v1/atomic-purchase/${purchaseId}/claim`, {
      customer_pubkey: customerPubkey
    }, headers);
  }

  /**
   * Claim a refund for a purchase in REFUND_READY state.
   * Used when auto-refund via lud16 wasn't possible.
   * @param {string} purchaseId - Purchase ID
   * @param {string} [customerLnbitsAdminKey] - Customer's LNbits admin key for receiving refund
   * @param {string} [idempotencyKey] - Idempotency key for retry safety
   * @returns {Object} - { purchaseId, status: 'REFUNDED', refund }
   */
  async claimAtomicRefund(purchaseId, customerLnbitsAdminKey = null, idempotencyKey = null) {
    const headers = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    const body = {};
    if (customerLnbitsAdminKey) {
      body.customer_lnbits_admin_key = customerLnbitsAdminKey;
    }
    return this.requestWithHeaders('POST', `/api/v1/atomic-purchase/${purchaseId}/claim-refund`, body, headers);
  }

  // ==================== ATOMIC SEND OPERATIONS ====================

  /**
   * Initiate an atomic voucher send.
   * The server handles split + DM delivery atomically.
   * @param {Object} params - Send parameters
   * @param {string} params.token - Source Cashu token to split
   * @param {number} params.amount - Amount in sats to send
   * @param {string} params.recipientPubkey - Recipient's hex pubkey
   * @param {string} [params.memo] - Optional memo for the DM
   * @param {number} [params.faceValue] - Optional voucher face value
   * @param {string} [params.faceUnit] - Optional face value currency
   * @param {number} [params.faceDecimals] - Optional face value decimals
   * @param {string} [params.voucherId] - Optional voucher ID for tracking
   * @param {string} [idempotencyKey] - Optional idempotency key
   * @returns {Object} - { sendId, status, progress, sseUrl, ... }
   */
  async initiateAtomicSend(params, idempotencyKey = null) {
    const headers = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    const body = {
      token: params.token,
      amount: params.amount,
      recipient_pubkey: params.recipientPubkey,
    };
    if (params.memo) body.memo = params.memo;
    if (params.faceValue != null) body.face_value = params.faceValue;
    if (params.faceUnit) body.face_unit = params.faceUnit;
    if (params.faceDecimals != null) body.face_decimals = params.faceDecimals;
    if (params.voucherId) body.voucher_id = params.voucherId;
    if (params.paymentRequestId) body.payment_request_id = params.paymentRequestId;
    if (params.issuerId) body.issuer_id = params.issuerId;
    if (params.backingStrategy) body.backing_strategy = params.backingStrategy;
    if (params.expiresAt != null) body.expires_at = params.expiresAt;

    // Spec 012: bundle metadata for multi-source send aggregation.
    // Backend contract: contracts/atomic-send-api-extension.md §2.
    // All-or-nothing: if bundleId is present, the other four are required.
    // Backend rejects partial sets with `bundle_metadata_incomplete`.
    if (params.bundleId) {
      body.bundle_id = params.bundleId;
      body.bundle_total = params.bundleTotal;
      body.bundle_part_index = params.bundlePartIndex;
      body.bundle_part_count = params.bundlePartCount;
      body.bundle_part_id = params.bundlePartId;
      if (params.bundleAttempt != null) {
        body.bundle_attempt = params.bundleAttempt;
      }
    }

    return this.requestWithHeaders('POST', '/api/v1/atomic-send', body, headers);
  }

  /**
   * Get the status of an atomic send.
   * @param {string} sendId - Send ID from initiateAtomicSend
   * @returns {Object} - { sendId, status, progress, keepToken, canReclaim, ... }
   */
  async getAtomicSendStatus(sendId) {
    return this.requestWithHeaders('GET', `/api/v1/atomic-send/${sendId}`);
  }

  /**
   * Cancel an atomic send (before split has occurred).
   * @param {string} sendId - Send ID
   * @param {string} [idempotencyKey] - Optional idempotency key
   * @returns {Object} - Updated send status
   */
  async cancelAtomicSend(sendId, idempotencyKey = null) {
    const headers = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return this.requestWithHeaders('POST', `/api/v1/atomic-send/${sendId}/cancel`, {}, headers);
  }

  /**
   * Reclaim the send token after a failed DM delivery.
   * Returns the reclaimed token that can be saved back to the wallet.
   * @param {string} sendId - Send ID
   * @param {string} [idempotencyKey] - Optional idempotency key
   * @returns {Object} - { sendId, status, reclaimedToken, keepToken, ... }
   */
  async reclaimAtomicSend(sendId, idempotencyKey = null) {
    const headers = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return this.requestWithHeaders('POST', `/api/v1/atomic-send/${sendId}/reclaim`, {}, headers);
  }

  /**
   * Get send history for the authenticated user.
   * @param {number} [limit=20] - Max results
   * @param {number} [offset=0] - Pagination offset
   * @returns {Array} - List of send responses
   */
  async getAtomicSendHistory(limit = 20, offset = 0) {
    return this.requestWithHeaders('GET', `/api/v1/atomic-send/history?limit=${limit}&offset=${offset}`);
  }

  /**
   * Acknowledge receipt of a keep_token (best-effort).
   * Allows the backend to erase the token from the DB.
   * @param {string} sendId - Send ID
   * @returns {Promise<void>}
   */
  async ackKeepToken(sendId) {
    return this.requestWithHeaders('POST', `/api/v1/atomic-send/${sendId}/ack-keep-token`, {});
  }

  // ==================== Business Portal Endpoints ====================

  /**
   * Get portal sync status for the current merchant.
   * @returns {Object} - { state, snapshot_at, last_synced_at, progress_pct, retry_after_seconds }
   */
  async getPortalSyncStatus() {
    return this.request('GET', '/api/v1/portal/sync-status');
  }

  /**
   * Get portal dashboard metrics.
   * @param {Object} [params] - { from, to } ISO date strings
   * @returns {Object} - PortalDashboardResponse
   */
  async getPortalDashboard(params = {}) {
    const query = new URLSearchParams();
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);
    const qs = query.toString();
    return this.request('GET', `/api/v1/portal/dashboard${qs ? '?' + qs : ''}`);
  }

  /**
   * Get portal activity (daily series).
   * @param {Object} [params] - { from, to } ISO date strings
   * @returns {Object} - PortalActivityResponse
   */
  async getPortalActivity(params = {}) {
    const query = new URLSearchParams();
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);
    const qs = query.toString();
    return this.request('GET', `/api/v1/portal/dashboard/activity${qs ? '?' + qs : ''}`);
  }

  /**
   * Get portal real-time status snapshot.
   * @returns {Object} - PortalStatusResponse
   */
  async getPortalStatus() {
    return this.request('GET', '/api/v1/portal/dashboard/status');
  }

  /**
   * Get expiring vouchers.
   * @param {Object} [params] - { withinDays, limit }
   * @returns {Object} - PortalExpiringResponse
   */
  async getPortalExpiring(params = {}) {
    const query = new URLSearchParams();
    if (params.withinDays) query.set('within_days', params.withinDays);
    if (params.limit) query.set('limit', params.limit);
    const qs = query.toString();
    return this.request('GET', `/api/v1/portal/dashboard/expiring${qs ? '?' + qs : ''}`);
  }

  /**
   * Get all four dashboard sections in a single request.
   * @param {Object} [params] - { from, to, expiringWithinDays, expiringLimit }
   * @returns {Object} - { dashboard, activity, status, expiring }
   */
  async getPortalDashboardComposite(params = {}) {
    const query = new URLSearchParams();
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);
    if (params.expiringWithinDays) query.set('expiring_within_days', params.expiringWithinDays);
    if (params.expiringLimit) query.set('expiring_limit', params.expiringLimit);
    const qs = query.toString();
    return this.request('GET', `/api/v1/portal/dashboard/composite${qs ? '?' + qs : ''}`);
  }

  /**
   * List portal vouchers with filters and cursor pagination.
   * @param {Object} [params] - { status, campaignId, from, to, expiresWithinDays, limit, cursor }
   * @returns {Object} - PortalVoucherListResponse
   */
  async getPortalVouchers(params = {}) {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.campaignId) query.set('campaign_id', params.campaignId);
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);
    if (params.expiresWithinDays) query.set('expires_within_days', params.expiresWithinDays);
    if (params.limit) query.set('limit', params.limit);
    if (params.cursor) query.set('cursor', params.cursor);
    const qs = query.toString();
    return this.request('GET', `/api/v1/portal/vouchers${qs ? '?' + qs : ''}`);
  }

  /**
   * Create portal vouchers (batch).
   * @param {Object} payload - { face_value_minor, currency, quantity, expiry_days, memo, campaign_id }
   * @returns {Object} - CreatePortalVouchersResponse
   */
  async createPortalVouchers(payload) {
    return this.request('POST', '/api/v1/portal/vouchers', payload);
  }

  /**
   * Get portal voucher detail.
   * @param {string} id - Voucher ID
   * @returns {Object} - PortalVoucherDetailResponse
   */
  async getPortalVoucher(id) {
    return this.request('GET', `/api/v1/portal/vouchers/${encodeURIComponent(id)}`);
  }

  /**
   * Revoke a portal voucher.
   * @param {string} id - Voucher ID
   * @returns {Object} - RevokeVoucherResponse
   */
  async revokePortalVoucher(id) {
    return this.request('POST', `/api/v1/portal/vouchers/${encodeURIComponent(id)}/revoke`);
  }

  /**
   * Create a campaign.
   * @param {Object} payload - { name, description, start_date, end_date, default_face_value_minor, default_expiry_days }
   * @returns {Object} - PortalCampaignResponse
   */
  async createCampaign(payload) {
    return this.request('POST', '/api/v1/portal/campaigns', payload);
  }

  /**
   * List campaigns with summary metrics.
   * @returns {Array} - List of PortalCampaignSummary
   */
  async listCampaigns() {
    const resp = await this.request('GET', '/api/v1/portal/campaigns');
    return resp?.items || resp || [];
  }

  /**
   * Get a single campaign with summary metrics.
   * @param {string} id - Campaign ID
   * @returns {Object} - PortalCampaignSummary
   */
  async getCampaign(id) {
    return this.request('GET', `/api/v1/portal/campaigns/${encodeURIComponent(id)}`);
  }

  /**
   * Update a campaign.
   * @param {string} id - Campaign ID
   * @param {Object} payload - Campaign fields to update
   * @returns {Object} - PortalCampaignResponse
   */
  async updateCampaign(id, payload) {
    return this.request('PUT', `/api/v1/portal/campaigns/${encodeURIComponent(id)}`, payload);
  }

  /**
   * Delete a campaign.
   * @param {string} id - Campaign ID
   */
  async deleteCampaign(id) {
    return this.request('DELETE', `/api/v1/portal/campaigns/${encodeURIComponent(id)}`);
  }

  /**
   * Get campaign performance metrics.
   * @param {string} id - Campaign ID
   * @returns {Object} - PortalCampaignPerformance
   */
  async getCampaignPerformance(id) {
    return this.request('GET', `/api/v1/portal/campaigns/${encodeURIComponent(id)}/performance`);
  }

  /**
   * Export campaign data as CSV.
   * @param {string} id - Campaign ID
   * @returns {string} - CSV content
   */
  async exportCampaignCsv(id) {
    const url = `/api/v1/portal/campaigns/${encodeURIComponent(id)}/export.csv`;
    const path = url;
    const authUrl = `${this.authBaseUrl}${path}`;
    const headers = { 'Accept': 'text/csv' };

    if (this._nostrPublicKey && typeof NostrUtils !== 'undefined') {
      const authHeader = await NostrUtils.createNip98AuthHeader(
        authUrl, 'GET', this._nostrPublicKey, this._nostrPrivateKey, null
      );
      headers['Authorization'] = authHeader;
    }

    const response = await fetch(`${this.baseUrl}${url}`, { headers });
    if (!response.ok) throw new Error(`CSV export failed: ${response.status}`);
    return response.text();
  }

  /**
   * Create a portal SSE event session (returns stream token).
   * @returns {Object} - { stream_token, expires_at, stream_url }
   */
  async createPortalEventSession() {
    return this.request('POST', '/api/v1/portal/events/session');
  }

  /**
   * Subscribe to portal SSE events using a stream token.
   * Handles keepalive, auth expiry with auto-renewal, and reconnection.
   * @param {string} streamToken - Stream token from createPortalEventSession
   * @param {function} onEvent - Callback: (eventName, data) => void
   * @param {function} [onError] - Error callback
   * @returns {{ close: function }} Controller with close() method
   */
  subscribeToPortalEvents(streamToken, onEvent, onError = null) {
    const controller = new AbortController();
    let closed = false;
    let retryCount = 0;
    const MAX_RETRIES = 5;

    const connect = async (token) => {
      if (closed) return;
      try {
        const url = `${this.baseUrl}/api/v1/portal/events?stream_token=${encodeURIComponent(token)}`;
        const response = await fetch(url, {
          headers: { 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache' },
          signal: controller.signal
        });

        if (!response.ok) throw new Error(`SSE connection failed: ${response.status}`);
        retryCount = 0; // Reset on successful connection

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let eventType = 'message';
        let eventData = '';

        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventType = line.substring(6).trim();
            } else if (line.startsWith('data:')) {
              eventData += (eventData ? '\n' : '') + line.substring(5).trim();
            } else if (line === '') {
              if (eventData) {
                try {
                  const data = JSON.parse(eventData);
                  if (eventType === 'system.auth_expired') {
                    // Auto-renew token and reconnect
                    try {
                      const session = await this.createPortalEventSession();
                      connect(session.stream_token);
                    } catch (renewErr) {
                      if (onError) onError(renewErr);
                    }
                    return;
                  }
                  if (eventType !== 'system.keepalive') {
                    onEvent(eventType, data);
                  }
                } catch (e) {
                  // Non-JSON data, ignore
                }
              }
              eventType = 'message';
              eventData = '';
            }
          }
        }
      } catch (e) {
        if (e.name === 'AbortError' || closed) return;
        retryCount++;
        if (retryCount > MAX_RETRIES) {
          console.warn('[api] Portal SSE max retries reached, giving up');
          if (onError) onError(e);
          return;
        }
        console.warn(`[api] Portal SSE error (retry ${retryCount}/${MAX_RETRIES}):`, e.message);
        if (onError) onError(e);
        // Exponential backoff: 3s, 6s, 12s, 24s, 48s
        const delay = 3000 * Math.pow(2, retryCount - 1);
        if (!closed) {
          setTimeout(() => connect(token), delay);
        }
      }
    };

    connect(streamToken);

    return {
      close: () => {
        closed = true;
        controller.abort();
      }
    };
  }

  // ==================== Cash Payment Endpoints (Offline Payments) ====================

  /**
   * Create an offline cash payment invoice.
   * @param {Object} params - { amount, fiat, memo, ttlSeconds, relayUrls }
   * @param {string} [idempotencyKey] - Idempotency key
   * @returns {Object} - { ref, status, proofCode, expiresAt, qrPayload, qrDataUri }
   */
  async createCashInvoice(params, idempotencyKey = null) {
    const headers = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    const body = {
      amount: params.amount,
      relay_urls: params.relayUrls || GatewayConfig.getRelays(),
    };
    if (params.fiat) body.fiat = params.fiat;
    if (params.memo) body.memo = params.memo.substring(0, 140);
    if (params.ttlSeconds) body.ttl_seconds = params.ttlSeconds;
    if (params.method) body.method = params.method;
    return this.requestWithHeaders('POST', '/api/v1/cash/invoice', body, headers);
  }

  /**
   * Get the current status of a cash invoice.
   * @param {string} ref - Invoice reference
   * @returns {Object} - Invoice status object
   */
  async getCashInvoice(ref) {
    return this.requestWithHeaders('GET', `/api/v1/cash/invoice/${encodeURIComponent(ref)}`);
  }

  /**
   * Merchant confirms cash payment received.
   * @param {string} ref - Invoice reference
   * @param {string} [idempotencyKey] - Idempotency key
   * @returns {Object} - Updated invoice status
   */
  async confirmCashReceipt(ref, idempotencyKey = null) {
    const headers = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return this.requestWithHeaders('POST', `/api/v1/cash/invoice/${encodeURIComponent(ref)}/confirm`, {}, headers);
  }

  /**
   * Cancel a cash invoice.
   * @param {string} ref - Invoice reference
   * @param {string} [idempotencyKey] - Idempotency key
   * @returns {null}
   */
  async cancelCashInvoice(ref, idempotencyKey = null) {
    const headers = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return this.requestWithHeaders('POST', `/api/v1/cash/invoice/${encodeURIComponent(ref)}/cancel`, {}, headers);
  }

  /**
   * Customer submits intent to pay a cash invoice.
   * @param {string} ref - Invoice reference
   * @param {Object} params - { customerPubkey, idempotencyKey }
   * @returns {Object} - { proofCode, status }
   */
  async submitCashIntent(ref, params = {}) {
    const headers = {};
    if (params.idempotencyKey) {
      headers['Idempotency-Key'] = params.idempotencyKey;
    }
    const body = {};
    if (params.customerPubkey) {
      body.customer_pubkey = params.customerPubkey;
    }
    return this.requestWithHeaders('POST', `/api/v1/cash/invoice/${encodeURIComponent(ref)}/intent`, body, headers);
  }

  /**
   * Customer claims a voucher when DM delivery failed.
   * @param {string} ref - Invoice reference
   * @param {Object} params - { customerPubkey, idempotencyKey }
   * @returns {Object} - { token } Cashu token
   */
  async claimCashVoucher(ref, params = {}) {
    const headers = {};
    if (params.idempotencyKey) {
      headers['Idempotency-Key'] = params.idempotencyKey;
    }
    const body = {};
    if (params.customerPubkey) {
      body.customer_pubkey = params.customerPubkey;
    }
    return this.requestWithHeaders('POST', `/api/v1/cash/invoice/${encodeURIComponent(ref)}/claim`, body, headers);
  }

  // ==================== Spec 014: Payment Receipts (US2 durable JMS) ====================
  // All three are NIP-98-authed POSTs (matched by _requiresNip98Auth above).
  // Treats 202 Accepted and 409 Conflict as success on enqueue (idempotent).

  /**
   * Recipient → broker: enqueue a NIP-44-encrypted receipt envelope.
   *
   * @param {{
   *   receiptId: string,         // 64 hex chars
   *   senderPubkeyHex: string,   // 64 hex chars
   *   recipientPubkeyHex: string,// 64 hex chars (must match authed user)
   *   ciphertextBase64: string   // base64 NIP-44 v2 ciphertext
   * }} body
   * @returns {Promise<{ receiptId: string, status: 'enqueued'|'duplicate' }>}
   */
  async postPaymentReceipt(body) {
    try {
      const result = await this.request('POST', '/api/v1/payment-receipts', body);
      return result;
    } catch (err) {
      // The default request() helper rejects on non-2xx; treat 409 as a
      // logical success per the OpenAPI contract (idempotent dedup).
      if (err && (err.status === 409 || err.code === 'CONFLICT')) {
        return { receiptId: body?.receiptId, status: 'duplicate' };
      }
      throw err;
    }
  }

  /**
   * Sender → broker: drain pending receipts addressed to the authed user.
   *
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<{
   *   receipts: Array<{ receiptId: string, ciphertextBase64: string,
   *                     enqueuedAt: number, consumeToken: string }>,
   *   nonce: string,
   *   moreAvailable: boolean
   * }>}
   */
  async drainPaymentReceipts(opts = {}) {
    const body = (opts && opts.limit != null) ? { limit: opts.limit } : {};
    return this.request('POST', '/api/v1/payment-receipts/drain', body);
  }

  /**
   * Sender → broker: acknowledge consumption of one or more drained receipts.
   *
   * @param {{ nonce: string, consumeTokens: string[] }} body
   * @returns {Promise<{ acknowledged: number, ignored: number }>}
   */
  async ackPaymentReceipts(body) {
    return this.request('POST', '/api/v1/payment-receipts/ack', body);
  }

  /**
   * Spec 018 T044 — recipient drains pending incoming-payment notification
   * envelopes addressed to its pubkey (derived from the NIP-98 auth).
   * Browser-only on the server side: envelopes stay in the queue after the
   * drain, and the client de-duplicates on notificationId.
   *
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<{ envelopes: Array<object>, moreAvailable: boolean }>}
   */
  async drainIncomingNotifications(opts = {}) {
    const body = (opts && opts.limit != null) ? { limit: opts.limit } : {};
    return this.request('POST', '/api/v1/incoming-notifications/drain', body);
  }

  /**
   * Subscribe to real-time cash invoice status updates via SSE.
   * @param {string} ref - Invoice reference
   * @param {function} onUpdate - Callback for status updates
   * @param {function} [onError] - Callback for errors
   * @returns {{ close: function }} Controller with close() method
   */
  subscribeCashInvoiceEvents(ref, onUpdate, onError = null) {
    const url = `${this.baseUrl}/api/v1/cash/invoice/${encodeURIComponent(ref)}/events`;
    return this._subscribeSSE(url, onUpdate, onError,
      ['COMPLETED', 'EXPIRED', 'CANCELLED', 'MANUAL_ATTENTION', 'DELIVERY_PENDING']);
  }

  /**
   * Subscribe to SSE events with NIP-98 auth headers.
   * Uses fetch() + ReadableStream since browser EventSource cannot send custom headers.
   *
   * @param {string} url - Full SSE URL
   * @param {function} onUpdate - Callback for parsed event data
   * @param {function} onError - Callback for errors
   * @param {string[]} terminalStates - States that trigger auto-close
   * @returns {{ close: function }} Controller with close() method
   */
  _subscribeSSE(url, onUpdate, onError, terminalStates) {
    const controller = new AbortController();
    let lastEventId = null;
    // Issue #306 — saga SSE reliability. Two reinforcements over the
    // previous "connect once, give up on error" behaviour:
    //
    // 1. SSE reconnect with exponential backoff. The Last-Event-ID
    //    header is sent on every reconnect so the server resumes from
    //    where the previous stream stopped (avoids skipping a state
    //    transition that happened during the drop). Stops when a
    //    terminal state is reached or the caller calls close().
    //
    // 2. Polling backstop on the same per-id GET endpoint. The SSE URL
    //    convention is `<base>/events`; the poll endpoint is derived by
    //    stripping that path segment (Copilot review on PR #305,
    //    comment 3344267557 — use the URL parser, not raw endsWith,
    //    so the derivation survives query strings/fragments). Polls
    //    every 5s, but only fires a request if the SSE channel has been
    //    silent for the full interval — so a healthy stream produces
    //    zero poll requests. A terminal state from either path aborts
    //    both. Closes the saga channel's equivalent of the inbound
    //    NIP-17 SSE-drop gap that issue #304 fixed for the inbox.
    let lastUpdateAt = Date.now();
    let terminalReached = false;
    let reconnectAttempts = 0;
    let reconnectTimer = null;        // Copilot #3344267534 — single-flight reconnect.
    let pollTimer = null;
    let pollInFlight = false;         // Copilot #3344267581 — poll in-flight guard.
    const POLL_INTERVAL_MS = 5000;
    const RECONNECT_MAX_DELAY_MS = 5000;
    let pollUrl = null;
    try {
      const parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
      if (parsed.pathname.endsWith('/events')) {
        parsed.pathname = parsed.pathname.slice(0, -'/events'.length);
        // Drop the search/fragment on the poll endpoint — the SSE
        // search params (e.g. ?stream=1) typically don't apply to the
        // poll endpoint, and the poll handler reads the canonical
        // resource state.
        parsed.search = '';
        parsed.hash = '';
        pollUrl = parsed.toString();
      }
    } catch (_e) { /* keep pollUrl null — backstop simply won't run */ }

    const dispatchUpdate = (data) => {
      lastUpdateAt = Date.now();
      onUpdate(data);
      if (data.status && terminalStates.includes(data.status)) {
        terminalReached = true;
        controller.abort();
        return true;
      }
      return false;
    };

    const connect = async () => {
      try {
        const headers = {};

        // Generate NIP-98 auth header
        const path = new URL(url, window.location.origin).pathname;
        if (this._requiresNip98Auth(path, 'GET') && this._nostrPublicKey && typeof NostrUtils !== 'undefined') {
          const authUrl = `${this.authBaseUrl}${path}`;
          const authHeader = await NostrUtils.createNip98AuthHeader(
            authUrl, 'GET', this._nostrPublicKey, this._nostrPrivateKey, null
          );
          headers['Authorization'] = authHeader;
        }

        if (lastEventId) {
          headers['Last-Event-ID'] = lastEventId;
        }

        headers['Accept'] = 'text/event-stream';
        headers['Cache-Control'] = 'no-cache';

        const response = await fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`SSE connection failed: ${response.status}`);
        }

        // Successful (re)connect — reset backoff counter + clear any
        // pending reconnect timer that may have been scheduled while
        // an earlier connect attempt was racing.
        reconnectAttempts = 0;
        if (reconnectTimer !== null) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Parse SSE events from buffer
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // keep incomplete line

          let eventType = 'message';
          let eventData = '';
          let eventId = null;

          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventType = line.substring(6).trim();
            } else if (line.startsWith('data:')) {
              eventData += (eventData ? '\n' : '') + line.substring(5).trim();
            } else if (line.startsWith('id:')) {
              eventId = line.substring(3).trim();
            } else if (line === '') {
              // Empty line = end of event
              if (eventData) {
                if (eventId) lastEventId = eventId;
                try {
                  const data = JSON.parse(eventData);
                  if (dispatchUpdate(data)) return;
                } catch (e) {
                  console.error('[api] Failed to parse SSE event data:', e);
                }
              }
              eventType = 'message';
              eventData = '';
              eventId = null;
            }
          }
        }
        // Stream ended without a terminal state. Reconnect (server may
        // have idled out the connection; the poll backstop or the next
        // SSE event will recover).
        if (!terminalReached && !controller.signal.aborted) {
          scheduleReconnect('stream-end');
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        const cleanClose = e.name === 'TypeError' &&
            typeof e.message === 'string' && e.message.includes('Error in input stream');
        if (cleanClose) {
          console.debug('[api] SSE stream closed cleanly (server-initiated)');
          // Even a clean close can be premature for a still-running saga.
          // Reconnect with Last-Event-ID resumption; the server will
          // close again immediately if there's nothing more to send.
          if (!terminalReached && !controller.signal.aborted) {
            scheduleReconnect('clean-close');
          }
          return;
        }
        console.error('[api] SSE error:', e);
        // Issue #306 — don't surface to onError unless we've exhausted
        // reasonable reconnect attempts. A transient drop should self-heal.
        if (!terminalReached && !controller.signal.aborted) {
          scheduleReconnect('error');
        } else if (onError) {
          onError(e);
        }
      }
    };

    const scheduleReconnect = (reason) => {
      if (terminalReached || controller.signal.aborted) return;
      // Copilot review on PR #305, comment 3344267534 — single-flight
      // reconnect scheduling. If a timer is already pending, don't
      // queue a second one (otherwise we'd open multiple concurrent
      // streams on the next fire). The active timer is cleared inside
      // its own callback before invoking connect(), and on successful
      // connect (see the reset block above) so retries from a new
      // failure can schedule again.
      if (reconnectTimer !== null) {
        console.debug(`[api] SSE reconnect already pending, skipping duplicate schedule (reason=${reason})`);
        return;
      }
      reconnectAttempts++;
      const delay = Math.min(500 * Math.pow(2, Math.min(reconnectAttempts, 4)), RECONNECT_MAX_DELAY_MS);
      console.debug(`[api] SSE reconnect scheduled in ${delay}ms (attempt #${reconnectAttempts}, reason=${reason})`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!terminalReached && !controller.signal.aborted) connect();
      }, delay);
    };

    // Polling backstop — fires when SSE has been silent for POLL_INTERVAL_MS.
    // For a healthy stream this never makes a request (lastUpdateAt is
    // updated on every SSE event). For a dropped stream this surfaces
    // the terminal state within ~5s independently of SSE reconnect.
    //
    // Copilot review on PR #305, comment 3344267581 — `pollInFlight`
    // guards against overlapping fetches when a request stalls past the
    // interval boundary (network hang, slow TLS handshake, etc.). At
    // most one poll runs at a time.
    const startPollBackstop = () => {
      if (!pollUrl) return;
      pollTimer = setInterval(async () => {
        if (terminalReached || controller.signal.aborted) {
          clearInterval(pollTimer);
          pollTimer = null;
          return;
        }
        if (Date.now() - lastUpdateAt < POLL_INTERVAL_MS) return;
        if (pollInFlight) return;
        pollInFlight = true;
        try {
          const headers = {};
          const path = new URL(pollUrl, typeof window !== 'undefined' ? window.location.origin : 'http://localhost').pathname;
          if (this._requiresNip98Auth(path, 'GET') && this._nostrPublicKey && typeof NostrUtils !== 'undefined') {
            const authUrl = `${this.authBaseUrl}${path}`;
            headers['Authorization'] = await NostrUtils.createNip98AuthHeader(
              authUrl, 'GET', this._nostrPublicKey, this._nostrPrivateKey, null
            );
          }
          const resp = await fetch(pollUrl, {
            method: 'GET',
            headers,
            signal: controller.signal,
          });
          if (!resp.ok) return;
          const data = await resp.json();
          console.debug('[api] SSE poll-backstop fetched status', { status: data.status });
          dispatchUpdate(data);
        } catch (_e) { /* polling is best-effort */ }
        finally { pollInFlight = false; }
      }, POLL_INTERVAL_MS);
    };

    // Clean up the poll timer + any pending reconnect when the
    // controller aborts (terminal state, page unload, caller close()).
    controller.signal.addEventListener('abort', () => {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    });

    // Start connection + backstop in parallel.
    connect();
    startPollBackstop();

    return { close: () => controller.abort() };
  }

  /**
   * Subscribe to real-time atomic purchase status updates via SSE with NIP-98 auth.
   * @param {string} purchaseId - Purchase ID
   * @param {function} onUpdate - Callback for status updates
   * @param {function} [onError] - Callback for errors
   * @returns {{ close: function }} Controller with close() method
   */
  subscribeAtomicPurchaseEvents(purchaseId, onUpdate, onError = null) {
    const url = `${this.baseUrl}/api/v1/atomic-purchase/${purchaseId}/events`;
    return this._subscribeSSE(url, onUpdate, onError,
      ['COMPLETED', 'REFUNDED', 'CANCELLED', 'FAILED', 'EXPIRED']);
  }

  /**
   * Subscribe to real-time atomic send status updates via SSE with NIP-98 auth.
   * @param {string} sendId - Send ID
   * @param {function} onUpdate - Callback for status updates
   * @param {function} [onError] - Callback for errors
   * @returns {{ close: function }} Controller with close() method
   */
  subscribeAtomicSendEvents(sendId, onUpdate, onError = null) {
    const url = `${this.baseUrl}/api/v1/atomic-send/${sendId}/events`;
    return this._subscribeSSE(url, onUpdate, onError,
      ['COMPLETED', 'RECLAIMED', 'CANCELLED', 'FAILED', 'EXPIRED']);
  }
}

/**
 * Generate an idempotency key for API requests.
 * Uses token fingerprint (if available) combined with a random component
 * to ensure unique keys while allowing retry detection.
 *
 * @param {string} [tokenFingerprint] - Optional token fingerprint for correlation
 * @returns {string} Idempotency key (format: fp_<fingerprint>_<random> or idem_<timestamp>_<random>)
 */
function generateIdempotencyKey(tokenFingerprint = null) {
  // Generate random component using crypto if available, else Math.random
  let random;
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    random = crypto.randomUUID().replace(/-/g, '').substring(0, 16);
  } else if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    random = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  } else {
    random = Math.random().toString(36).substring(2, 18);
  }

  if (tokenFingerprint) {
    // Use first 16 chars of fingerprint + random
    const fpPrefix = tokenFingerprint.substring(0, 16);
    return `fp_${fpPrefix}_${random}`;
  }

  // Fallback: timestamp + random
  const timestamp = Date.now().toString(36);
  return `idem_${timestamp}_${random}`;
}

const api = new GatewayAPI();

// Expose api globally for integrations that need window.api
if (typeof window !== 'undefined') {
  window.api = api;
}

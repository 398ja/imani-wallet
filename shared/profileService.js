/**
 * Profile Service initialization for Imani App
 *
 * This module provides a singleton ProfileService instance configured
 * for the Imani app environment.
 *
 * Feature flag: localStorage.imani_use_profile_service
 *
 * Backend API Integration:
 * When nostrApi is available, profile lookups will use the backend API
 * which provides cached profiles from nostrdb and full-text search.
 */

// Import will be loaded dynamically to avoid build issues during migration
let ProfileService = null;
let ImaniApiAdapter = null;
let LocalFollowAdapter = null;
let IndexedDBCacheStore = null;
const LOCAL_FOLLOWS_KEY = 'imani_favorites';

// Singleton instance
let profileServiceInstance = null;
let initPromise = null;

/**
 * Check if the new profile service should be used
 * @returns {boolean}
 */
export function isProfileServiceEnabled() {
  try {
    return localStorage.getItem('imani_use_profile_service') !== 'false';
  } catch {
    return true;
  }
}

/**
 * Enable the profile service feature flag
 */
export function enableProfileService() {
  try {
    localStorage.setItem('imani_use_profile_service', 'true');
    console.log('[ProfileService] Enabled');
  } catch (e) {
    console.error('[ProfileService] Failed to enable:', e);
  }
}

/**
 * Disable the profile service feature flag
 */
export function disableProfileService() {
  try {
    localStorage.removeItem('imani_use_profile_service');
    console.log('[ProfileService] Disabled');
  } catch (e) {
    console.error('[ProfileService] Failed to disable:', e);
  }
}

/**
 * Load the profile-service library dynamically
 * @returns {Promise<boolean>} true if loaded successfully
 */
async function loadProfileServiceLibrary() {
  if (ProfileService) {
    return true;
  }

  // Check if already loaded as global (IIFE bundle)
  if (typeof window !== 'undefined' && window.ImaniProfileService) {
    const lib = window.ImaniProfileService;
    ProfileService = lib.ProfileService;
    ImaniApiAdapter = lib.ImaniApiAdapter;
    LocalFollowAdapter = lib.LocalFollowAdapter;
    IndexedDBCacheStore = lib.IndexedDBCacheStore;
    return true;
  }

  // Load the script dynamically
  try {
    await new Promise((resolve, reject) => {
      // Check if script already exists
      if (document.querySelector('script[src*="profile-service.min.js"]')) {
        // Wait for it to load
        const checkLoaded = () => {
          if (window.ImaniProfileService) {
            resolve();
          } else {
            setTimeout(checkLoaded, 50);
          }
        };
        checkLoaded();
        return;
      }

      const script = document.createElement('script');
      script.src = '/lib/profile-service.min.js?v=6';
      script.onload = () => {
        if (window.ImaniProfileService) {
          resolve();
        } else {
          reject(new Error('Library loaded but global not found'));
        }
      };
      script.onerror = () => reject(new Error('Failed to load script'));
      document.head.appendChild(script);
    });

    const lib = window.ImaniProfileService;
    ProfileService = lib.ProfileService;
    ImaniApiAdapter = lib.ImaniApiAdapter;
    LocalFollowAdapter = lib.LocalFollowAdapter;
    IndexedDBCacheStore = lib.IndexedDBCacheStore;
    return true;
  } catch (e) {
    console.error('[ProfileService] Failed to load library:', e);
    return false;
  }
}

/**
 * Get the base URL for the Imani API
 * @returns {string}
 */
function getApiBaseUrl() {
  // Use the same base URL as the existing API, with /api/v1 prefix
  // The ImaniApiAdapter uses paths like /profiles/{pubkey}, so the base must include /api/v1
  if (typeof window !== 'undefined' && window.location) {
    return window.location.origin + '/api/v1';
  }
  return '/api/v1';
}

/**
 * Initialize and get the ProfileService instance
 * @returns {Promise<Object|null>} ProfileService instance or null if disabled/failed
 */
export async function getProfileService() {
  // Check feature flag
  if (!isProfileServiceEnabled()) {
    return null;
  }

  // Return existing instance
  if (profileServiceInstance) {
    return profileServiceInstance;
  }

  // Avoid multiple simultaneous initializations
  if (initPromise) {
    return initPromise;
  }

  initPromise = initializeProfileService();
  return initPromise;
}

function readLocalFollows() {
  const raw = typeof scopedGet === 'function'
    ? scopedGet(LOCAL_FOLLOWS_KEY)
    : localStorage.getItem(LOCAL_FOLLOWS_KEY);
  return JSON.parse(raw || '[]');
}

function writeLocalFollows(favorites) {
  const payload = JSON.stringify(Array.isArray(favorites) ? favorites : []);
  if (typeof scopedSet === 'function') {
    scopedSet(LOCAL_FOLLOWS_KEY, payload);
    return;
  }
  localStorage.setItem(LOCAL_FOLLOWS_KEY, payload);
}

/**
 * Migrate existing localStorage favorites to IndexedDB via the profile service
 * @param {Object} service - ProfileService instance
 */
async function migrateLocalStorageFavorites(service) {
  const MIGRATION_KEY = 'imani_favorites_migrated';

  try {
    // Check if already migrated
    const _get = typeof scopedGet === 'function' ? scopedGet : (k) => localStorage.getItem(k);
    const _set = typeof scopedSet === 'function' ? scopedSet : (k, v) => localStorage.setItem(k, v);

    if (_get(MIGRATION_KEY) === 'true') {
      return;
    }

    // Get existing favorites from localStorage (scoped if available)
    const stored = _get('imani_favorites');
    if (!stored) {
      // No favorites to migrate, mark as done
      _set(MIGRATION_KEY, 'true');
      return;
    }

    const favorites = JSON.parse(stored);
    if (!Array.isArray(favorites) || favorites.length === 0) {
      _set(MIGRATION_KEY, 'true');
      return;
    }

    // Migrate each favorite to the profile service
    const existingFollows = await service.listFollows();
    let migratedCount = 0;

    for (const pubkey of favorites) {
      if (!existingFollows.includes(pubkey)) {
        await service.follow(pubkey);
        migratedCount++;
      }
    }

    // Mark migration as complete
    _set(MIGRATION_KEY, 'true');
    console.log(`[ProfileService] Migrated ${migratedCount} favorites from localStorage to IndexedDB`);
  } catch (e) {
    console.error('[ProfileService] Failed to migrate favorites:', e);
    // Don't block initialization on migration failure
  }
}

/**
 * Internal initialization function
 */
async function initializeProfileService() {
  try {
    // Load the library
    const loaded = await loadProfileServiceLibrary();
    if (!loaded) {
      console.warn('[ProfileService] Library not available, falling back to legacy API');
      return null;
    }

    const baseUrl = getApiBaseUrl();

    // Create the Imani API adapter (combines lookup and directory)
    const apiAdapter = new ImaniApiAdapter({
      baseUrl,
      // Auth token is unused (NIP-98 is used instead); return null
      getAuthToken: () => null,
    });

    // Determine scoped DB names
    const userId = typeof getCurrentUserId === 'function' ? getCurrentUserId() : null;
    const followsDbName = userId && typeof userDbName === 'function'
      ? userDbName('imani-follows', userId)
      : 'imani-follows';
    const cacheDbName = userId && typeof userDbName === 'function'
      ? userDbName('imani-profile-cache', userId)
      : 'imani-profile-cache';

    // Create the follow adapter (IndexedDB-based for offline support)
    const followAdapter = new LocalFollowAdapter({
      dbName: followsDbName,
      storeName: 'follows',
    });

    // Create the cache (IndexedDB for persistence)
    const cache = new IndexedDBCacheStore({
      name: cacheDbName,
      defaultTtlMs: 24 * 60 * 60 * 1000, // 24 hours (matches existing TTL)
      maxSize: 100, // matches existing limit
    });

    // Create the ProfileService instance
    profileServiceInstance = new ProfileService({
      directoryAdapter: apiAdapter,
      lookupAdapter: apiAdapter,
      followAdapter,
      cache,
      onEvent: (event) => {
        // Log events for debugging during migration
        if (localStorage.getItem('imani_profile_service_debug') === 'true') {
          console.log('[ProfileService Event]', event.type, event);
        }
      },
      defaultSearchLimit: 20,
      optimisticUpdates: true,
    });

    // Migrate existing localStorage favorites to IndexedDB
    await migrateLocalStorageFavorites(profileServiceInstance);

    console.log('[ProfileService] Initialized successfully');
    return profileServiceInstance;
  } catch (e) {
    console.error('[ProfileService] Initialization failed:', e);
    initPromise = null;
    return null;
  }
}

/**
 * Clear the profile service instance (for testing/reset)
 */
export function resetProfileService() {
  profileServiceInstance = null;
  initPromise = null;
}

/**
 * Check if nostrApi is available
 * @returns {boolean}
 */
function isNostrApiAvailable() {
  return typeof nostrApi !== 'undefined' &&
    typeof nostrApi.canAuthenticateRequests === 'function' &&
    nostrApi.canAuthenticateRequests();
}

/**
 * Wrapper for getProfile that falls back to legacy API
 * @param {string} pubkey - Hex pubkey
 * @param {Object} legacyApi - Legacy GatewayAPI instance
 * @param {boolean} skipCache - Skip cache and fetch fresh
 * @returns {Promise<Object|null>}
 */
export async function getProfile(pubkey, legacyApi, skipCache = false) {
  // Try nostrApi first (fast path via nostrdb)
  if (isNostrApiAvailable()) {
    try {
      const profile = await nostrApi.getProfile(pubkey, skipCache);
      if (profile) {
        console.log('[ProfileService] Profile fetched via nostrApi');
        return {
          pubkey: profile.pubkey,
          name: profile.name,
          display_name: profile.displayName,
          about: profile.about,
          picture: profile.picture,
          nip05: profile.nip05,
          lud16: profile.lud16,
          merchant: profile.merchant,
          banner: profile.banner,
          website: profile.website
        };
      }
    } catch (e) {
      console.warn('[ProfileService] nostrApi getProfile failed:', e.message);
    }
  }

  // Try ProfileService if enabled
  const service = await getProfileService();

  if (service) {
    try {
      // Clear cache if skipCache is true
      if (skipCache) {
        await service.clearCache();
      }
      return await service.getProfile(pubkey);
    } catch (e) {
      console.error('[ProfileService] getProfile failed, falling back:', e);
    }
  }

  // Fallback to legacy API
  return legacyApi.getProfile(pubkey, skipCache);
}

/**
 * Wrapper for getMerchantProfile that falls back to legacy API
 * @param {string} pubkey - Hex pubkey
 * @param {Object} legacyApi - Legacy GatewayAPI instance
 * @param {boolean} skipCache - Skip cache and fetch fresh
 * @returns {Promise<Object|null>}
 */
export async function getMerchantProfile(pubkey, legacyApi, skipCache = false) {
  // When the caller explicitly asked for fresh data, bypass the profile-service
  // layer — it has its own internal cache that does not honour skipCache, so
  // a stale `active: true` entry could mask a recently-deactivated merchant
  // (spec 027 follow-up). The legacy path's `_getMerchantProfileLegacy` does
  // respect skipCache and goes straight to the gateway.
  if (skipCache) {
    return legacyApi.getMerchantProfile(pubkey, true);
  }

  const service = await getProfileService();

  if (service) {
    try {
      const result = await service.getMerchantProfile(pubkey);
      // If profile service found a profile, return it; otherwise fall through to legacy
      // which checks the local cache (merchant data saved locally but not yet on relay)
      if (result) return result;
    } catch (e) {
      // Expected + handled: the package lookup path uses static headers, but the
      // merchant endpoint requires per-request NIP-98 auth, so a fetch/CORS
      // failure here is normal — the legacy NIP-98 path below resolves it. Log
      // quietly (debug) so it doesn't surface as a red console error.
      console.debug('[ProfileService] package merchant lookup unavailable, using legacy NIP-98 path:', e?.message || e);
    }
  }

  // Fallback to legacy API (checks local cache first)
  return legacyApi.getMerchantProfile(pubkey, skipCache);
}

/**
 * Wrapper for resolving NIP-05 identifiers
 * @param {string} nip05 - NIP-05 identifier (user@domain.com)
 * @param {Object} legacyResolver - Legacy resolver function
 * @returns {Promise<{pubkey: string, relays?: string[]}|null>}
 */
export async function resolveNip05(nip05, legacyResolver) {
  const service = await getProfileService();

  if (service) {
    try {
      return await service.resolveNip05(nip05);
    } catch (e) {
      console.error('[ProfileService] resolveNip05 failed, falling back:', e);
    }
  }

  // Fallback to legacy resolver
  if (legacyResolver) {
    const pubkey = await legacyResolver(nip05);
    return pubkey ? { pubkey } : null;
  }

  return null;
}

/**
 * Wrapper for looking up by identifier (pubkey, npub, or NIP-05)
 * @param {string} identifier - Pubkey, npub, or NIP-05
 * @param {Object} legacyApi - Legacy GatewayAPI instance
 * @returns {Promise<Object|null>}
 */
export async function lookupByIdentifier(identifier, legacyApi) {
  const service = await getProfileService();

  if (service) {
    try {
      return await service.lookupByIdentifier(identifier);
    } catch (e) {
      console.error('[ProfileService] lookupByIdentifier failed, falling back:', e);
    }
  }

  // Fallback: determine type and use legacy
  if (identifier.includes('@')) {
    // NIP-05
    const resolved = await resolveNip05(identifier, null);
    if (resolved) {
      return legacyApi.getProfile(resolved.pubkey);
    }
    return null;
  }

  // Pubkey or npub
  let pubkey = identifier;
  if (identifier.startsWith('npub1')) {
    // Decode npub using NostrUtils if available
    if (typeof window !== 'undefined' && window.NostrUtils) {
      pubkey = window.NostrUtils.decodeNpub(identifier);
    }
  }

  return legacyApi.getProfile(pubkey);
}

/**
 * Check if following a pubkey
 * @param {string} pubkey - Hex pubkey
 * @returns {Promise<boolean>}
 */
export async function isFollowing(pubkey) {
  const service = await getProfileService();

  if (service) {
    try {
      return await service.isFollowing(pubkey);
    } catch (e) {
      console.error('[ProfileService] isFollowing failed:', e);
    }
  }

  // Fallback to localStorage favorites
  try {
    return readLocalFollows().includes(pubkey);
  } catch {
    return false;
  }
}

/**
 * Follow a pubkey
 * @param {string} pubkey - Hex pubkey
 * @returns {Promise<void>}
 */
export async function follow(pubkey) {
  const service = await getProfileService();

  if (service) {
    try {
      await service.follow(pubkey);
      return;
    } catch (e) {
      console.error('[ProfileService] follow failed:', e);
    }
  }

  // Fallback to localStorage favorites
  try {
    const favorites = readLocalFollows();
    if (!favorites.includes(pubkey)) {
      favorites.push(pubkey);
      writeLocalFollows(favorites);
    }
  } catch (e) {
    console.error('[ProfileService] localStorage follow failed:', e);
  }
}

/**
 * Unfollow a pubkey
 * @param {string} pubkey - Hex pubkey
 * @returns {Promise<void>}
 */
export async function unfollow(pubkey) {
  const service = await getProfileService();

  if (service) {
    try {
      await service.unfollow(pubkey);
      return;
    } catch (e) {
      console.error('[ProfileService] unfollow failed:', e);
    }
  }

  // Fallback to localStorage favorites
  try {
    let favorites = readLocalFollows();
    favorites = favorites.filter(p => p !== pubkey);
    writeLocalFollows(favorites);
  } catch (e) {
    console.error('[ProfileService] localStorage unfollow failed:', e);
  }
}

/**
 * Toggle follow status
 * @param {string} pubkey - Hex pubkey
 * @returns {Promise<boolean>} true if now following, false if unfollowed
 */
export async function toggleFollow(pubkey) {
  const service = await getProfileService();

  if (service) {
    try {
      return await service.toggleFollow(pubkey);
    } catch (e) {
      console.error('[ProfileService] toggleFollow failed:', e);
    }
  }

  // Fallback
  const following = await isFollowing(pubkey);
  if (following) {
    await unfollow(pubkey);
    return false;
  } else {
    await follow(pubkey);
    return true;
  }
}

/**
 * Get list of followed pubkeys
 * @returns {Promise<string[]>}
 */
export async function listFollows() {
  const service = await getProfileService();

  if (service) {
    try {
      return await service.listFollows();
    } catch (e) {
      console.error('[ProfileService] listFollows failed:', e);
    }
  }

  // Fallback to localStorage favorites
  try {
    return readLocalFollows();
  } catch {
    return [];
  }
}

/**
 * Search profiles using backend API
 * Uses nostrdb full-text search for fast results
 *
 * @param {string} query - Search query
 * @param {number} limit - Maximum results (default: 20)
 * @returns {Promise<Array>} Matching profiles
 */
export async function searchProfiles(query, limit = 20) {
  // Try nostrApi first (fast full-text search via nostrdb)
  if (isNostrApiAvailable()) {
    try {
      const profiles = await nostrApi.searchProfiles(query, limit);
      console.log(`[ProfileService] Search returned ${profiles.length} profiles via nostrApi`);
      return profiles.map(p => ({
        pubkey: p.pubkey,
        name: p.name,
        display_name: p.displayName,
        about: p.about,
        picture: p.picture,
        nip05: p.nip05,
        lud16: p.lud16
      }));
    } catch (e) {
      console.warn('[ProfileService] nostrApi searchProfiles failed:', e.message);
    }
  }

  // Try ProfileService if enabled
  const service = await getProfileService();

  if (service && service.searchProfiles) {
    try {
      return await service.searchProfiles(query, limit);
    } catch (e) {
      console.error('[ProfileService] searchProfiles failed:', e);
    }
  }

  // No search available without API
  console.warn('[ProfileService] Profile search requires nostrApi');
  return [];
}

// ---- spec 044: local NIP-02 follow list + background sync ------------------
// Bridge glue (Constitution IV): wiring only. The data model, NIP-02 sync, and
// reconcile live in @imani/profile-service; this supplies the host primitives
// (relay query / signer / publisher / merchant lookup) and the trigger cadence.

let _followSyncTriggers = null;

/** Followed CUSTOMERS subset (spec 044) — local, no network. */
export async function listCustomers() {
  const service = await getProfileService();
  if (service && service.listCustomers) {
    try { return await service.listCustomers(); } catch (e) { console.error('[ProfileService] listCustomers failed:', e); }
  }
  // Fallback (service disabled): all follows as customers (no discriminator).
  try { return readLocalFollows().map((pubkey) => ({ pubkey, merchant: 'unknown' })); } catch { return []; }
}

/** Followed MERCHANTS subset (spec 044) — local, no network. */
export async function listMerchants() {
  const service = await getProfileService();
  if (service && service.listMerchants) {
    try { return await service.listMerchants(); } catch (e) { console.error('[ProfileService] listMerchants failed:', e); }
  }
  return [];
}

/**
 * Persist a denormalized kind-0 profile snapshot on a followed entry (spec 044
 * #2), so the followed list renders from the local store without a server hit.
 */
export async function setFollowProfile(pubkey, snapshot, updatedAt) {
  const service = await getProfileService();
  if (service && service.setFollowProfile) {
    try { await service.setFollowProfile(pubkey, snapshot, updatedAt); } catch (e) { console.error('[ProfileService] setFollowProfile failed:', e); }
  }
}

/**
 * Map a kind-0 event's content to a `{displayName, picture, nip05, merchant}`
 * snapshot. Returns null on unparseable content. The `merchant` boolean reflects
 * the canonical NIP-24-style merchant identity flag the merchant onboarding flow
 * sets on kind-0; we capture it here so callers can promote the follow-list
 * discriminator without a separate `/profiles/{pk}/merchant` round trip.
 */
export function _profileSnapshotFromKind0(ev) {
  if (!ev) return null;
  try {
    const c = typeof ev.content === 'string' ? JSON.parse(ev.content) : (ev.content || {});
    return {
      displayName: c.display_name || c.name || null,
      picture: c.picture || null,
      nip05: c.nip05 || null,
      merchant: c.merchant === true,
    };
  } catch { return null; }
}

/**
 * Persist profile snapshots for a batch of kind-0 events onto their follow
 * entries (spec 044 #2/#3). Only writes entries that are actually followed
 * (setFollowProfile is a no-op for non-follows). Best-effort, fire-and-forget safe.
 *
 * Also promotes the merchant discriminator when kind-0 carries the canonical
 * `merchant: true` flag. This makes every list render a self-healing
 * reclassification pass for merchants the `isConfiguredMerchant`-based
 * `refreshFollowMerchants` would miss (inactive NIP-78 profile, unknown
 * currency, 404). Never downgrades — only promotes — because a missing kind-0
 * `merchant` field doesn't disprove merchanthood; that decision belongs to the
 * authoritative `refreshFollowMerchants` cross-check. Dispatches one
 * `follow-list-changed` if any entry was promoted so any open list re-renders.
 */
export async function persistFollowProfilesFromEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return;
  const now = Date.now();
  const seen = new Set();
  const service = await getProfileService();
  let promoted = 0;
  await Promise.allSettled(events.map(async (ev) => {
    if (!ev || !ev.pubkey || seen.has(ev.pubkey)) return;
    seen.add(ev.pubkey);
    const snap = _profileSnapshotFromKind0(ev);
    if (!snap) return;
    await setFollowProfile(ev.pubkey, snap, now);
    if (snap.merchant === true && service && typeof service.getFollowEntry === 'function' && typeof service.setFollowMerchant === 'function') {
      try {
        const entry = await service.getFollowEntry(ev.pubkey);
        if (entry && entry.merchant !== 'merchant') {
          await service.setFollowMerchant(ev.pubkey, 'merchant', now);
          promoted++;
        }
      } catch { /* best-effort */ }
    }
  }));
  if (promoted > 0 && typeof window !== 'undefined') {
    try { window.dispatchEvent(new Event('follow-list-changed')); } catch { /* */ }
  }
}

/** Build the relay-backed RemoteFollowSource from host primitives. */
function _buildNostrFollowSource(identity) {
  const lib = (typeof window !== 'undefined') ? window.ImaniProfileService : null;
  if (!lib || typeof lib.NostrFollowSource !== 'function') return null;
  if (!isNostrApiAvailable() || typeof NostrUtils === 'undefined') return null;

  const selfPubkey = identity && (identity.publicKey || identity.pubkey);
  const privKey = identity && (identity.privateKey
    || (identity.nsec && typeof NostrUtils.decodeNsec === 'function' ? NostrUtils.decodeNsec(identity.nsec) : null));
  if (!selfPubkey || !privKey) return null;

  const relayUrl = (typeof GatewayConfig !== 'undefined' && GatewayConfig && GatewayConfig.relay_url) || null;
  const relays = (typeof relayUrl === 'string' && relayUrl.startsWith('wss://')) ? [relayUrl] : [];

  try {
    return new lib.NostrFollowSource({
      selfPubkey,
      relays,
      query: (filter) => nostrApi.queryEvents(filter),
      sign: (unsigned) => NostrUtils.signEventWithBunkerOrLocal({ ...unsigned, pubkey: selfPubkey }, privKey),
      publishEvent: (signed) => NostrUtils.publishEvent(signed),
      verify: (typeof NostrUtils.verifyEvent === 'function') ? ((ev) => NostrUtils.verifyEvent(ev)) : undefined,
    });
  } catch (e) {
    console.warn('[ProfileService] NostrFollowSource build failed:', e && e.message);
    return null;
  }
}

/**
 * Start background follow sync after login (spec 044). Hydrates the local store
 * from the relay, kicks the merchant-discriminator refresh (US3), and installs
 * the visibility/online/periodic triggers. `identity` carries the signer.
 */
export async function startFollowSync(opts = {}) {
  const { identity, onChange } = opts;
  const service = await getProfileService();
  if (!service || !service.startFollowSync) return;
  const remote = _buildNostrFollowSource(identity);
  if (!remote) { console.warn('[ProfileService] follow sync not started (missing relay/signer)'); return; }
  try {
    await service.startFollowSync(remote, { onChange });
    refreshFollowMerchants().catch(() => {});
    _installFollowSyncTriggers();
  } catch (e) {
    console.warn('[ProfileService] startFollowSync failed:', e && e.message);
  }
}

/** Force one reconcile pass (spec 044). */
export async function syncFollowsNow() {
  const service = await getProfileService();
  if (service && service.syncFollowsNow) { try { return await service.syncFollowsNow(); } catch { /* */ } }
  return null;
}

/**
 * Stop background sync (spec 044). Removes triggers + drops the coordinator;
 * does NOT clear the durable local follow cache (FR-020 — ordinary logout
 * preserves the same user's offline follows).
 */
export function stopFollowSync() {
  _removeFollowSyncTriggers();
  getProfileService().then((s) => { if (s && s.stopFollowSync) s.stopFollowSync(); }).catch(() => {});
}

/**
 * US3: resolve the merchant discriminator for unknown/stale follows. Two-stage:
 *   1. Batched kind-0 fetch — if `content.merchant === true` (canonical NIP-24
 *      merchant identity flag set by merchant onboarding), classify as merchant
 *      immediately. This is the common case and avoids an N-call burst against
 *      `/api/v1/profiles/{pk}/merchant`.
 *   2. For entries kind-0 didn't promote, fall through to the existing
 *      `api.getMerchantProfile` + `isConfiguredMerchant` cross-check. That
 *      check is the right gate for the Buy/Send flows (it requires NIP-78
 *      active + known-priced currency) but is *too strict* for the contact-
 *      list discriminator on its own — a merchant whose NIP-78 profile is
 *      inactive, missing, or has an unknown currency would be misclassified
 *      as a customer and leak into the Contacts tab. Kind-0 first fixes that.
 *
 * Fail-open: a transient lookup error leaves the entry unknown so it's
 * retried on the next pass. Dispatches one `follow-list-changed` if any entry
 * was promoted to 'merchant' so any open list re-renders without a manual
 * refresh.
 */
export async function refreshFollowMerchants() {
  const service = await getProfileService();
  if (!service || !service.listFollowEntries || !service.setFollowMerchant) return;
  const lib = (typeof window !== 'undefined') ? window.ImaniProfileService : null;
  const api = (typeof window !== 'undefined') ? window.api : null;
  if (!lib || typeof lib.isConfiguredMerchant !== 'function' || !api || typeof api.getMerchantProfile !== 'function') return;

  const TTL = 24 * 60 * 60 * 1000;
  const now = Date.now();
  let entries = [];
  try { entries = await service.listFollowEntries(); } catch { return; }
  if (entries.length === 0) return;

  // Batched kind-0 fast path — query for ALL entries, not just stale ones.
  // A previously-wrong classification (e.g. an entry the old isConfiguredMerchant
  // path flagged as 'customer' for an inactive NIP-78 merchant) has a recent
  // merchantCheckedAt, so a stale-only filter would skip it for up to 24h and
  // leak the merchant into Contacts the whole time. The kind-0 query is one
  // batched WS round trip — cheap enough to run on every refresh so
  // misclassifications heal on the next page load instead of waiting on TTL.
  const kind0MerchantPubkeys = new Set();
  if (isNostrApiAvailable()) {
    try {
      const authors = entries.map((e) => e.pubkey);
      const evs = await nostrApi.queryEvents({ kinds: [0], authors, limit: authors.length });
      for (const ev of evs || []) {
        if (!ev || !ev.pubkey) continue;
        const snap = _profileSnapshotFromKind0(ev);
        if (snap && snap.merchant === true) kind0MerchantPubkeys.add(ev.pubkey);
      }
    } catch { /* fall through to per-pubkey path */ }
  }

  let promoted = 0;

  // 1. Apply kind-0 promotions first. Runs against ALL entries — repairs any
  //    entry kind-0 says is a merchant, regardless of current flag or TTL.
  await Promise.allSettled(entries.map(async (e) => {
    if (!kind0MerchantPubkeys.has(e.pubkey)) return;
    if (e.merchant === 'merchant') return;
    try {
      await service.setFollowMerchant(e.pubkey, 'merchant', now);
      promoted++;
    } catch { /* */ }
  }));

  // 2. Stale fallback path — entries kind-0 didn't promote AND that are
  //    actually due for a recheck go through the existing per-pubkey
  //    isConfiguredMerchant cross-check.
  const stale = entries.filter((e) =>
    !kind0MerchantPubkeys.has(e.pubkey) &&
    (e.merchant === 'unknown' || !e.merchantCheckedAt || (now - e.merchantCheckedAt) > TTL)
  );
  await Promise.allSettled(stale.map(async (e) => {
    let flag;
    try {
      const mp = await api.getMerchantProfile(e.pubkey); // cache-allowed
      flag = lib.isConfiguredMerchant(mp) ? 'merchant' : 'customer';
    } catch (err) {
      if (err && err.status === 404) flag = 'customer'; // definitively not a merchant
      else return; // transient — leave unknown, retried next pass
    }
    try {
      await service.setFollowMerchant(e.pubkey, flag, now);
      if (flag === 'merchant' && e.merchant !== 'merchant') promoted++;
    } catch { /* */ }
  }));

  if (promoted > 0 && typeof window !== 'undefined') {
    try { window.dispatchEvent(new Event('follow-list-changed')); } catch { /* */ }
  }
}

function _installFollowSyncTriggers() {
  if (_followSyncTriggers || typeof window === 'undefined') return;
  const onVisible = () => {
    if (document.visibilityState === 'visible') { syncFollowsNow(); refreshFollowMerchants().catch(() => {}); }
  };
  const onOnline = () => syncFollowsNow();
  const timer = setInterval(() => syncFollowsNow(), 5 * 60 * 1000);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  _followSyncTriggers = { onVisible, onOnline, timer };
}

function _removeFollowSyncTriggers() {
  if (!_followSyncTriggers || typeof window === 'undefined') return;
  document.removeEventListener('visibilitychange', _followSyncTriggers.onVisible);
  window.removeEventListener('online', _followSyncTriggers.onOnline);
  clearInterval(_followSyncTriggers.timer);
  _followSyncTriggers = null;
}

// Export for debugging in console
if (typeof window !== 'undefined') {
  window.imaniProfileService = {
    isEnabled: isProfileServiceEnabled,
    enable: enableProfileService,
    disable: disableProfileService,
    reset: resetProfileService,
    getInstance: getProfileService,
    searchProfiles: searchProfiles,
    listCustomers,
    listMerchants,
    startFollowSync,
    stopFollowSync,
    syncFollowsNow,
    refreshFollowMerchants,
    setFollowProfile,
    persistFollowProfilesFromEvents,
  };
}

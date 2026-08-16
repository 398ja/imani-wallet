/**
 * Global gateway configuration loaded from /api/v1/config.
 *
 * Source of truth for environment-specific domain names (relay URL,
 * lightning domain, NIP-05 domain). The backend serves these from
 * environment variables — the frontend NEVER hardcodes them.
 *
 * Usage:
 *   await GatewayConfig.init()           // ensure loaded (call early on every page)
 *   await GatewayConfig.getRelayUrl()    // async (preferred — always correct)
 *   GatewayConfig.relayUrl               // sync (returns '' until init resolves)
 *   GatewayConfig.whenReady(cb)          // subscribe to first load
 *
 * IMPORTANT:
 *  - Sync getters return an empty string until the async /api/v1/config fetch
 *    resolves. Never fall back to a hardcoded domain — the app may be deployed
 *    on any host (e.g. staging.398ja.xyz).
 *  - Never capture `GatewayConfig.relayUrl` into a top-level `const`; read it
 *    lazily or register via whenReady().
 */
const GatewayConfig = (function () {
  let _config = null;
  let _promise = null;
  const _readyCallbacks = [];

  // Empty defaults — real values come from /api/v1/config (env-backed on the
  // backend). Never hardcode a domain here.
  const EMPTY = {
    relay_url: '',
    lightning_domain: '',
    nip05_domain: '',
    default_domain: '',
    cashback_origins: [],
    cashback_code_entry_enabled: false,
    diagnostic_export_full_enabled: false,
    // Spec 037 — Blossom server URL for profile avatar / banner uploads.
    // Sourced from BLOSSOM_SERVER_URL env var on the gateway. Empty default
    // here so an unconfigured deployment fails-loud (the wallet adapter
    // throws when reading the getter), per server-config.contract.md.
    blossom_server_url: '',
    // Spec 041 — client-side voucher minting. Three optional fields the
    // gateway surfaces on /api/v1/config; all default to safe-off so a
    // wallet built before the gateway side ships sees the legacy
    // custodial path. Once the gateway sets client_side_mint_enabled true
    // AND mint_url to the deployment's cashu mint URL, the wallet's
    // ClientMintIntegration takes over (see shared/clientMintIntegration.js).
    client_side_mint_enabled: false,
    mint_url: '',
    client_mint_ttl_seconds: 300,
    // Spec 042 — single fail-closed switch that hides every customer-facing
    // Bitcoin/Lightning surface for the beta launch. Default false: absent or
    // un-loaded config ⇒ Bitcoin hidden. The gateway surfaces this from
    // GATEWAY_BITCOIN_FEATURES_ENABLED; until then the field is absent and the
    // wallet hides Bitcoin with no backend change. Re-activation (cross-border
    // payments) flips the env var — no frontend redeploy. The sats BACKING of
    // vouchers is unaffected by this flag; only the visible sats/₿ display is.
    bitcoin_features_enabled: false,
    // Spec 043 fix — secondary private relay URL for kind-3 contact list
    // publishing (and any future per-spec write that wants both private
    // relays). Backed by GATEWAY_RELAY_URL_SECONDARY on the gateway.
    // Empty default: until the backend exposes the field, publishers
    // silently fall back to the primary relay only. Per CLAUDE.md the
    // policy values are `wss://relay.imani.casa` (primary) and
    // `wss://relay.398ja.xyz` (secondary); the frontend reads them from
    // the gateway env-backed config and never hardcodes either.
    relay_url_secondary: ''
  };

  function _normaliseCashbackOrigins(c) {
    const raw = c?.cashback_origins;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(entry => typeof entry === 'string')
      .map(entry => entry.toLowerCase().trim())
      .filter(entry => entry.length > 0);
  }

  function _notifyReady(c) {
    while (_readyCallbacks.length) {
      const cb = _readyCallbacks.shift();
      try { cb(c); } catch (_e) { /* callback errors are non-fatal */ }
    }
  }

  async function load() {
    if (_config) return _config;
    if (_promise) return _promise;
    _promise = fetch('/api/v1/config')
      .then(r => r.ok ? r.json() : EMPTY)
      .then(c => { _config = c; _notifyReady(c); return c; })
      .catch((err) => {
        console.error('[GatewayConfig] /api/v1/config failed — relay/domain values will be empty until reachable:', err);
        _config = EMPTY;
        _notifyReady(EMPTY);
        return EMPTY;
      });
    return _promise;
  }

  return {
    /** Ensure config is loaded. Call early (e.g., on page load). */
    init: load,

    /** Relay URL — sync access (returns '' until config has loaded). */
    get relayUrl() { return _config?.relay_url || ''; },

    /** Lightning domain — sync access (returns '' until config has loaded). */
    get lightningDomain() { return _config?.lightning_domain || ''; },

    /** NIP-05 domain — sync access (returns '' until config has loaded). */
    get nip05Domain() { return _config?.nip05_domain || ''; },

    /** Default domain — sync access (returns '' until config has loaded). */
    get defaultDomain() { return _config?.default_domain || ''; },

    /** True once the async /api/v1/config fetch has resolved. */
    get isReady() { return _config !== null; },

    /** Async relay URL — awaits config load. Always correct. */
    async getRelayUrl() { const c = await load(); return c.relay_url || ''; },

    /** Async lightning domain — awaits config load. */
    async getLightningDomain() { const c = await load(); return c.lightning_domain || ''; },

    /** Async NIP-05 domain — awaits config load. */
    async getNip05Domain() { const c = await load(); return c.nip05_domain || ''; },

    /**
     * Trusted cashback origins (lower-cased hostnames) — sync access.
     * Empty array until /api/v1/config resolves; fail-closed for the
     * cashback recogniser (FR-009 in spec 010).
     */
    get cashbackOrigins() { return _normaliseCashbackOrigins(_config); },

    /** Async cashback origins — awaits config load. */
    async getCashbackOrigins() { const c = await load(); return _normaliseCashbackOrigins(c); },

    /**
     * Spec 011 — gates the typed-claim-code ingest surface
     * (`voucher/cashback-code.html` page + the entry-point row on
     * `voucher/receive.html`). Ops flips this true once
     * `/api/v1/portal/cashback/by-code/{code}` is live in the corresponding
     * environment. Default false (fail-closed): if the wallet ships before
     * the gateway-portal endpoint exists, customers see the surviving
     * 010 paths (camera scan + URL paste) and nothing broken.
     */
    get cashbackCodeEntryEnabled() { return _config?.cashback_code_entry_enabled === true; },

    /** Async — awaits config load. */
    async getCashbackCodeEntryEnabled() { const c = await load(); return c.cashback_code_entry_enabled === true; },

    /**
     * Spec 015 phase 4 (Defense D-7) — gates the "Full" diagnostic export
     * mode in `diagnostic-storage.html`. The Full mode bundles bearer
     * cashu tokens and the encrypted nsec; until ALL six security
     * controls (warning banner, redaction default, secure delivery doc,
     * retention doc, rotation prompt, telemetry) are verified by their
     * tests AND the deployment has agreed to the runbook, this flag
     * stays false and the diagnostic page only offers the Redacted mode.
     * Default false (fail-closed).
     */
    get diagnosticExportFullEnabled() { return _config?.diagnostic_export_full_enabled === true; },

    /** Async — awaits config load. */
    async getDiagnosticExportFullEnabled() { const c = await load(); return c.diagnostic_export_full_enabled === true; },

    /**
     * Spec 037 — Blossom server URL for profile avatar/banner uploads.
     * Sync access (returns '' until config has loaded). Throws when the
     * config has loaded but the field is empty, so a misconfigured
     * deployment surfaces at the upload site rather than silently using
     * a wrong default. Pins SC-005 + Constitution Security §
     * "No hardcoded domain names" — the only path to the Blossom server
     * is via this getter (or the async variant below).
     */
    get blossomServerUrl() {
      if (!_config) return '';
      const url = _config.blossom_server_url;
      if (!url) {
        throw new Error(
          'GatewayConfig: blossom_server_url missing from /api/v1/config response — ' +
          'check BLOSSOM_SERVER_URL on the gateway.',
        );
      }
      return url;
    },

    /** Async — awaits config load and returns the Blossom server URL. */
    async getBlossomServerUrl() {
      const c = await load();
      if (!c.blossom_server_url) {
        throw new Error(
          'GatewayConfig: blossom_server_url missing from /api/v1/config response — ' +
          'check BLOSSOM_SERVER_URL on the gateway.',
        );
      }
      return c.blossom_server_url;
    },

    /**
     * Spec 041 — client-side voucher minting feature flag. When true AND
     * {@link mintUrl} is set, the wallet's buy-flow takes the
     * browser-mint path via ClientMintIntegration. Default false
     * (fail-safe — staging environments turn this on; production stays
     * off until the production-migration spec ships per FR-004a).
     */
    get clientSideMintEnabled() { return _config?.client_side_mint_enabled === true; },

    /** Async — awaits config load. */
    async getClientSideMintEnabled() { const c = await load(); return c.client_side_mint_enabled === true; },

    /**
     * Spec 041 — direct browser-to-cashu-mint endpoint. Source of truth
     * for the cashu mint URL the orchestrator calls (no hardcoded
     * domain — sourced from the gateway's MINT_URL env var). Returns
     * '' until /api/v1/config loads; sites that need to fail-loud on
     * a misconfigured deployment should check
     * {@link clientSideMintEnabled} first and surface their own error.
     */
    get mintUrl() { return _config?.mint_url || ''; },

    /** Async — awaits config load. */
    async getMintUrl() { const c = await load(); return c.mint_url || ''; },

    /**
     * Spec 041 — TTL (seconds) for a single client-mint attempt before
     * the gateway's ClientMintTimeoutJob marks the row CLIENT_MINT_TIMEOUT.
     * Used by the orchestrator to derive the per-attempt mint-claim
     * TTL. Default 300s; the gateway surfaces the actual configured
     * value via /api/v1/config.
     */
    get clientMintTtlSeconds() {
      const v = _config?.client_mint_ttl_seconds;
      return typeof v === 'number' && v > 0 ? v : 300;
    },

    /** Async — awaits config load. */
    async getClientMintTtlSeconds() {
      const c = await load();
      const v = c.client_mint_ttl_seconds;
      return typeof v === 'number' && v > 0 ? v : 300;
    },

    /**
     * Spec 042 — Bitcoin/Lightning feature visibility gate. When true, the
     * wallet shows the Buy button, the Bitcoin wallet, onboarding lud16
     * capture, Bitcoin settings, and sats/₿ amounts. Default false
     * (fail-closed): until the gateway sets bitcoin_features_enabled true,
     * every Bitcoin/Lightning surface is hidden for the beta. Strict-boolean:
     * only the JSON boolean `true` enables. Read by shared/bitcoinFeatures.js.
     */
    get bitcoinFeaturesEnabled() { return _config?.bitcoin_features_enabled === true; },

    /** Async — awaits config load. */
    async getBitcoinFeaturesEnabled() { const c = await load(); return c.bitcoin_features_enabled === true; },

    /**
     * Spec 043 fix — Secondary private relay URL for kind-3 contact list
     * publishing. Sync access (returns '' until config has loaded or if
     * the backend has not exposed the field). Per CLAUDE.md policy the
     * only valid private relays are `wss://relay.imani.casa` (primary,
     * via {@link relayUrl}) and `wss://relay.398ja.xyz` (secondary).
     * Both are sourced from the gateway env-backed config — never
     * hardcoded on the frontend.
     */
    get secondaryRelay() { return _config?.relay_url_secondary || ''; },

    /** Async — awaits config load and returns the secondary relay URL. */
    async getSecondaryRelay() { const c = await load(); return c.relay_url_secondary || ''; },

    /** Returns relay URL(s) as array — sync; may be [''] before init. */
    getRelays() { return [this.relayUrl]; },

    /**
     * Register a callback invoked with the config once /api/v1/config
     * resolves (or immediately if it already has).
     */
    whenReady(cb) {
      if (typeof cb !== 'function') return;
      if (_config) { try { cb(_config); } catch (_e) {} return; }
      _readyCallbacks.push(cb);
    },

    /** Returns full config object (async). */
    getConfig: load
  };
})();

// Expose on globalThis so ES modules (not just classic scripts) can reach it.
if (typeof globalThis !== 'undefined') {
  globalThis.GatewayConfig = GatewayConfig;
}

// Auto-init on script load
GatewayConfig.init();

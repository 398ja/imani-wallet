/**
 * Token Redemption Service
 * Shared logic for redeeming Cashu tokens from various sources (DM, manual paste, scan)
 *
 * This module extracts the core redemption logic so it can be used by:
 * - DmPollService (auto-redemption)
 * - Receive screen (manual claim)
 * - Scan screen (scanned token)
 *
 * ---------------------------------------------------------------------------
 * Spec 039 — Reliable Voucher QR Transfers: Phase 1 audit checklist (T002)
 *
 * Inventory of `api.inspectVoucher(...)` call sites — all opportunistic
 * today (try/catch swallow). Phase 3 (US 1, T030) PROMOTES this file's
 * call site to a HARD precondition gated on
 * `ctx.source === 'scan' || ctx.source === 'manual'`
 * (do NOT read this as the JS literal `ctx.source === 'scan' || 'manual'`
 * — that expression is always truthy and would gate every call site).
 * Other sites keep their opportunistic posture because they
 * serve non-save backfill purposes (chunked-DM provenance enrichment,
 * legacy-voucher home-screen backfill, re-resolve loops) where fail-
 * closed would block valid flows that don't have provenance available.
 *
 *   shared/tokenRedemption.js:960         → PROMOTE to hard precondition
 *                                             for ctx.source in {scan, manual}
 *                                             (T030 — US 1)
 *   shared/api.js:1369                    → KEEP (wrapper definition)
 *   shared/dmPoll.js:1797                 → KEEP opportunistic
 *                                             (chunked-DM provenance enrichment;
 *                                             not a fresh save path — voucher
 *                                             already has provenance from spec-038
 *                                             FR-020 fields when reached)
 *   shared/walletIntegration.js:793       → KEEP opportunistic
 *                                             (re-resolve loop, not a save path)
 *   voucher/js/home.js:2018                → KEEP opportunistic
 *                                             (legacy-voucher backfill loop; one-
 *                                             shot at boot for pre-spec-038 rows
 *                                             that lack issuer_id)
 *
 * Listener preservation contract: the spec-038 unified pipeline + the
 * dmPoll downstream listeners (`voucher-received`, `incoming-payment-
 * reconciled`, `redemption:success`) MUST still fire after the spec-039
 * tightening. The inspect-blocked path throws BEFORE the redemption
 * pipeline runs, so listeners are not affected on the happy path.
 *
 * Spec-039 ctx.source plumbing (T018a): TokenRedemption.redeem accepts
 * an optional ctx.source string in opts; values: scan | manual | sse |
 * catchup | cashback | escrow_recovery. The T030 gate keys on this
 * value. Spec-038 callers (sse, catchup) skip the inspect gate because
 * their provenance was already verified by FR-020 swap_proof_ids;
 * cashback + escrow_recovery skip because they're recovering pre-
 * existing rows, not saving new ones.
 * ---------------------------------------------------------------------------
 */

// ----------------------------------------------------------------------------
// Currency resolution — feature 007-fix-voucher-currency
//
// Prefer the ES module at shared/currency.js; fall back to a local mirror when
// the module hasn't been loaded (classic-script execution, CJS tests).
// ----------------------------------------------------------------------------
const __currencyApi =
    (typeof window !== 'undefined' && window.ImaniCurrency) ||
    (typeof globalThis !== 'undefined' && globalThis.ImaniCurrency) ||
    (function () {
        const UNKNOWN = 'UNKNOWN';
        function normalizeFaceUnit(input) {
            if (typeof input !== 'string') return null;
            const t = input.trim();
            if (t.length === 0) return null;
            const u = t.toUpperCase();
            if (u === UNKNOWN) return null;
            return u;
        }
        function resolveFaceUnit(inputs) {
            const dm = normalizeFaceUnit(inputs?.dmMetadata?.face_unit ?? inputs?.dmMetadata?.faceUnit);
            if (dm !== null) return { faceUnit: dm, source: 'dm' };
            const meta = normalizeFaceUnit(inputs?.getTokenMetadataResult?.face_unit);
            if (meta !== null) return { faceUnit: meta, source: 'token_metadata' };
            const insp = normalizeFaceUnit(inputs?.inspectResult?.face_unit);
            if (insp !== null) return { faceUnit: insp, source: 'inspect' };
            const rcv = normalizeFaceUnit(inputs?.receiveResult?.face_unit ?? inputs?.receiveResult?.unit);
            if (rcv !== null) return { faceUnit: rcv, source: 'receive_result' };
            // 5th source — cached merchant profile. The ES module mirror
            // in shared/currency.js was never loaded on classic-script
            // pages (home.html, send.html, voucher pages), so for years
            // the live `window.ImaniCurrency.resolveFaceUnit` has been
            // THIS local fallback. Without merchantProfile here, every
            // freshly-issued voucher whose backend metadata hasn't
            // propagated lands as UNKNOWN. Accept any of the common
            // field-name spellings.
            const mp = inputs?.merchantProfile;
            if (mp && typeof mp === 'object') {
                const candidates = [
                    mp.issuance_currency,
                    mp.issuanceCurrency,
                    mp.face_unit,
                    mp.faceUnit,
                    mp.currency,
                    mp.unit,
                    Array.isArray(mp.currencies) ? mp.currencies[0] : null,
                ];
                for (const c of candidates) {
                    const n = normalizeFaceUnit(c);
                    if (n !== null) return { faceUnit: n, source: 'merchant_profile' };
                }
            }
            return { faceUnit: UNKNOWN, source: 'unknown' };
        }
        return { UNKNOWN, normalizeFaceUnit, resolveFaceUnit };
    })();

// Classic scripts like dmPoll.js and voucher/js/receive.js read the resolver
// from window.ImaniCurrency. Expose the local mirror when the ES module was
// not loaded so the live runtime still follows the shared resolution chain.
try {
    if (typeof window !== 'undefined' && !window.ImaniCurrency) {
        window.ImaniCurrency = Object.freeze({
            UNKNOWN: __currencyApi.UNKNOWN,
            normalizeFaceUnit: __currencyApi.normalizeFaceUnit,
            resolveFaceUnit: __currencyApi.resolveFaceUnit,
        });
    }
} catch (_) {
    // best-effort global exposure for classic scripts
}

try {
    if (typeof globalThis !== 'undefined' && !globalThis.ImaniCurrency) {
        globalThis.ImaniCurrency = (typeof window !== 'undefined' && window.ImaniCurrency)
            ? window.ImaniCurrency
            : Object.freeze({
                UNKNOWN: __currencyApi.UNKNOWN,
                normalizeFaceUnit: __currencyApi.normalizeFaceUnit,
                resolveFaceUnit: __currencyApi.resolveFaceUnit,
            });
    }
} catch (_) {
    // best-effort global exposure for non-window runtimes
}

function __toFiniteRedemptionNumber(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;
        const numeric = Number(trimmed);
        return Number.isFinite(numeric) ? numeric : null;
    }
    return null;
}

function __firstFiniteRedemptionNumber(...values) {
    for (const value of values) {
        const numeric = __toFiniteRedemptionNumber(value);
        if (numeric !== null) return numeric;
    }
    return null;
}

function __firstPositiveRedemptionNumber(...values) {
    for (const value of values) {
        const numeric = __toFiniteRedemptionNumber(value);
        if (numeric !== null && numeric > 0) return numeric;
    }
    return null;
}

// ============================================================================
// LocalRedemptionClaim — localStorage-backed cross-tab + sequential-retry
// lock that complements TokenRedemption's in-memory single-flight (which only
// protects same-tab concurrent calls).
//
// Two failure modes this addresses that single-flight alone can't:
//   1. Cross-tab race: tab A and tab B both poll the same DM. Each tab has
//      its own in-memory map, so single-flight doesn't help; without this
//      lock, both call the mint swap, one wins, the other loses with
//      "Proof already used" and silently drops its recording side effects.
//   2. Sequential retry after success: tab A redeems the token successfully,
//      proofs burned at mint, voucher saved. Some later code path (sync
//      pull, page reload, retry queue) re-attempts the same token. Without
//      this lock, the retry calls the mint, fails ("Proof already used"),
//      and may corrupt local state. With this lock, the retry short-
//      circuits on the persistent `done` marker.
//
// Storage shape:
//   key  : `imani_redeem_claim:<fingerprint>`
//   value: { tabId, status: 'in_progress' | 'done', startedAt,
//            completedAt?, voucherId? }
//
// TTLs:
//   - in_progress: 60s (holder probably died if longer)
//   - done       : 30min (long enough for sync convergence)
//
// Cleanup happens lazily on read (stale entries are treated as absent).
// ============================================================================
const LocalRedemptionClaim = (() => {
    const KEY_PREFIX = 'imani_redeem_claim:';
    const IN_PROGRESS_TTL_MS = 60 * 1000;
    // Spec 022 — done-marker retention extended from 30 minutes to 30
    // days, matching the gateway's receive-escrow TTL. A token redeemed
    // and forgotten for ~a month, then reappearing on a stale relay
    // broadcast, still short-circuits via the persistent done marker
    // instead of hitting the mint (which would reject "Proof already
    // used" — not a double-burn, but wasted API calls + visible
    // failed-redemption noise).
    const DONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

    function _key(fingerprint) { return KEY_PREFIX + fingerprint; }

    function _getStorage() {
        try {
            return (typeof window !== 'undefined' && window.localStorage) || null;
        } catch (_) { return null; }
    }

    function _read(fingerprint) {
        const ls = _getStorage();
        if (!ls) return null;
        try {
            const raw = ls.getItem(_key(fingerprint));
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (_) { return null; }
    }

    function _write(fingerprint, claim) {
        const ls = _getStorage();
        if (!ls) return;
        try { ls.setItem(_key(fingerprint), JSON.stringify(claim)); }
        catch (_) { /* quota or disabled */ }
    }

    function _remove(fingerprint) {
        const ls = _getStorage();
        if (!ls) return;
        try { ls.removeItem(_key(fingerprint)); } catch (_) { /* swallow */ }
    }

    function _isStale(claim) {
        if (!claim || !claim.status) return true;
        const ttl = claim.status === 'in_progress' ? IN_PROGRESS_TTL_MS : DONE_TTL_MS;
        const stamp = claim.completedAt || claim.startedAt || 0;
        return Date.now() - stamp > ttl;
    }

    return {
        // Exposed for tests + diagnostics.
        KEY_PREFIX, IN_PROGRESS_TTL_MS, DONE_TTL_MS,

        /**
         * Read the current claim. Returns null if absent or stale (stale
         * entries are treated as absent so a follow-up `tryAcquire` will
         * succeed without manual cleanup).
         */
        read(fingerprint) {
            const claim = _read(fingerprint);
            if (!claim || _isStale(claim)) return null;
            return claim;
        },

        /**
         * Attempt to claim the in_progress slot for this fingerprint.
         *
         * Returns `{ claimed: true, claim }` on success, or
         * `{ claimed: false, existing }` if another tab holds an active
         * claim. The check is best-effort — localStorage has no CAS, so
         * truly simultaneous writes from two tabs may both think they
         * won. The read-back step narrows the window: after writing, we
         * re-read and verify our tabId is the one stored.
         */
        tryAcquire(fingerprint, tabId) {
            const existing = _read(fingerprint);
            if (existing && !_isStale(existing) && existing.tabId !== tabId) {
                return { claimed: false, existing };
            }
            const claim = { tabId, status: 'in_progress', startedAt: Date.now() };
            _write(fingerprint, claim);
            // Read-back race-narrow: another tab may have written between
            // our read and write. Trust the value that's actually in
            // storage as the winner.
            const readBack = _read(fingerprint);
            if (readBack && readBack.tabId !== tabId) {
                return { claimed: false, existing: readBack };
            }
            return { claimed: true, claim };
        },

        /**
         * Transition the claim to `done` and record the voucherId so
         * losing/awaiting tabs can look up the saved voucher locally.
         * No-op if we don't own the claim (avoids clobbering another
         * tab's claim if our claim was stolen during a stale window).
         */
        markDone(fingerprint, tabId, voucherId, tokenId) {
            const existing = _read(fingerprint);
            if (!existing || existing.tabId !== tabId) return;
            // Spec 022 — store BOTH voucherId (legacy callers + fallback
            // lookup) and tokenId (preferred lookup key per spec 017,
            // because voucher_id is a merchant-template id that can be
            // shared across multiple cashu tokens). Legacy 3-arg callers
            // get tokenId=undefined which becomes a missing field; the
            // claim reader falls back to voucher_id lookup in that case.
            const next = {
                ...existing,
                status: 'done',
                completedAt: Date.now(),
                voucherId,
            };
            if (tokenId) next.tokenId = tokenId;
            _write(fingerprint, next);
        },

        /**
         * Release the claim — used when redemption failed BEFORE the
         * mint swap (so the proofs are still spendable and a retry is
         * legitimate). Do NOT call this if the swap succeeded but a
         * later step failed; the proofs are burned and `markDone` is
         * still the right outcome.
         */
        release(fingerprint, tabId) {
            const existing = _read(fingerprint);
            if (!existing || existing.tabId !== tabId) return;
            _remove(fingerprint);
        },

        /**
         * Poll until the claim transitions to `done` or staleness, up to
         * `timeoutMs`. Used by tabs that lost the acquire race but want
         * the result. Returns the final claim object, or `{ status:
         * 'timeout' }` if the holder never made progress.
         *
         * Spec 022 T015 — default timeout aligned to `IN_PROGRESS_TTL_MS`
         * so a waiter doesn't give up on a still-alive holder. The
         * previous default of 30s was shorter than the in_progress TTL
         * (60s), so a slow holder + a too-eager waiter could end with
         * the waiter falling through to `_doRedeem` while the holder
         * was still actively redeeming — a literal "two mints, one
         * wins" race. Aligning the timeouts closes that loophole.
         */
        async waitForDone(fingerprint, timeoutMs = IN_PROGRESS_TTL_MS) {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const claim = _read(fingerprint);
                if (!claim || _isStale(claim)) return { status: 'stale' };
                if (claim.status === 'done') return claim;
                await new Promise((r) => setTimeout(r, 100));
            }
            return { status: 'timeout' };
        },
    };
})();

// Markers used by `redeem()` to decide whether to RELEASE or KEEP the
// cross-tab claim on a thrown error. Pre-swap errors (size validation,
// duplicate-check fail, network error before /v1/swap) are safe to retry
// — release. Post-swap errors (mint says "Proof already used", local
// save failure after the proofs are burned) mean the proofs are already
// gone — keep the claim so retries don't burn through another set.
const PRE_SWAP_ERROR_MARKERS = [
    'No token provided',
    'Token validation failed',
    'You have already received this voucher',
    'Token is being processed by another redemption',
];

function _isPreSwapError(err) {
    if (!err) return false;
    const msg = String(err.message || err);
    return PRE_SWAP_ERROR_MARKERS.some((marker) => msg.indexOf(marker) >= 0);
}

// ============================================================================
// Spec 038 T018 — transient vs terminal classifier for the api.receive
// retry wrapper. Retries network blips + gateway 5xx (transient); never
// retries auth failures or terminal mint errors (already_spent etc.).
// ============================================================================

/**
 * Classify an api.receive error as transient (retry-eligible) or terminal.
 *
 * Transient:
 *   - Fetch-style network errors ("Failed to fetch", "NetworkError when…")
 *   - AbortError (timeout)
 *   - HTTP 5xx responses from the gateway
 *   - Connection-refused / DNS shapes
 *
 * Terminal (never retried):
 *   - 4xx auth (401/403) — session needs re-login, not retry
 *   - Other 4xx — request shape is wrong
 *   - "already_spent" / "bad_signature" / similar mint terminal classes
 *   - The pre-swap markers above (token-already-redeemed user-visible)
 *
 * @param {Error|unknown} err
 * @returns {boolean} true iff retry-eligible per FR-016
 */
function _isTransientReceiveError(err) {
    if (!err) return false;
    const msg = String(err.message || err);

    // Terminal: explicit mint terminal classes.
    if (/already[\s_]spent|bad[\s_]signature|invalid[\s_]signature/i.test(msg)) {
        return false;
    }
    // Terminal: pre-swap user-visible markers (already redeemed etc.).
    if (_isPreSwapError(err)) return false;

    // Terminal: HTTP 4xx (auth + bad request). Match common shapes:
    //   "HTTP 401: ...", "401 ...", "status: 403", "status code 400".
    if (/\b4(0[0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9])\b/.test(msg)
        && !/\b5\d\d\b/.test(msg)) {
        return false;
    }

    // Transient: explicit network / timeout shapes.
    if (err && err.name === 'AbortError') return true;
    if (/Failed to fetch|NetworkError|network[\s_]error|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(msg)) {
        return true;
    }
    // Transient: HTTP 5xx.
    if (/\b5\d\d\b/.test(msg)) return true;

    // Default conservatively to TERMINAL — a misclassified terminal-as-transient
    // would burn the retry budget on a permanently-failing request, masking the
    // real error from the user. A misclassified transient-as-terminal merely
    // surfaces an error sooner; the user can retry the action manually.
    return false;
}

/**
 * Wrap `fn` with the FR-016 transient-error retry policy if the
 * @imani/dm-poll IIFE bundle is loaded; otherwise call directly.
 * Logs each retry attempt at info level.
 *
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function _withReceiveRetry(fn) {
    if (typeof ImaniDmPoll !== 'undefined'
        && typeof ImaniDmPoll.retryOnTransientMintError === 'function') {
        return ImaniDmPoll.retryOnTransientMintError(fn, {
            isTransient: _isTransientReceiveError,
            onRetry: ({ attempt, delayMs, error }) => {
                console.warn(
                    '[tokenRedemption] api.receive transient failure — retry',
                    { attempt, delayMs, message: error && error.message }
                );
            },
        });
    }
    return fn();
}

// ============================================================================
// Spec 038 T019 — build a TransactionRow shape for atomicallyWrite from a
// voucher. Mirrors the field shape recordLocalVoucherTransaction →
// addTransaction → buildWalletTransactionId would produce, so the id
// matches and downstream duplicate-recording calls hit the spec-035
// collision-detection no-op.
// ============================================================================

function _buildReceiveTransactionRow(voucher, metadata = {}) {
    if (!voucher) return null;
    const tokenId = voucher.token_id || null;
    if (!tokenId) return null; // Atomic write requires content-derived id (Principle III).
    const isPayment = voucher.status === 'payment' || voucher.status === 'burned';
    const txType = isPayment ? 'payment' : 'received';
    return {
        id: `${txType}:${tokenId}`,
        txId: `${txType}:${tokenId}`,
        type: txType,
        direction: 'in',
        timestamp: Date.now(),
        amount: voucher.face_value || voucher.token_amount || metadata.face_value || metadata.token_amount || 0,
        unit: (voucher.face_unit || metadata.face_unit || 'UNKNOWN').toUpperCase(),
        decimals: voucher.face_decimals ?? metadata.face_decimals ?? 2,
        merchantName: (voucher.merchant_metadata && (voucher.merchant_metadata.merchant_name || voucher.merchant_metadata.name)) || null,
        merchantId: voucher.issuer_id || metadata.issuer_id || (voucher.merchant_metadata && voucher.merchant_metadata.merchant_id) || null,
        counterparty: metadata.sender_pubkey || voucher.sender_pubkey || null,
        voucherId: voucher.voucher_id,
        tokenId,
        bundleId: metadata.bundle_id || voucher.bundle_id || null,
        // What the wallet checked about the arriving voucher, carried onto the
        // row so the Checks section can show it. Every other field here is
        // named explicitly, so a pass-through blob would be dropped silently —
        // which is exactly what happened: the verifier, the type and the UI all
        // shipped, and the row it renders from never carried the result.
        // Absent for plain ecash, which has no issuer claim to check.
        validation: metadata.validation || undefined,
        // #402 traceability: where an online shop spent it (order number, shop), as the shop
        // declared it on the envelope. Read by the merchant's books; absent for anything else.
        spendSource: metadata.spend_source || metadata.spendSource || undefined,
        memo: isPayment
            ? (voucher.memo ? `[PAYMENT] ${voucher.memo}` : '[PAYMENT] Payment to merchant')
            : (voucher.memo || 'Received via DM'),
    };
}

// ============================================================================
// Spec 022 — typed error subclasses thrown by `TokenRedemption.redeem`.
// Exposed on `TokenRedemption.RedemptionSaveError` /
// `TokenRedemption.RedemptionClaimContendedError` so callers can do
// `instanceof` checks across the classic-script module boundary.
// ============================================================================

/**
 * Thrown when the mint swap succeeded (proofs are burned and held in
 * the gateway's receive-escrow) but the local save step failed —
 * `_doRedeem` returns `{ saveError: true, receiveId }`. Replaces the
 * spec-021 behavior of returning a voucher-shaped object with
 * `saveError: true`; callers can no longer accidentally treat the
 * result as success.
 *
 * The proofs ARE recoverable — the spec-021 escrow recovery sweep
 * reclaims on next boot. `receiveId` is exposed so callers can
 * correlate.
 */
class RedemptionSaveError extends Error {
    constructor(receiveId, cause) {
        super('Voucher swap succeeded but local save failed; proofs are recoverable on next boot');
        this.name = 'RedemptionSaveError';
        this.receiveId = receiveId;
        if (cause !== undefined) this.cause = cause;
        this.recoverable = true;
    }
}

/**
 * Thrown when the cross-tab claim cannot be acquired despite waiting
 * through the in-progress TTL. `redeem()` would otherwise have to
 * either race the holder to the mint (potential double-burn) or
 * silently no-op (potential dropped voucher); throwing makes the
 * contention explicit so the caller can back off + retry.
 */
class RedemptionClaimContendedError extends Error {
    constructor(fingerprint) {
        super('Another tab is redeeming this token; retry shortly');
        this.name = 'RedemptionClaimContendedError';
        this.fingerprint = fingerprint;
        this.recoverable = true;
    }
}

/**
 * Spec 039 — Reliable Voucher QR Transfers.
 *
 * Thrown when the QR-scan or manual-paste receive path cannot
 * authoritatively verify the voucher's provenance via
 * `POST /api/v1/atomic/vouchers/inspect`. Surfaces:
 *   - non-2xx HTTP response
 *   - network error
 *   - missing `expiry_verification` field (older gateway)
 *   - `expiry_verification === "unverified"`
 *
 * The save is BLOCKED before any IDB write; the proofs are NOT redeemed
 * at the mint either (the inspect call happens before `api.receive`).
 * Caller MUST surface an actionable error to the user.
 *
 * Contract:
 *   `specs/039-reliable-qr-transfers/contracts/inspect-provenance.md`
 */
class ProvenanceVerificationError extends Error {
    constructor(actionableMessage, options = {}) {
        super(actionableMessage || 'Voucher could not be verified.');
        this.name = 'ProvenanceVerificationError';
        this.actionable_message = actionableMessage
            || 'Voucher could not be verified. Please try again — or contact support if this keeps happening.';
        if (options.cause !== undefined) this.cause = options.cause;
        if (options.inspect_failure_reason !== undefined) {
            this.inspect_failure_reason = options.inspect_failure_reason;
        }
        // Copilot review on PR #301, comment 3339731872 — separate
        // structured `inspect_failure_reason` (stable code; aggregator
        // friendly) from `inspect_failure_detail` (dynamic gateway
        // value; debugger friendly).
        if (options.inspect_failure_detail !== undefined) {
            this.inspect_failure_detail = options.inspect_failure_detail;
        }
        this.recoverable = true;
    }
}

// Random per-tab id used as the claim owner. Survives page navigations
// within the same tab via sessionStorage; a hard refresh keeps it; a new
// tab gets a fresh id.
const REDEMPTION_TAB_ID = (() => {
    try {
        if (typeof window !== 'undefined' && window.sessionStorage) {
            let id = window.sessionStorage.getItem('imani_redeem_tab_id');
            if (!id) {
                id = Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
                window.sessionStorage.setItem('imani_redeem_tab_id', id);
            }
            return id;
        }
    } catch (_) { /* fall through */ }
    return Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
})();

// Expose for tests + cross-module callers.
try {
    if (typeof window !== 'undefined') {
        window.LocalRedemptionClaim = LocalRedemptionClaim;
    }
} catch (_) { /* swallow */ }

// ============================================================================
// #110 — the receive ledger: what this wallet knows about each receive_id.
//
// Every entry is one escrow, in one of three states:
//
//   'settled'   the swap succeeded and the voucher is NOT saved (yet). Kept so
//               a retry can recognise the token as ours. NEVER acknowledged:
//               an ack tells the gateway the value is safe on this device,
//               and it is not. Acking one would release the only record the
//               gateway has of money this wallet never kept (review of #111).
//   'saved'     the voucher is durably saved, the ack is owed. This is the
//               only state `unacknowledged()` returns and the flush acks.
//   'acked'     done.
//
// `_acknowledgeEscrow` used to promise "retry on next startup" to a recovery
// that is disabled (#95); five escrows sat HELD on staging for that reason.
// 'saved' entries are what the next poll or startup now retries.
//
// Shaped like src/lib/accountStore.ts (this is a classic script and cannot
// import it): PER ACCOUNT under `imani-wallet:<name>:<pubkey>` so logout's
// `imani-wallet:*` sweep clears it; BOUNDED, newest kept; FILTERED on read;
// NEVER THROWING. With no signed-in account it does nothing at all rather
// than pool several people's escrows under one shared key.
//
// Holds no secret: a receive_id is the gateway's escrow id and `fp` is the
// SHA-256 fingerprint of the token, never the token or its proofs.
// ============================================================================
const RECEIVE_STATES = ['settled', 'saved', 'acked'];

const ReceiveLedger = {
    NAME: 'receive-ledger',
    LIMIT: 200,

    _account() {
        try {
            const pk = typeof api !== 'undefined' && api && api._nostrPublicKey;
            return typeof pk === 'string' && pk !== '' ? pk : null;
        } catch (_) {
            return null;
        }
    },
    _key() {
        const account = this._account();
        return account ? `imani-wallet:${this.NAME}:${account}` : null;
    },
    _valid(e) {
        return !!e && typeof e === 'object'
            && typeof e.receiveId === 'string' && e.receiveId !== ''
            && typeof e.at === 'number'
            && RECEIVE_STATES.indexOf(e.state) >= 0
            && (e.fp === null || typeof e.fp === 'string');
    },
    list() {
        try {
            const key = this._key();
            if (!key || typeof localStorage === 'undefined') return [];
            const raw = localStorage.getItem(key);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.filter((e) => this._valid(e)) : [];
        } catch (_) {
            return [];
        }
    },
    _write(entries) {
        try {
            const key = this._key();
            if (!key || typeof localStorage === 'undefined') return;
            const next = entries.slice().sort((a, b) => b.at - a.at).slice(0, this.LIMIT);
            localStorage.setItem(key, JSON.stringify(next));
        } catch (e) {
            console.warn('[receiveLedger] could not persist:', e && e.message);
        }
    },
    _set(receiveId, fp, state) {
        if (!receiveId) return;
        const entries = this.list();
        const prev = entries.find((e) => e.receiveId === receiveId);
        // States only move forward: a late 'settled' must not undo 'saved'.
        const nextState = prev && RECEIVE_STATES.indexOf(prev.state) > RECEIVE_STATES.indexOf(state)
            ? prev.state : state;
        const rest = entries.filter((e) => e.receiveId !== receiveId);
        this._write([{
            receiveId,
            fp: fp || (prev && prev.fp) || null,
            at: Date.now(),
            state: nextState,
        }, ...rest]);
    },
    /** The swap succeeded; nothing is saved. Never acked from this state. */
    recordSettled(receiveId, fp) { this._set(receiveId, fp, 'settled'); },
    /** The voucher is durably saved; the escrow's ack is now owed. */
    recordSaved(receiveId, fp) { this._set(receiveId, fp, 'saved'); },
    markAcked(receiveId) {
        if (!receiveId) return;
        if (!this.list().some((e) => e.receiveId === receiveId)) return;
        this._set(receiveId, null, 'acked');
    },
    /** The receive_id this wallet already holds for a token fingerprint, if any. */
    receiveIdFor(fp) {
        if (!fp) return null;
        const hit = this.list().find((e) => e.fp === fp);
        return hit ? hit.receiveId : null;
    },
    /** The whole entry for a token fingerprint ({ receiveId, state }), or null. */
    entryFor(fp) {
        if (!fp) return null;
        return this.list().find((e) => e.fp === fp) || null;
    },
    /** Saved but not acknowledged: the ONLY ids anything may ack. */
    unacknowledged() {
        return this.list().filter((e) => e.state === 'saved').map((e) => e.receiveId);
    },
    /** Swapped at the gateway, never saved here: for reconciliation, never acked. */
    settledUnsaved() {
        return this.list().filter((e) => e.state === 'settled').map((e) => e.receiveId);
    },
};

/**
 * #110 — a receive the gateway settled for this token whose value is NOT in
 * this wallet.
 *
 * Raised when:
 *   - the gateway answers a same-token receive with 409 RECEIVE_ALREADY_SETTLED
 *     (imani-gateway-customer#119);
 *   - a mint 11001 / already-spent comes back for a token this wallet already
 *     holds a receive_id for;
 *   - a receive returns a receive_id but no fresh token (the gateway's
 *     same-Idempotency-Key replay, "Receive: repeats" in its docs/api.md).
 *
 * Terminal for RE-SWAPPING, and deliberately NOT a success. The message does
 * not say "already redeemed", so dm-poll does not mark the token received or
 * emit a synthetic redemption:success, which would make the loss silent. The
 * name, code and receiveId make it visible for reconciliation (review of #111).
 */
class ReceiveSettledNotSavedError extends Error {
    constructor(receiveId, reason, cause) {
        super('Receive settled at the gateway but not saved in this wallet; needs reconciliation');
        this.name = 'ReceiveSettledNotSavedError';
        this.code = 'RECEIVE_SETTLED_NOT_SAVED';
        this.receiveId = receiveId || null;
        this.reason = reason || null;
        this.terminal = true;
        if (cause !== undefined) this.cause = cause;
    }
}

/**
 * Is `err` the gateway saying this token's receive already settled?
 * Either the explicit 409 code, or 11001/already-spent from the mint on a
 * token the ledger shows we already received (`knownReceiveId`).
 */
function _isAlreadySettledReceive(err, knownReceiveId) {
    if (!err) return false;
    const code = err.code || (err.data && (err.data.code || (err.data.error && err.data.error.code)));
    if (code === 'RECEIVE_ALREADY_SETTLED') return true;
    if (!knownReceiveId) return false;
    const msg = String(err.message || err);
    return /11001|already[\s_]spent|proof already used/i.test(msg);
}

/**
 * The receive_id a 409 RECEIVE_ALREADY_SETTLED names. The gateway puts it in
 * the `X-Receive-Id` header and in `details: "receive_id=… status=…"`; the
 * header wins, the details string is the fallback.
 */
function _settledReceiveIdFrom(err) {
    if (!err) return null;
    try {
        const h = err.headers;
        const fromHeader = h && (typeof h.get === 'function' ? h.get('x-receive-id') : (h['x-receive-id'] || h['X-Receive-Id']));
        if (typeof fromHeader === 'string' && fromHeader) return fromHeader;
        const data = err.data || {};
        const details = [data.details, data.error && data.error.details, err.details]
            .find((d) => typeof d === 'string');
        const m = details && /receive_id=([^\s,;]+)/.exec(details);
        return m ? m[1] : null;
    } catch (_) {
        return null;
    }
}

/**
 * A fingerprint safe to key a receive on: 64 hex characters, i.e. a SHA-256
 * of the whole token. TokenSecurity's `_fallbackFingerprint` is
 * `fallback_<first 50 chars>_<length>`, and two different tokens can share it;
 * keyed on that, the gateway would replay token A's result for token B.
 */
function _isStrongFingerprint(fp) {
    return typeof fp === 'string' && /^[0-9a-f]{64}$/i.test(fp);
}

/** SHA-256 of the full token, hex, or null if WebCrypto is unavailable. */
async function _sha256Hex(text) {
    try {
        const subtle = typeof crypto !== 'undefined' && crypto && crypto.subtle;
        if (!subtle || typeof TextEncoder === 'undefined') return null;
        const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (_) {
        return null;
    }
}

/** The receive key for a fingerprint; null (no header) for anything weak. */
function _receiveKeyFor(fp) {
    if (!_isStrongFingerprint(fp)) return null;
    return typeof generateReceiveIdempotencyKey === 'function'
        ? generateReceiveIdempotencyKey(fp)
        : null;
}

/** A short, non-reversible handle for logs: never the token itself. */
function _fpTag(fp) {
    return typeof fp === 'string' && fp ? fp.slice(0, 8) : null;
}

/** Waits for `_acknowledgeEscrow`'s background retry, overridable by tests. */
const ACK_RETRY_BACKOFFS_MS = [2000, 10000, 30000];
/** Longest Retry-After honoured; beyond it the next poll takes over. */
const ACK_RETRY_MAX_WAIT_MS = 65000;
/** Acks one flush may send, so a backlog cannot spend the receive budget. */
const ACK_FLUSH_MAX_PER_RUN = 2;
/** Minimum gap between flushes. */
const ACK_FLUSH_MIN_INTERVAL_MS = 60000;
/** Consecutive 403s on one ack before it is dropped. */
const ACK_FORBIDDEN_MAX = 3;

/**
 * #110 review C — a hard ceiling on `api.receive` calls for ONE token, across
 * every retry layer (the inner transient retry, the 409 in-flight wait, and
 * dmPoll's outer 429 retry, which re-enters `redeem()`). Without it the layers
 * multiply (5 outer × 4 inner) and no pacing bound is honest. Past it the
 * redemption fails as an ordinary (non-success) failure, dm-poll files it, and
 * a later poll tries again once the span has passed. Mirrored by
 * `MAX_RECEIVE_CALLS_PER_TOKEN` in src/lib/receivePacer.ts; a test pins them
 * equal.
 */
const RECEIVE_CALLS_PER_TOKEN = 5;
/**
 * At least the bundle wait window (src/lib/bundleArrival.ts
 * BUNDLE_WAIT_WINDOW_MS; a test pins it), so one token cannot spend its cap
 * twice inside the window the pacing bound is computed for.
 */
const RECEIVE_CALLS_SPAN_MS = 20 * 60 * 1000;

/**
 * #110 review D — the gateway answers a duplicate that arrives while the first
 * call is mid-swap with 409 + `Retry-After: 2` and an empty body. That is "wait
 * a moment", not a failure: wait (capped) and retry under the SAME key, at most
 * this many times, each counted against RECEIVE_CALLS_PER_TOKEN.
 */
const IN_FLIGHT_RETRIES = 2;
const IN_FLIGHT_MAX_WAIT_MS = 5000;

/** The gateway's "your first call is still running" 409, as opposed to a settled one. */
function _isInFlightConflict(err) {
    if (!err || err.status !== 409) return false;
    const code = err.code || (err.data && err.data.code);
    if (code === 'RECEIVE_ALREADY_SETTLED') return false;
    return typeof err.retryAfterMs === 'number';
}

/**
 * #314: gateway-customer's NIP-98 filter refused the receive because its auth
 * event's `created_at` was outside the window (60 s by default): the request
 * spent over a minute in transit (a slow link, a held or backgrounded tab).
 * Shape, from imani-security `Nip98AuthFilter`: 401, `error.code` AUTH_002,
 * message "Auth event timestamp outside acceptable window". AUTH_002 covers
 * EVERY NIP-98 failure (bad signature, wrong url, replay), so the message is
 * what names this one, and only this one is cured by signing again.
 *
 * The filter runs before the controller, so nothing was received: the same
 * request with a fresh signature is safe, and it carries the same
 * Idempotency-Key, so the gateway still sees one receive.
 */
function _isStaleNip98Auth(err) {
    if (!err || err.status !== 401) return false;
    return /timestamp outside acceptable window/i.test(String(err.message || ''));
}

/** #314: fresh signatures after a stale-auth refusal, per receive attempt. */
const STALE_AUTH_RESIGNS = 1;

/**
 * The receive was already SAVED in this wallet (ledger state saved/acked): a
 * redelivery of a coupon we hold. Reported with the old "already redeemed"
 * wording so dm-poll takes its idempotent path (mark received, bundle success)
 * rather than raising a false loss (#110 review A).
 */
function _alreadyRedeemedHere() {
    return new Error('This token has already been redeemed');
}

/**
 * #300: every await between the metadata fetch and api.receive is bounded, so
 * a request or pacer that never settles cannot hang a redemption. Rejects with
 * code STEP_TIMEOUT (and logs) when `promise` has not settled in `ms`.
 */
function _withStepTimeout(promise, ms, step, fingerprint) {
    if (!(ms > 0)) return promise;
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            console.warn('[tokenRedemption] #300 redemption step timed out', {
                step, timeoutMs: ms, fp: _fpTag(fingerprint),
            });
            const err = new Error(`${step} did not answer within ${ms} ms`);
            err.code = 'STEP_TIMEOUT';
            reject(err);
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const TokenRedemption = {
    // Single-flight in-memory map: token fingerprint → in-flight redemption
    // promise. When two callers race on the SAME token (e.g., dmPoll +
    // auto-redemption-pipeline), the second caller awaits the first's
    // promise instead of starting a second redemption that would race the
    // first to the mint and lose with "Proof already used". See staging
    // incident 2026-05-16 where the recipient's wallet attempted two
    // claims of the €0.14 voucher 5 seconds apart; the first succeeded at
    // the mint but the second's failure (and its lost recording side
    // effects) hid the voucher from the wallet UI. Single-flight ensures
    // both callers observe the SAME successful result.
    //
    // Cross-tab + sequential-retry protection lives in `LocalRedemptionClaim`
    // above and is wired in inside `redeem()` alongside the single-flight
    // check.
    _inFlightRedemptions: new Map(),

    // How many redemptions are in flight in this tab, from the fingerprint step
    // through the save. Logout's drain waits for this to reach 0 (#331).
    inFlightCount() {
        return this._inFlightRedemptions.size;
    },

    // Exposed so tests can stub or inspect the claim layer.
    _localClaim: LocalRedemptionClaim,
    _tabId: REDEMPTION_TAB_ID,

    /**
     * Redeem a Cashu token and save the resulting voucher
     *
     * @param {string} token - The Cashu token (cashuA or cashuB format)
     * @param {Object} options - Redemption options
     * @param {Object} options.metadata - Optional metadata (from DM, URL params, etc.)
     * @param {string} options.metadata.face_value - Face value in minor units
     * @param {string} options.metadata.face_unit - Currency code
     * @param {string} options.metadata.issuer_id - Issuer/merchant hex pubkey
     * @param {string} options.metadata.sender_pubkey - Sender's hex pubkey (for NIP-60)
     * @param {string} options.metadata.backing_strategy - MINIMAL, FULL, or LEGACY
     * @param {string} options.metadata.memo - Optional memo
     * @param {Object} options.nip60Wallet - NIP-60 wallet instance for recording transactions
     * @param {boolean} options.skipDuplicateCheck - Skip local duplicate check (for DM auto-redeem)
     * @param {string} options.source - Spec 039 (T018a) canonical context source. Identifies the
     *   receive surface that originated this call. Recognised values:
     *     'scan' | 'manual' | 'sse' | 'catchup' | 'cashback' | 'gift_link' | 'gift_link_reclaim' | 'escrow_recovery' | 'dm-poll'
     *     | 'receive-screen' | 'unknown'
     *   The string is plumbed verbatim onto the `ctx.source` field passed to
     *   `_persistRedeemed`. Downstream tightenings (spec-039 US 1 T030
     *   inspect-before-save gate; future ctx-sensitive hooks) key on this
     *   value. Legacy callers passing `'dm-poll'` / `'receive-screen'` keep
     *   their existing semantics; new callers SHOULD pass one of the
     *   spec-039 canonical values.
     * @returns {Promise<Object>} The saved voucher object
     * @throws {Error} If redemption fails
     */
    async redeem(token, options = {}) {
        const { source = 'unknown' } = options;

        console.log('[tokenRedemption] Starting redemption, token length:', token?.length, 'source:', source);

        // Validate token
        if (!token) {
            throw new Error('No token provided');
        }

        // OWASP A10: Validate token size limits to prevent DoS
        if (typeof TokenSecurity !== 'undefined' && TokenSecurity.validateTokenLimits) {
            const validation = TokenSecurity.validateTokenLimits(token);
            if (!validation.valid) {
                console.error('[tokenRedemption] Token rejected:', validation.error);
                throw new Error(validation.error || 'Token validation failed');
            }
            console.log('[tokenRedemption] Token size valid:', validation.size, 'bytes,', validation.proofCount, 'proofs');
        }

        // Canonicalize the token bytes BEFORE fingerprinting so different
        // wrappers (cashuB vs cashuA, whitespace variants) of the same
        // underlying token hash to the same key and share the same
        // in-flight promise.
        token = this.normalizeToken(token);
        token = await this.convertToCashuA(token);

        // Compute fingerprint — used both as the single-flight key and
        // (downstream) as the duplicate-detection / idempotency-key seed.
        let fingerprint = null;
        if (typeof TokenSecurity !== 'undefined' && TokenSecurity.getFingerprint) {
            try {
                fingerprint = await TokenSecurity.getFingerprint(token);
                console.log('[tokenRedemption] Token fingerprint:', fingerprint.substring(0, 16) + '...');
            } catch (e) {
                console.warn('[tokenRedemption] Fingerprint computation failed:', e);
            }
        }
        // #110 review: never key a receive, a cross-tab claim or the in-flight
        // join on TokenSecurity's `fallback_<prefix>_<len>` fingerprint. Two
        // different tokens can share it, and the gateway would replay one's
        // settled result for the other. Replace it with a real SHA-256 of the
        // whole token, or go without (no key, no join) if that is unavailable.
        if (fingerprint && !_isStrongFingerprint(fingerprint)) {
            fingerprint = await _sha256Hex(token);
            console.warn('[tokenRedemption] weak fingerprint replaced', { strong: !!fingerprint });
        }

        // Single-flight join. If another concurrent caller is already
        // redeeming this exact token (e.g., dmPoll started 50ms before
        // the page's auto-redemption pipeline fired on the same token),
        // share their promise — both callers observe the same successful
        // result, and the mint only sees one swap.
        if (fingerprint) {
            const existing = this._inFlightRedemptions.get(fingerprint);
            if (existing) {
                console.log(`[tokenRedemption] Joining in-flight redemption fp=${fingerprint.slice(0, 8)}... source=${source}`);
                return await existing;
            }
        }

        // Cross-tab + sequential-retry protection. The in-memory
        // single-flight above only covers same-tab concurrent callers; a
        // second tab (or the same tab after a refresh/sync replay) hits
        // a fresh in-memory map and would otherwise re-attempt the swap.
        // The localStorage claim layer catches those:
        //   - status='done' → another tab already redeemed; short-circuit
        //   - status='in_progress' by another tab → wait for them
        //   - else → acquire our own claim and proceed
        if (fingerprint) {
            const existingClaim = this._localClaim.read(fingerprint);
            if (existingClaim) {
                if (existingClaim.status === 'done') {
                    console.log(`[tokenRedemption] Cross-tab claim shows DONE fp=${fingerprint.slice(0, 8)}... voucherId=${existingClaim.voucherId} — short-circuit`);
                    // Spec 022 — prefer the spec-017 content-derived
                    // `tokenId` from the done marker; fall back to the
                    // legacy `voucherId` if a pre-spec-022 marker is
                    // still in storage.
                    const local = this._lookupLocalVoucher(existingClaim.tokenId || existingClaim.voucherId);
                    if (local) return this._markAlreadyReceived(local);
                    // Claim says done but the voucher row isn't in this
                    // tab's storage yet (cross-device case; sync hasn't
                    // pulled it). Don't re-attempt the mint swap —
                    // proofs are burned. Throw a recognisable error so
                    // the caller can wait for sync or fetch from the
                    // backend's NIP-60 mirror.
                    throw new Error('This voucher was already redeemed in another session');
                }
                if (existingClaim.status === 'in_progress' && existingClaim.tabId !== this._tabId) {
                    console.log(`[tokenRedemption] Another tab redeeming fp=${fingerprint.slice(0, 8)}... — awaiting (tab=${existingClaim.tabId})`);
                    // Spec 022 T015 — waitForDone now defaults to
                    // IN_PROGRESS_TTL_MS (60s), aligned with the
                    // claim's in-progress TTL.
                    const finalClaim = await this._localClaim.waitForDone(fingerprint);
                    if (finalClaim.status === 'done') {
                        const local = this._lookupLocalVoucher(finalClaim.tokenId || finalClaim.voucherId);
                        if (local) return this._markAlreadyReceived(local);
                        throw new Error('This voucher was already redeemed in another session');
                    }
                    // 'stale' (holder died) or 'timeout' — fall through
                    // and try ourselves. The holder's claim is stale so
                    // tryAcquire below will overwrite it.
                    console.log(`[tokenRedemption] Other tab's claim ${finalClaim.status} — taking over fp=${fingerprint.slice(0, 8)}...`);
                }
            }
        }

        // Spec 022 — the critical section (acquire claim → _doRedeem →
        // markDone) is now wrapped in `WebLockClaim.withLock` when the
        // Web Locks API is available. The lock provides atomic cross-tab
        // serialization that the localStorage CAS approximation cannot.
        //
        // When Web Locks is unavailable (older Safari, embedded webviews),
        // `WebLockClaim.withLock` runs the callback directly and the
        // existing localStorage tryAcquire/waitForDone/retry logic INSIDE
        // the callback provides best-effort coordination. The `done`
        // marker stays in localStorage either way as the sync-convergence
        // hint for other tabs that can short-circuit without taking the
        // lock.
        const tabId = this._tabId;
        const self = this;

        const criticalSection = async () => {
            // Re-check the done marker INSIDE the lock — another tab may
            // have finished while we waited in the lock queue. This is
            // the property the bare-localStorage path COULDN'T provide.
            if (fingerprint) {
                const reClaim = self._localClaim.read(fingerprint);
                if (reClaim && reClaim.status === 'done') {
                    const local = self._lookupLocalVoucher(reClaim.tokenId || reClaim.voucherId);
                    if (local) return self._markAlreadyReceived(local);
                    throw new Error('This voucher was already redeemed in another session');
                }
            }

            // Acquire the localStorage claim for bookkeeping. Under Web
            // Lock, this is informational (the real serialization is
            // the lock itself); without Web Lock, it's the primary
            // coordination mechanism and the wait/retry path below
            // handles contention.
            let claimAcquired = false;
            if (fingerprint) {
                const acq = self._localClaim.tryAcquire(fingerprint, tabId);
                if (!acq.claimed) {
                    if (acq.existing && acq.existing.status === 'done') {
                        const local = self._lookupLocalVoucher(acq.existing.tokenId || acq.existing.voucherId);
                        if (local) return self._markAlreadyReceived(local);
                        throw new Error('This voucher was already redeemed in another session');
                    }
                    if (acq.existing && acq.existing.status === 'in_progress') {
                        // Spec 022 T015 — waitForDone now defaults to
                        // IN_PROGRESS_TTL_MS (60s), aligned with the
                        // claim's stale window. If the wait returns
                        // 'done', short-circuit. Otherwise (stale or
                        // true timeout), re-attempt the acquire.
                        const finalClaim = await self._localClaim.waitForDone(fingerprint);
                        if (finalClaim.status === 'done') {
                            const local = self._lookupLocalVoucher(finalClaim.tokenId || finalClaim.voucherId);
                            if (local) return self._markAlreadyReceived(local);
                            throw new Error('This voucher was already redeemed in another session');
                        }
                        // Stale / timeout — re-attempt tryAcquire. If
                        // it succeeds, the holder's claim was stale
                        // and we now own it; proceed. If it ALSO
                        // fails, the holder is still alive after 60s
                        // — throw RedemptionClaimContendedError so the
                        // caller can back off instead of racing the
                        // holder to the mint (FR-005).
                        const retry = self._localClaim.tryAcquire(fingerprint, tabId);
                        if (!retry.claimed) {
                            // Final done check: another tab may have
                            // finished between waitForDone returning
                            // and our retry.
                            if (retry.existing && retry.existing.status === 'done') {
                                const local = self._lookupLocalVoucher(retry.existing.tokenId || retry.existing.voucherId);
                                if (local) return self._markAlreadyReceived(local);
                            }
                            throw new RedemptionClaimContendedError(fingerprint);
                        }
                        claimAcquired = true;
                    }
                } else {
                    claimAcquired = true;
                }
            }

            try {
                const voucher = await self._doRedeem(token, { ...options, fingerprint });
                if (voucher && voucher.saveError) {
                    if (claimAcquired && fingerprint) {
                        self._localClaim.release(fingerprint, tabId);
                    }
                    try {
                        const integration = (typeof window !== 'undefined') && window.PaymentReceiptIntegration;
                        if (integration && typeof integration._breadcrumb === 'function') {
                            integration._breadcrumb('redemption-save-error', {
                                receiveId: voucher.receiveId,
                                source,
                            });
                        }
                    } catch (_) { /* swallow */ }
                    throw new RedemptionSaveError(voucher.receiveId, null);
                }
                if (claimAcquired && fingerprint && voucher && voucher.voucher_id) {
                    self._localClaim.markDone(
                        fingerprint, tabId, voucher.voucher_id, voucher.token_id || null,
                    );
                    // Spec 022 T018 — once-per-session adoption signal.
                    // Confirms the new claim shape (token_id-keyed) is
                    // live on the user's device. Operators grep
                    // `event=claim-token-id-key` to size rollout
                    // coverage.
                    if (voucher.token_id) {
                        self._maybeEmitTokenIdKeyBreadcrumb();
                    }
                }
                return voucher;
            } catch (e) {
                if (claimAcquired && fingerprint && _isPreSwapError(e)) {
                    self._localClaim.release(fingerprint, tabId);
                }
                throw e;
            }
        };

        // Branch on Web Lock support. Emit a one-time breadcrumb when
        // we fall back to the localStorage path so ops can size the
        // older-browser population (FR-004 + SC-006).
        const useWebLock = fingerprint &&
            typeof window !== 'undefined' &&
            window.WebLockClaim &&
            window.WebLockClaim.isSupported();
        if (!useWebLock && fingerprint) {
            this._maybeEmitWebLockFallbackBreadcrumb();
        }

        const promise = (async () => {
            try {
                if (useWebLock) {
                    try {
                        // Spec 022 T016 — cap the queue wait at the
                        // claim's in-progress TTL. A slow holder past
                        // that window is treated the same way as the
                        // localStorage fallback's wait-then-throw
                        // path: bail with RedemptionClaimContendedError
                        // so the caller backs off instead of racing
                        // the holder to the mint.
                        return await window.WebLockClaim.withLock(
                            'imani_redeem_claim:' + fingerprint,
                            criticalSection,
                            { timeoutMs: this._localClaim.IN_PROGRESS_TTL_MS },
                        );
                    } catch (err) {
                        if (err && err.name === 'WebLockTimeoutError') {
                            throw new RedemptionClaimContendedError(fingerprint);
                        }
                        throw err;
                    }
                }
                return await criticalSection();
            } finally {
                if (fingerprint) {
                    this._inFlightRedemptions.delete(fingerprint);
                }
            }
        })();
        if (fingerprint) {
            this._inFlightRedemptions.set(fingerprint, promise);
        }
        return await promise;
    },

    // Spec 022 T012 — fire the `claim-web-lock-fallback` breadcrumb at
    // most once per session when the Web Locks API is unavailable.
    // Dedup via a module-scope flag on the TokenRedemption object so
    // unit tests can reset it via `_resetWebLockFallbackBreadcrumb`.
    _webLockFallbackBreadcrumbFired: false,
    _maybeEmitWebLockFallbackBreadcrumb() {
        if (this._webLockFallbackBreadcrumbFired) return;
        this._webLockFallbackBreadcrumbFired = true;
        try {
            const integration = (typeof window !== 'undefined') && window.PaymentReceiptIntegration;
            if (integration && typeof integration._breadcrumb === 'function') {
                integration._breadcrumb('claim-web-lock-fallback', {});
            }
        } catch (_) { /* swallow */ }
    },
    _resetWebLockFallbackBreadcrumb() {
        this._webLockFallbackBreadcrumbFired = false;
    },

    // Spec 022 T018 — once-per-session adoption signal. Emits
    // `event=claim-token-id-key` the first time a tokenId-keyed
    // `done` marker is written, so operators can confirm rollout
    // reached production. Dedup via module-scope flag.
    _tokenIdKeyBreadcrumbFired: false,
    _maybeEmitTokenIdKeyBreadcrumb() {
        if (this._tokenIdKeyBreadcrumbFired) return;
        this._tokenIdKeyBreadcrumbFired = true;
        try {
            const integration = (typeof window !== 'undefined') && window.PaymentReceiptIntegration;
            if (integration && typeof integration._breadcrumb === 'function') {
                integration._breadcrumb('claim-token-id-key', {});
            }
        } catch (_) { /* swallow */ }
    },
    _resetTokenIdKeyBreadcrumb() {
        this._tokenIdKeyBreadcrumbFired = false;
    },

    /**
     * Look up a saved voucher row by its voucher_id. Used by the cross-
     * tab claim layer when another tab marked a redemption as done and
     * this tab needs to return the local row. Returns null if not found.
     */
    _lookupLocalVoucher(voucherId) {
        if (!voucherId) return null;
        try {
            if (typeof getVoucher === 'function') {
                const v = getVoucher(voucherId);
                if (v) return v;
            }
        } catch (_) { /* swallow */ }
        return null;
    },

    // Spec 035 post-merge hotfix iter 4 (2026-05-29) — opt-in marker for
    // the duplicate-receive UX. When redeem() short-circuits via a
    // done-claim and returns the cached voucher row, the caller needs to
    // distinguish that from a fresh redemption.
    //
    // We CAN'T mutate the returned row (it's the live in-memory IDB
    // cache — see walletStorageIntegration.getVouchers returning
    // STATE.cache.vouchers.data) and we CAN'T clone it (spec-022 tests
    // pin strict reference equality `result === localVoucher`). A
    // WeakSet keyed on the row gives us a non-intrusive side channel:
    // `_markAlreadyReceived(row)` records the marker; `isAlreadyReceived(row)`
    // queries it. The cached row stays pristine; the marker is GC'd
    // when no one else holds the row.
    _alreadyReceivedSet: new WeakSet(),
    _markAlreadyReceived(voucher) {
        if (voucher && typeof voucher === 'object') {
            try { this._alreadyReceivedSet.add(voucher); } catch (_) { /* swallow */ }
        }
        return voucher;
    },
    isAlreadyReceived(voucher) {
        if (!voucher || typeof voucher !== 'object') return false;
        try { return this._alreadyReceivedSet.has(voucher); } catch (_) { return false; }
    },

    /**
     * The actual redemption pipeline. Wrapped by `redeem()`'s single-flight
     * dispatcher above; callers should NOT invoke this directly — going
     * through `redeem()` ensures concurrent paths share the same promise
     * instead of racing to the mint.
     *
     * @param {string} token - normalized cashuA token bytes (canonicalized by `redeem()`)
     * @param {Object} options - same options as `redeem()`, plus `fingerprint`
     * @returns {Promise<Object>} The saved voucher object
     * @private
     */
    async _doRedeem(token, options = {}) {
        const {
            metadata = {},
            nip60Wallet = null,
            skipDuplicateCheck = false,
            source = 'unknown',
            userPubkeyHex = null,
            fingerprint = null,
        } = options;

        try {
            // Check for duplicates (unless skipped for auto-redeem)
            if (!skipDuplicateCheck) {
                // Use async fingerprint check if available
                if (typeof hasTokenBeenReceivedAsync === 'function') {
                    if (await hasTokenBeenReceivedAsync(token)) {
                        throw new Error('You have already received this voucher');
                    }
                } else if (typeof hasTokenBeenReceived === 'function' && hasTokenBeenReceived(token)) {
                    throw new Error('You have already received this voucher');
                }
            }

            // Fetch token metadata from API (for MINIMAL backing info)
            let apiMetadata = null;
            try {
                if (typeof api !== 'undefined' && api.getTokenMetadata) {
                    apiMetadata = await _withStepTimeout(
                        api.getTokenMetadata(token), this._stepTimeoutMs, 'getTokenMetadata', fingerprint);
                }
            } catch (e) {
                console.log('[tokenRedemption] Could not fetch token metadata:', e.message);
            }

            // Lazy inspect — fires when the DM payload and metadata endpoint
            // failed to supply a face_unit OR when neither carries an expiry.
            // The cashu token's embedded SignedVoucher metadata is the only
            // authoritative source for the original voucher's expires_at; the
            // /receive response doesn't carry it (gateway DTO has no field for
            // it, see incident 2026-05-03), and the DM regex parser doesn't
            // extract it from the JSON form. Without inspecting, the recipient
            // wallet ends up reading the server-side ReceiveEscrow's 30-day
            // TTL instead — vouchers visibly "reset" to receive-time + 30d.
            // See contracts/token-transfer-dm.schema.md §2.
            //
            // Spec 039 US 1 (T030) — inspect-before-save is now a HARD
            // precondition for QR/manual-paste receive paths. The gate
            // fires BEFORE `api.receive` so a fail-closed verification
            // doesn't burn the proofs at the mint.
            //
            // - ctx.source in {scan, manual}: REQUIRED, fail-closed.
            //   Non-2xx / network error / missing expiry_verification /
            //   "unverified" → throw ProvenanceVerificationError.
            // - Other sources (sse, catchup, cashback, escrow_recovery,
            //   dm-poll, receive-screen, unknown): keep the pre-spec-039
            //   opportunistic behaviour — call inspect only when the
            //   currency/expiry chain needs the fallback; swallow errors.
            //   Their provenance was either already verified upstream
            //   (spec-038 FR-020 swap_proof_ids for sse/catchup) or
            //   they're recovering pre-existing rows (cashback /
            //   escrow_recovery), so fail-closed here would block valid
            //   flows.
            let inspectResult = null;
            const __isFailClosedSource =
                source === 'scan' || source === 'manual';
            if (__isFailClosedSource) {
                if (typeof api === 'undefined' || typeof api.inspectVoucher !== 'function') {
                    throw new ProvenanceVerificationError(
                        'Voucher could not be verified — gateway unavailable. Please try again in a moment.',
                        { inspect_failure_reason: 'INSPECT_API_UNAVAILABLE' }
                    );
                }
                try {
                    inspectResult = await _withStepTimeout(
                        api.inspectVoucher(token), this._stepTimeoutMs, 'inspectVoucher', fingerprint);
                } catch (e) {
                    console.warn('[tokenRedemption] inspect-before-save failed (fail-closed):', e?.message);
                    throw new ProvenanceVerificationError(
                        'Voucher could not be verified. Please check your connection and try again.',
                        { cause: e, inspect_failure_reason: 'INSPECT_CALL_THREW' }
                    );
                }
                if (!inspectResult || typeof inspectResult !== 'object') {
                    throw new ProvenanceVerificationError(
                        'Voucher could not be verified. Please try again — or contact support if this keeps happening.',
                        { inspect_failure_reason: 'INSPECT_EMPTY_RESPONSE' }
                    );
                }
                const __expVer = inspectResult.expiry_verification;
                if (__expVer !== 'verified-with-expiry' && __expVer !== 'verified-no-expiry') {
                    // Includes "unverified", missing field (older gateway),
                    // or any unrecognised value.
                    //
                    // Copilot review on PR #301, comment 3339731872 —
                    // `inspect_failure_reason` is a STABLE code so
                    // downstream metrics / dashboards can aggregate
                    // reliably; the dynamic gateway value moves to
                    // `inspect_failure_detail`. Aggregators bucket by
                    // reason; debuggers read the detail.
                    throw new ProvenanceVerificationError(
                        'Voucher could not be verified. Please try again — or contact support if this keeps happening.',
                        {
                            inspect_failure_reason: 'INSPECT_NOT_VERIFIED',
                            inspect_failure_detail: __expVer ?? 'missing',
                        }
                    );
                }
                console.log('[tokenRedemption] inspect-before-save verified:', __expVer, 'source:', source);
            } else {
                const __faceUnitMissing =
                    !__currencyApi.normalizeFaceUnit(metadata?.face_unit) &&
                    !__currencyApi.normalizeFaceUnit(apiMetadata?.face_unit);
                const __expiresMissing =
                    !metadata?.expires_at && !apiMetadata?.expires_at;
                const __needInspect = __faceUnitMissing || __expiresMissing;
                if (__needInspect) {
                    try {
                        if (typeof api !== 'undefined' && typeof api.inspectVoucher === 'function') {
                            inspectResult = await _withStepTimeout(
                                api.inspectVoucher(token), this._stepTimeoutMs, 'inspectVoucher', fingerprint);
                        }
                    } catch (e) {
                        console.warn('[tokenRedemption] inspectVoucher failed, continuing with fallback chain:', e?.message);
                    }
                }
            }

            // #110: the key is a pure function of the token's fingerprint, so a
            // retry of the same token (dm-poll's failed tracker, a second
            // delivery, the rate-limit wrapper re-running redeem()) reaches the
            // gateway under the SAME key and is answered with the first call's
            // settled result instead of re-swapping already-spent proofs. The
            // old `generateIdempotencyKey` appended a random suffix, which made
            // every attempt a fresh receive — the €100 lost on staging.
            //
            // Only from a real SHA-256 fingerprint (`_receiveKeyFor`): a weak
            // one sends no key at all, since a shared key would make the
            // gateway answer one token with another's proofs.
            const idempotencyKey = _receiveKeyFor(fingerprint);
            // Held BEFORE the call: if this wallet already has a receive_id for
            // the token, an "already spent" from the mint is our own settled
            // swap coming back, not someone else's spend.
            //
            // #110 review A: only a 'settled' entry (swapped, NOT saved) means
            // that. A 'saved' or 'acked' entry is a coupon this wallet already
            // holds: a redelivery of it is the old idempotent "already
            // redeemed" success, never a reported loss, and needs no call.
            const knownEntry = ReceiveLedger.entryFor(fingerprint);
            if (knownEntry && (knownEntry.state === 'saved' || knownEntry.state === 'acked')) {
                console.info('[tokenRedemption] token already saved in this wallet — idempotent', {
                    fp: _fpTag(fingerprint), receiveId: knownEntry.receiveId,
                });
                throw _alreadyRedeemedHere();
            }
            const knownReceiveId = knownEntry ? knownEntry.receiveId : null;
            console.info('[tokenRedemption] receive start', {
                fp: _fpTag(fingerprint), source, knownReceiveId,
            });

            // Call API to receive/redeem the token with idempotency key.
            // Spec 038 T018: wrap with FR-016 transient-error retry (3 attempts at
            // 1s/4s/15s) via the @imani/dm-poll retry helper. Terminal errors
            // (already_spent, 4xx auth, 4xx request) propagate immediately;
            // transient ones (network, 5xx) retry up to the budget.
            let result;
            try {
                // #110 review C: every api.receive for this token, across all
                // retry layers, spends from one bounded per-token budget.
                const budgetKey = fingerprint || token;
                const receiveOnce = async () => {
                    if (!this._takeReceiveCall(budgetKey)) {
                        const deferred = new Error('Receive call budget for this token is spent; a later poll will retry');
                        // Quiet, retryable non-success in dm-poll (isDeferredError).
                        deferred.code = 'RECEIVE_DEFERRED';
                        throw deferred;
                    }
                    // Paced per CALL (dmPoll installs the page's pacer here),
                    // so inner retries spend from the same budget as first tries.
                    // #300: a gate that never frees a slot used to hang the
                    // redemption (and, through _inFlightRedemptions, every
                    // later attempt at this token) for the whole session.
                    // #301 review: the signal tells the pacer this wait was
                    // abandoned, so it does not book a slot for a call that
                    // will never go out (a ghost slot delays every later call).
                    const gateAbort = typeof AbortController === 'function' ? new AbortController() : null;
                    try {
                        await _withStepTimeout(
                            this._receiveGate(gateAbort ? gateAbort.signal : undefined),
                            this._receiveGateTimeoutMs, 'receiveGate', fingerprint);
                    } catch (gateErr) {
                        if (gateErr && gateErr.code === 'STEP_TIMEOUT') {
                            if (gateAbort) gateAbort.abort(gateErr);
                            this._releaseReceiveCall(budgetKey);
                            const deferred = new Error('Receive pacer did not free a slot in time; a later poll will retry');
                            deferred.code = 'RECEIVE_DEFERRED';
                            // Lets dmPoll schedule the retry: in SSE mode nothing
                            // re-polls on a timer, so "the next poll" could be the
                            // stream's ten-minute redial.
                            deferred.deferredBy = 'receive-gate-timeout';
                            throw deferred;
                        }
                        throw gateErr;
                    }
                    // #301 review: api.receive is deliberately NOT timed out. A
                    // receive that reached the gateway may have settled, and a
                    // retry under the same key comes back as a token-less replay
                    // ("settled, not saved"), not as the coupon. It is only
                    // reported, so the next #300-shaped stall names its step.
                    console.info('[tokenRedemption] receive gate passed', { fp: _fpTag(fingerprint) });
                    const slow = this._receiveSlowWarnMs > 0 ? setTimeout(() => {
                        console.warn('[tokenRedemption] #300 api.receive still pending', {
                            fp: _fpTag(fingerprint), afterMs: this._receiveSlowWarnMs,
                        });
                    }, this._receiveSlowWarnMs) : null;
                    try {
                        return await api.receive(token, { idempotencyKey });
                    } finally {
                        if (slow) clearTimeout(slow);
                    }
                };
                // #314: the NIP-98 header is signed inside api.receive
                // (api.js requestWithHeaders), per call, AFTER the gate above:
                // a wait in the pacer never ages the signature. A call that
                // then sat in transit past gateway-customer's 60 s window is
                // refused at auth, before anything is received. One more call,
                // through the same gate and per-token budget, signs afresh and
                // carries the SAME idempotency key (`idempotencyKey` above is
                // fixed for this token), so the gateway sees one receive.
                const receiveSigned = async () => {
                    for (let resign = 0; ; resign++) {
                        try {
                            return await receiveOnce();
                        } catch (authErr) {
                            if (!_isStaleNip98Auth(authErr) || resign >= STALE_AUTH_RESIGNS) throw authErr;
                            console.warn('[tokenRedemption] #314 receive auth expired in transit; signing again', {
                                fp: _fpTag(fingerprint),
                            });
                        }
                    }
                };
                // #110 review D: the gateway's 409 "first call still in flight"
                // (Retry-After, empty body) is a short wait and a retry under
                // the same key, not a failure.
                for (let inFlight = 0; ; inFlight++) {
                    try {
                        result = await _withReceiveRetry(receiveSigned);
                        break;
                    } catch (e) {
                        if (!_isInFlightConflict(e) || inFlight >= IN_FLIGHT_RETRIES) throw e;
                        const wait = Math.min(Math.max(e.retryAfterMs, 0), IN_FLIGHT_MAX_WAIT_MS);
                        console.info('[tokenRedemption] receive in flight at the gateway — waiting', {
                            fp: _fpTag(fingerprint), waitMs: wait,
                        });
                        await this._inFlightSleep(wait);
                    }
                }
            } catch (receiveErr) {
                // #110: the gateway (or, on an older gateway, the mint) says
                // this token's receive already settled. Terminal for
                // re-swapping, but NOT a success: this wallet does not hold the
                // value, so it surfaces as "settled, not saved" for
                // reconciliation and is never acked from here.
                if (_isAlreadySettledReceive(receiveErr, knownReceiveId)) {
                    const settledId = _settledReceiveIdFrom(receiveErr) || knownReceiveId;
                    ReceiveLedger.recordSettled(settledId, fingerprint);
                    console.error('[tokenRedemption] receive settled at the gateway, not saved here — needs reconciliation', {
                        fp: _fpTag(fingerprint), receiveId: settledId,
                        status: receiveErr && receiveErr.status, code: receiveErr && receiveErr.code,
                    });
                    throw new ReceiveSettledNotSavedError(settledId, 'already-settled', receiveErr);
                }
                console.warn('[tokenRedemption] receive failed', {
                    fp: _fpTag(fingerprint),
                    status: receiveErr && receiveErr.status,
                    code: receiveErr && receiveErr.code,
                    message: receiveErr && receiveErr.message,
                });
                throw receiveErr;
            }

            if (!result || result.error) {
                throw new Error(result?.error || 'Failed to receive voucher');
            }

            // The swap is done. Record it as 'settled' BEFORE anything that can
            // fail, so a retry recognises the token as ours. 'settled' is never
            // acknowledged: the ack is owed only once the save succeeds
            // (`_persistRedeemed` moves it to 'saved').
            const settledReceiveId = result.receive_id || result.receiveId || null;
            {
                ReceiveLedger.recordSettled(settledReceiveId, fingerprint);
                console.info('[tokenRedemption] receive settled', {
                    fp: _fpTag(fingerprint), receiveId: settledReceiveId,
                    replay: result.idempotent_replay === true || result.replayed === true || undefined,
                });
            }

            // #110 review (BLOCKER): the gateway's same-key replay answers 200
            // with `token: null` ("Receive: repeats"). buildVoucher falls back
            // to the INPUT token (`result.token || token`), which is already
            // spent, so saving it would show a balance with nothing behind it.
            // A receive_id with no fresh token is a settled receive whose
            // proofs this wallet does not have: never saved, never acked.
            //
            if (!result.token && !result.change_token && settledReceiveId) {
                console.error('[tokenRedemption] receive replayed without a fresh token — not saved, needs reconciliation', {
                    fp: _fpTag(fingerprint), receiveId: settledReceiveId,
                });
                throw new ReceiveSettledNotSavedError(settledReceiveId, 'replay-without-token');
            }

            // Check for already-redeemed token. BEFORE the no-fresh-token
            // guard below: a duplicate response carries no token either, and
            // it must keep its "already redeemed" wording so dm-poll takes the
            // idempotent path (#111 delta review) instead of a retried failure.
            const duplicateCount = result.duplicate_count ?? result.duplicateCount ?? 0;
            const importedCount = result.imported_count ?? result.importedCount ?? 0;

            if (duplicateCount > 0 && importedCount === 0) {
                throw new Error('This token has already been redeemed');
            }

            if (result.amount === 0 && importedCount === 0) {
                throw new Error('This token has no value or was already redeemed');
            }

            // #110 second review B: unconditional. Any other result with no
            // fresh token is never saved; there is nothing to keep, and with
            // no receive_id nothing to reconcile, so it is an ordinary
            // (non-success) failure.
            if (!result.token && !result.change_token) {
                console.error('[tokenRedemption] receive returned no fresh token — nothing saved', {
                    fp: _fpTag(fingerprint),
                });
                throw new Error('Receive returned no fresh token; nothing was saved');
            }

            const receivedAmount = result.amount || result.balance || 0;

            // Check if this is a self-issued token that should be burned
            const effectiveIssuerId = metadata?.issuer_id ?? result.issuer_id ?? apiMetadata?.issuer_id ?? inspectResult?.issuer_id ?? null;
            if (typeof isSelfIssuedToken === 'function' && isSelfIssuedToken(effectiveIssuerId, userPubkeyHex)) {
                console.log('[tokenRedemption] Self-issued token detected — burning');
                return await this.burn(token, result, { metadata, apiMetadata, inspectResult, nip60Wallet, fingerprint });
            }

            // Warm the merchant-profile cache so buildVoucher can resolve the
            // issuance_ratio (and face metadata) for a merchant the recipient
            // has NEVER interacted with. buildVoucher only reads the SYNC cache
            // (getCachedMerchantProfile); without this fetch a scanned/received
            // voucher from a first-time merchant has no ratio → it can't derive
            // the current face value (token_amount × ratio) and falls back to
            // the original/sats amount — the "25 XAF credited as 5000" bug.
            // Non-fatal and skipped when already cached. api.getMerchantProfile
            // caches via setCachedMerchantProfile, which is the cache buildVoucher
            // reads on the next line.
            if (effectiveIssuerId
                && typeof api !== 'undefined' && typeof api.getMerchantProfile === 'function'
                && (typeof getCachedMerchantProfile !== 'function' || !getCachedMerchantProfile(effectiveIssuerId))) {
                try {
                    await api.getMerchantProfile(effectiveIssuerId);
                } catch (_e) {
                    console.warn('[tokenRedemption] merchant profile warm-fetch failed (non-fatal):', _e?.message);
                }
            }

            // Build voucher with the four-step currency-resolution chain.
            // Spec 039 (T031) — inspectIsAuthoritative=true causes
            // buildVoucher to flip the merge precedence so inspect wins
            // over token-embedded metadata for the fields listed in
            // FR-008/009 (issuer_id, merchant_metadata, face_decimals,
            // backing_strategy, issuance_ratio; expires_at gated on
            // expiry_verification === 'verified-with-expiry').
            const __inspectIsAuthoritative = __isFailClosedSource;
            const voucher = this.buildVoucher(
                token, result, metadata, apiMetadata, receivedAmount, inspectResult,
                { inspectIsAuthoritative: __inspectIsAuthoritative }
            );

            // Extract escrow receive ID for acknowledgement after save
            const receiveId = result.receive_id || result.receiveId;

            // Handle change token consolidation for MINIMAL strategy
            if (result.change_token) {
                console.log('[tokenRedemption] Received change token, consolidating...');
                const consolidated = this.consolidateVoucher(result, voucher);
                return await this._persistRedeemed(consolidated, {
                    receiveId, token, metadata, nip60Wallet, source,
                });
            }

            const persisted = await this._persistRedeemed(voucher, {
                receiveId, token, metadata, nip60Wallet, source,
            });
            if (!persisted.saveError) {
                console.log('[tokenRedemption] Redemption complete:', persisted.voucher_id);
            }
            return persisted;
        } finally {
            // Single-flight handles lock semantics now (the in-flight map
            // entry is cleared by `redeem()`'s wrapping promise.finally);
            // no per-call lock to release here.
        }
    },

    /**
     * Burn a self-issued token: consume proofs at mint but don't save to wallet.
     * Records the burn in transaction history for audit purposes.
     *
     * @param {string} token - The original token string
     * @param {Object} result - The api.receive() result (proofs already consumed)
     * @param {Object} opts - { metadata, apiMetadata, nip60Wallet, fingerprint }
     * @returns {Object} A voucher-shaped payment record with status 'payment'
     */
    async burn(token, result, opts = {}) {
        const { metadata = {}, apiMetadata = null, nip60Wallet = null, fingerprint = null } = opts;
        const receivedAmount = result.amount || result.balance || 0;

        // Build a voucher-shaped record for audit (NOT saved to wallet).
        // Same resolution chain as buildVoucher — see contracts §2.
        const { faceUnit: unit, source } = __currencyApi.resolveFaceUnit({
            dmMetadata: metadata,
            getTokenMetadataResult: apiMetadata,
            inspectResult: opts.inspectResult ?? null,
            receiveResult: result,
        });
        const resolvedAt = unit === __currencyApi.UNKNOWN ? null : new Date().toISOString();

        const burnRecord = {
            voucher_id: result.voucher_id || result.id || crypto.randomUUID(),
            token: null, // Don't store token — proofs are destroyed
            face_value: metadata?.face_value ?? apiMetadata?.face_value ?? result.face_value ?? receivedAmount,
            face_unit: unit,
            face_unit_source: source,
            face_unit_resolved_at: resolvedAt,
            face_decimals: metadata?.face_decimals ?? apiMetadata?.face_decimals ?? result.face_decimals ?? resolveDecimals(unit),
            token_amount: result.token_amount ?? metadata?.token_amount ?? apiMetadata?.token_amount ?? receivedAmount,
            token_unit: result.unit || 'sat',
            issuer_id: metadata?.issuer_id ?? result.issuer_id ?? null,
            memo: metadata?.memo || apiMetadata?.memo || result.memo || null,
            status: 'payment',
            created_at: new Date().toISOString(),
            received_via: metadata?.received_via || 'manual',
            sender_pubkey: metadata?.sender_pubkey || null
        };

        // Acknowledge escrow (proofs consumed, release backend hold)
        const receiveId = result.receive_id || result.receiveId;
        // #110: a burn keeps nothing by design, so the burn itself is "done".
        ReceiveLedger.recordSaved(receiveId, fingerprint);
        await this._acknowledgeEscrow(receiveId);

        // Mark token as received (fingerprint duplicate prevention)
        if (typeof markTokenAsReceivedAsync === 'function') {
            await markTokenAsReceivedAsync(token);
        } else if (typeof markTokenAsReceived === 'function') {
            markTokenAsReceived(token);
        }

        // Record payment to NIP-60 history
        await this.recordPaymentNip60Transaction(burnRecord, metadata, nip60Wallet);

        // Record payment to local transaction history
        this.recordLocalPaymentTransaction(burnRecord, metadata);

        console.log('[tokenRedemption] Payment complete:', burnRecord.voucher_id);
        return burnRecord;
    },

    /**
     * Record a payment transaction to NIP-60 history
     */
    async recordPaymentNip60Transaction(burnRecord, metadata, nip60Wallet) {
        if (!nip60Wallet) return;

        try {
            const transaction = {
                txType: 'payment',
                direction: 'in',
                tokenAmount: burnRecord.token_amount || burnRecord.face_value,
                voucherId: burnRecord.voucher_id,
                faceValue: burnRecord.face_value,
                faceUnit: burnRecord.face_unit,
                faceDecimals: burnRecord.face_decimals,
                issuerId: burnRecord.issuer_id,
                counterparty: metadata?.sender_pubkey || null,
                memo: burnRecord.memo ? `[PAYMENT] ${burnRecord.memo}` : '[PAYMENT] Payment to merchant',
                timestamp: Math.floor(Date.now() / 1000),
                walletDTag: 'default'
            };

            await nip60Wallet.recordTransaction(transaction);
            console.log('[tokenRedemption] Payment transaction recorded to NIP-60 history');
        } catch (e) {
            console.warn('[tokenRedemption] Failed to record NIP-60 payment transaction:', e);
        }
    },

    /**
     * Record a payment transaction to local transaction history.
     * No-op: recording is handled by the voucher-received event handler
     * in home.js which writes to LocalTransactionStore for both payment
     * and received vouchers.
     */
    recordLocalPaymentTransaction(burnRecord, metadata) {
        // Intentionally empty — the voucher-received event dispatched by
        // dmPoll.broadcastBalanceUpdate() triggers LocalTransactionStore.record()
        // in home.js, which handles both payment and received vouchers.
        console.log('[tokenRedemption] Payment recorded via voucher-received event:', burnRecord.voucher_id);
    },

    /**
     * Spec 014: fire-and-forget delivery confirmation back to the original
     * sender. Called after a successful + durably-persisted redeem so the
     * sender's wallet renders a blue tick (FR-001..FR-003).
     *
     * Per FR-004, this MUST NOT throw — emit failures are logged inside
     * the integration; this wrapper additionally guards against the
     * integration not being loaded yet (e.g., on a page that hasn't run
     * init).
     */
    _emitPaymentReceipt(voucher, metadata) {
        // Fire a diagnostic breadcrumb at every reachable branch so the
        // server-side [receipt-diag] log shows the exact reason a redeem
        // didn't produce a receipt. Best-effort; never blocks.
        const _bc = (event, details) => {
            try {
                fetch('/api/v1/config/_diag/receipt-emit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ event, ...(details || {}), ts: Date.now() }),
                    keepalive: true,
                }).catch(() => {});
            } catch (_) { /* swallow */ }
        };
        try {
            const integration = (typeof window !== 'undefined') && window.PaymentReceiptIntegration;
            if (!integration || typeof integration.emit !== 'function') {
                _bc('redemption-emit-skip-no-integration', {
                    hasWindow: typeof window !== 'undefined',
                    hasIntegration: !!integration,
                });
                return;
            }
            const senderPubkey = metadata?.sender_pubkey;
            // Spec 020 — the receipt envelope's voucherId field MUST be the
            // delivery-correlation-id (DCI) so it matches the sender's local
            // tx row keyed by sent_voucher_id. The DCI is the SHA-256
            // fingerprint of the cashu token bytes (= spec 017's `token_id`,
            // already computed at storage time and surfaced on the voucher
            // row as `token_id`). Fall back to recomputing if `token_id`
            // isn't pre-stored, then to the old `voucher_id` chain as a
            // last resort for ancient rows.
            let voucherId = voucher?.token_id;
            if (!voucherId && voucher?.token &&
                    typeof window !== 'undefined' &&
                    window.TokenIdentity &&
                    typeof window.TokenIdentity.tokenIdSync === 'function') {
                try {
                    voucherId = window.TokenIdentity.tokenIdSync(voucher.token);
                } catch (e) {
                    // tokenIdSync rejects empty/null tokens; fall through.
                }
            }
            if (!voucherId) {
                voucherId = voucher?.voucher_id;
            }
            if (!senderPubkey || !voucherId) {
                _bc('redemption-emit-skip-missing-fields', {
                    hasSenderPubkey: !!senderPubkey,
                    hasVoucherId: !!voucherId,
                });
                return;
            }
            // Spec 033: best-effort cleartext hints for the sender's settlement
            // ("voucher_claimed") push body. face_value is stored in MINOR
            // units, so convert to the human-readable MAJOR-unit amount the
            // gateway formats. All hints are optional — on any gap the push
            // degrades to a generic body. Never let hint extraction throw.
            let faceValue, faceUnit, merchantName, merchantNip05;
            try {
                const fv = voucher?.face_value;
                const fd = Number(voucher?.face_decimals ?? 0);
                if (fv != null && !Number.isNaN(Number(fv))) {
                    faceValue = fd > 0 ? Number(fv) / Math.pow(10, fd) : Number(fv);
                }
                faceUnit = voucher?.face_unit || undefined;
                const mm = voucher?.merchant_metadata || {};
                merchantName = mm.merchant_name || undefined;
                // Spec 033 follow-up: resolve the merchant's nip05 for a
                // customer-friendly push body ("{name} ({nip05})"). merchant_metadata
                // carries the merchant pubkey (merchant_id) but not the nip05, so look
                // it up in the cached kind-0 profile; also backfill the display name
                // from the profile if the metadata lacked it. Best-effort — on a cache
                // miss the push degrades to name-only (then generic).
                merchantNip05 = mm.nip05 || undefined;
                if ((!merchantNip05 || !merchantName) && mm.merchant_id
                        && typeof getCachedProfile === 'function') {
                    try {
                        const prof = getCachedProfile(mm.merchant_id);
                        if (prof) {
                            merchantNip05 = merchantNip05 || prof.nip05 || undefined;
                            merchantName = merchantName
                                || prof.display_name || prof.displayName || prof.name || undefined;
                        }
                    } catch (_) { /* cache miss → omit nip05 */ }
                }
            } catch (_) { /* hints are best-effort; generic body otherwise */ }
            _bc('redemption-emit-call', { voucherId, senderPubkey });
            // Fire-and-forget; awaiting would couple redemption latency to
            // relay round-trip, which FR-004 explicitly forbids.
            integration.emit({ voucherId, senderPubkey, faceValue, faceUnit, merchantName, merchantNip05 });
        } catch (err) {
            // The integration's own error path already logs via [receipts];
            // this catch is for "the bridge object itself threw" (very rare).
            console.warn('[receipts] redemption-emit-skip', { error: err && err.message });
            _bc('redemption-emit-throw', { error: err && err.message ? String(err.message).slice(0, 200) : String(err).slice(0, 200) });
        }
    },

    /**
     * Normalize token input (trim, extract from URL if needed)
     */
    normalizeToken(raw) {
        if (!raw) return null;
        const trimmed = raw.trim();

        if (trimmed.startsWith('cashu') || trimmed.startsWith('eyJ')) {
            return trimmed;
        }

        // Try to extract token from URL
        try {
            const url = new URL(trimmed);
            const params = new URLSearchParams(url.search);
            return params.get('token') || trimmed;
        } catch (e) {
            return trimmed;
        }
    },

    /**
     * Process cashuB tokens.
     * Backend supports cashuB (V4 CBOR) natively, so no conversion needed.
     * Previously converted to cashuA but backend only accepts cashuB.
     */
    async convertToCashuA(token) {
        // Backend's TokenV4.deserialize() only accepts cashuB format.
        // No conversion needed - pass through as-is.
        if (token.toLowerCase().startsWith('cashub')) {
            console.log('[tokenRedemption] Token is cashuB format, passing through (length:', token.length + ')');
        }
        return token;
    },

    /**
     * Build voucher object from redemption result and metadata.
     *
     * Currency is resolved via the four-step chain (DM → getTokenMetadata →
     * inspectVoucher → receive() result) with an explicit `UNKNOWN` fall-
     * through — never defaults silently to `'SAT'`.
     * See specs/007-fix-voucher-currency/contracts/token-transfer-dm.schema.md §2.
     */
    buildVoucher(token, result, metadata, apiMetadata, receivedAmount, inspectResult = null, opts = {}) {
        // Spec 039 US 1 (T031) — inspect-wins precedence for scan/manual
        // paths. When opts.inspectIsAuthoritative is true, the inspect
        // response was obtained via the T030 fail-closed gate and its
        // fields override token-embedded metadata for the FR-008/009 set:
        //
        //   FIELD               | inspect-wins?                | notes
        //   --------------------+------------------------------+-----------------------
        //   issuer_id           | YES                          | inspect carries signed-voucher id
        //   merchant_metadata   | YES                          | optional; falls through if absent
        //   face_decimals       | YES                          | gateway resolves canonical currency
        //   backing_strategy    | YES                          | gateway resolves authoritative strategy
        //   issuance_ratio      | YES                          | already chained but inspect-first now
        //   expires_at          | YES, gated                   | inspect ONLY when verified-with-expiry;
        //                       |                              | else null/omit (verified-no-expiry)
        //
        // For non-scan/manual sources (sse, catchup, dm-poll, etc.) the
        // pre-spec-039 chain is preserved — see buildVoucher's history
        // for the reasoning around each fallback step.
        const __inspectIsAuthoritative = Boolean(opts.inspectIsAuthoritative);
        // Spec 027 follow-up: surface the cached merchant profile as the
        // 5th currency-resolution source so freshly-issued vouchers don't
        // land as UNKNOWN when the gateway metadata pipeline is still
        // catching up at DM redemption time. Cache is populated by the
        // buy page / merchant card render before send-receive.
        const _issuerForLookup =
            metadata?.issuer_id ?? inspectResult?.issuer_id ?? result?.issuer_id ?? null;
        // Try lookup against multiple case variants — buy.js typically
        // writes lowercase hex; defend against any upstream caller
        // accidentally storing under the original case.
        const _merchantProfile = (() => {
            if (!_issuerForLookup || typeof getCachedMerchantProfile !== 'function') return null;
            const candidates = [
                _issuerForLookup,
                String(_issuerForLookup).toLowerCase(),
                String(_issuerForLookup).toUpperCase(),
            ];
            for (const k of candidates) {
                try {
                    const p = getCachedMerchantProfile(k);
                    if (p) return p;
                } catch (_e) { /* fall through */ }
            }
            return null;
        })();
        const { faceUnit, source } = __currencyApi.resolveFaceUnit({
            dmMetadata: metadata,
            getTokenMetadataResult: apiMetadata,
            inspectResult,
            receiveResult: result,
            merchantProfile: _merchantProfile,
        });
        const unit = faceUnit;
        const resolvedAt = unit === __currencyApi.UNKNOWN ? null : new Date().toISOString();
        console.log('[tokenRedemption] buildVoucher face_unit resolved', {
            unit, source,
            issuer: _issuerForLookup ? _issuerForLookup.slice(0, 16) : null,
            hadMerchantProfile: !!_merchantProfile,
            merchantProfileKeys: _merchantProfile ? Object.keys(_merchantProfile) : null,
            inputs: {
                dm: metadata?.face_unit ?? null,
                meta: apiMetadata?.face_unit ?? null,
                inspect: inspectResult?.face_unit ?? null,
                receive: result?.face_unit ?? result?.unit ?? null,
            },
        });

        // ====================================================================
        // Partial-spend face-value correction (post-spec-035 hotfix, 2026-05-29)
        // ====================================================================
        // The "chain" face_value (metadata → token-metadata API → inspect API →
        // receive response) ultimately reads cashu V4's embedded
        // SignedVoucher.face_value, which is FROZEN AT ORIGINAL ISSUANCE and
        // does NOT reflect partial spends. A 5000-XAF voucher partially spent
        // down to 65 XAF worth of proofs still reports face_value=5000 in every
        // upstream source — alarming recipients who saw "5000 received" for a
        // 65-XAF send (reported by users 65574294... → 28a7dd0c..., 2026-05-29).
        //
        // When the proof amount (token_amount, in sats) and the issuance_ratio
        // (currency-minor-units per sat — the same convention used by
        // wallet-balance-card.js's `foreignSats * issuanceRatio` calc) are both
        // known, the DERIVED face value
        //   derived = round(token_amount * issuance_ratio)
        // is the truthful current value of the proofs. Prefer it whenever it
        // can be computed; the upstream chain is only an authoritative fallback
        // for tokens with no issuance_ratio (legacy / non-merchant-issued).
        //
        // For freshly-minted (unspent) tokens, derived ≈ embedded within rounding
        // — preferring derived is a no-op there. For partial-spends, derived is
        // the only honest number. Effectively this also closes the SC-005-style
        // UX issue where the recipient panicked over a perceived 77× send.
        // Spec 039 regression fix (2026-06-10): the raw cashu sats sum
        // (receivedAmount) is only a valid face value for sat-denominated units.
        // For a FIAT unit with no explicit face_value from any source, NEVER
        // equate sats with the fiat face — fall back to null and let the derived
        // (token_amount × issuance_ratio) path below produce the truthful value.
        // Previously this fell back to receivedAmount for every non-UNKNOWN unit,
        // so a fiat voucher with no embedded face value was credited its sats sum.
        const _unitIsSatDenominated = unit === 'SAT' || unit === 'BTC';
        const _embeddedFaceValueRaw =
            metadata?.face_value ?? apiMetadata?.face_value ?? inspectResult?.face_value ?? result.face_value ??
            (_unitIsSatDenominated ? receivedAmount : null);
        const _embeddedFaceValue = __toFiniteRedemptionNumber(_embeddedFaceValueRaw);
        // Spec 035 post-merge hotfix iter 2 (2026-05-29) — issuance_ratio
        // chain widened: include `inspectResult` (the receiver's primary
        // source per the user's `source: "inspect"` log lines), include
        // camelCase variants for backend responses that don't normalise,
        // and as a final fallback consult the cached merchant profile so
        // a recipient who happens to already have the issuer cached gets
        // the correct ratio even when none of the upstream API sources
        // returned it.
        // Spec 039 regression fix (2026-06-10): on the scan / manual paths the
        // cashu token's /inspect result is authoritative. issuance_ratio MUST
        // flip to inspect-first there — exactly like face_decimals and
        // backing_strategy below — otherwise a partial-spent voucher whose
        // embedded SignedVoucher carries a stale/missing ratio fails to derive
        // its truthful current value and falls back to the FROZEN ORIGINAL face
        // (e.g. a 25 XAF share credited as 5000). Spec 039 reordered the other
        // two fields but missed this one.
        const _resolvedIssuanceRatio = __inspectIsAuthoritative
            ? __firstFiniteRedemptionNumber(
                inspectResult?.issuance_ratio,
                inspectResult?.issuanceRatio,
                metadata?.issuance_ratio,
                metadata?.issuanceRatio,
                apiMetadata?.issuance_ratio,
                apiMetadata?.issuanceRatio,
                result?.issuance_ratio,
                result?.issuanceRatio,
                _merchantProfile?.issuance_ratio,
                _merchantProfile?.issuanceRatio
            )
            : __firstFiniteRedemptionNumber(
                metadata?.issuance_ratio,
                metadata?.issuanceRatio,
                apiMetadata?.issuance_ratio,
                apiMetadata?.issuanceRatio,
                inspectResult?.issuance_ratio,
                inspectResult?.issuanceRatio,
                result?.issuance_ratio,
                result?.issuanceRatio,
                _merchantProfile?.issuance_ratio,
                _merchantProfile?.issuanceRatio
            );
        const _receiveTokenAmount = __firstPositiveRedemptionNumber(
            result?.token_amount,
            result?.tokenAmount,
            result?.amount,
            result?.balance,
            result?.sats_recovered,
            result?.satsRecovered,
            receivedAmount
        );
        const _metadataTokenAmount = __firstPositiveRedemptionNumber(
            metadata?.token_amount,
            metadata?.tokenAmount,
            apiMetadata?.token_amount,
            apiMetadata?.tokenAmount
        );
        const _resolvedTokenAmount = _receiveTokenAmount ?? _metadataTokenAmount;
        const _canDerive =
            unit !== __currencyApi.UNKNOWN
            && _resolvedIssuanceRatio !== null && _resolvedIssuanceRatio > 0
            && _resolvedTokenAmount !== null && _resolvedTokenAmount > 0;
        const _derivedFaceValue = _canDerive
            ? Math.round(_resolvedTokenAmount * _resolvedIssuanceRatio)
            : null;
        const _useDerived = _derivedFaceValue !== null;
        const _resolvedFaceValue = _useDerived ? _derivedFaceValue : _embeddedFaceValue;
        const _faceValueSource = _useDerived ? 'derived' : 'embedded';

        if (_useDerived && _embeddedFaceValue !== null
            && Math.abs(_derivedFaceValue - _embeddedFaceValue) > Math.max(1, _embeddedFaceValue * 0.02)) {
            // Log only meaningful corrections (> 2% or > 1 minor unit) so we
            // don't flood on freshly-minted tokens where rounding accounts for
            // a few units of difference.
            console.log('[tokenRedemption] face_value partial-spend correction', {
                embedded: _embeddedFaceValue,
                derived: _derivedFaceValue,
                token_amount_sats: _resolvedTokenAmount,
                issuance_ratio: _resolvedIssuanceRatio,
                unit,
            });
        }

        return {
            voucher_id: result.voucher_id || result.id || crypto.randomUUID(),
            // #110 second review B: never the INPUT token. After a swap it is
            // spent; saving it would be a balance with nothing behind it.
            // _doRedeem refuses a result without a fresh token before here.
            token: result.token || result.change_token || null,
            face_value: _resolvedFaceValue,
            face_value_source: _faceValueSource,
            face_unit: unit,
            face_unit_source: source,
            face_unit_resolved_at: resolvedAt,
            face_decimals: (
                __inspectIsAuthoritative
                    ? (inspectResult?.face_decimals ?? metadata?.face_decimals ?? apiMetadata?.face_decimals ?? result.face_decimals ??
                        (unit === __currencyApi.UNKNOWN ? null : resolveDecimals(unit)))
                    : (metadata?.face_decimals ?? apiMetadata?.face_decimals ?? inspectResult?.face_decimals ?? result.face_decimals ??
                        (unit === __currencyApi.UNKNOWN ? null : resolveDecimals(unit)))
            ),
            token_amount: _resolvedTokenAmount,
            token_unit: result.unit || 'sat',
            issuance_ratio: _resolvedIssuanceRatio,
            // Spec 035 post-merge hotfix iter 2 (2026-05-29) — when the upstream
            // chain (DM / token-metadata / inspect / receive) returns no
            // backing_strategy we used to default to 'LEGACY', which then made
            // vouchers.js hide the sats-backing badge on the detail page entirely
            // (user-reported: "the new voucher does not show the sats backing
            // amount and strategy"). For a token that actually has sats backing,
            // 'PROPORTIONAL' is the right default (matches normalizeVoucher's
            // default at storage.js:1282); only keep 'LEGACY' when we have no
            // token_amount at all.
            backing_strategy: __inspectIsAuthoritative
                ? (
                    inspectResult?.backing_strategy
                    ?? metadata?.backing_strategy
                    ?? apiMetadata?.backing_strategy
                    ?? result.backing_strategy
                    ?? (_resolvedTokenAmount > 0 ? 'PROPORTIONAL' : 'LEGACY')
                )
                : (
                    metadata?.backing_strategy
                    ?? apiMetadata?.backing_strategy
                    ?? inspectResult?.backing_strategy
                    ?? result.backing_strategy
                    ?? (_resolvedTokenAmount > 0 ? 'PROPORTIONAL' : 'LEGACY')
                ),
            issuer_id: __inspectIsAuthoritative
                ? (inspectResult?.issuer_id ?? metadata?.issuer_id ?? result.issuer_id ?? null)
                : (metadata?.issuer_id ?? inspectResult?.issuer_id ?? result.issuer_id ?? null),
            // Authoritative expiry comes from the cashu token's embedded SignedVoucher
            // metadata (via the /inspect endpoint). The receive response and DM-derived
            // metadata DO NOT reliably carry the original voucher's expiry — at minimum
            // the gateway's ReceiveResponse DTO has no expires_at field at all, so a
            // missing inspect lookup leaves us with stale or mid-flow values (e.g. the
            // server-side ReceiveEscrow's 30-day TTL leaking into the client). Prefer
            // inspect first, then DM metadata, then receive payload, then null.
            // (Recipient bug 2026-05-03: P2P sends showed expiry == receive time + 30d.)
            // Spec 039 (T031) — when inspect is authoritative AND
            // expiry_verification === 'verified-no-expiry', expires_at
            // is null (the SignedVoucher explicitly declared no expiry).
            // The 'verified-with-expiry' branch carries the ISO string
            // verbatim. For non-fail-closed sources, preserve the
            // existing inspect-first chain.
            expires_at: __inspectIsAuthoritative
                ? (
                    inspectResult?.expiry_verification === 'verified-with-expiry'
                        ? (inspectResult?.expires_at || null)
                        : null
                )
                : (inspectResult?.expires_at || metadata?.expires_at || apiMetadata?.expires_at || result.expires_at || null),
            merchant_metadata: __inspectIsAuthoritative
                ? (inspectResult?.merchant_metadata || result.merchant_metadata || apiMetadata?.merchant_metadata || null)
                : (result.merchant_metadata || apiMetadata?.merchant_metadata || null),
            memo: metadata?.memo || apiMetadata?.memo || result.memo || null,
            status: 'active',
            created_at: new Date().toISOString(),
            received_via: metadata?.received_via || 'manual',
            sender_pubkey: metadata?.sender_pubkey || null,
            // imani-wallet #145: names the redeem this row came from, so the
            // wallet's write hook stamps it with THIS redeem's ids when two
            // redeems are in flight. Dropped by that hook before storage.
            correlation_id: metadata?.correlation_id || undefined
        };
    },

    /**
     * Consolidate voucher with change token
     */
    consolidateVoucher(result, baseVoucher) {
        const resultUnit = __currencyApi.normalizeFaceUnit(result?.face_unit ?? result?.unit);
        const baseUnit = __currencyApi.normalizeFaceUnit(baseVoucher?.face_unit);
        const unit = resultUnit || baseUnit || __currencyApi.UNKNOWN;
        const receivedAt = new Date().toISOString();

        return {
            voucher_id: baseVoucher.voucher_id,
            token: result.token || result.change_token || baseVoucher.token,
            face_value: result.face_value ?? baseVoucher.face_value,
            face_unit: unit,
            face_unit_source: resultUnit ? 'receive_result' : (baseVoucher.face_unit_source || 'unknown'),
            face_unit_resolved_at: unit === __currencyApi.UNKNOWN
                ? null
                : (resultUnit ? receivedAt : (baseVoucher.face_unit_resolved_at || receivedAt)),
            face_decimals: resolveDecimals(unit, result.face_decimals, baseVoucher.face_decimals),
            token_amount: result.token_amount ?? baseVoucher.token_amount,
            token_unit: result.token_unit || baseVoucher.token_unit || 'sat',
            issuance_ratio: result.issuance_ratio ?? baseVoucher.issuance_ratio ?? null,
            backing_strategy: result.backing_strategy ?? baseVoucher.backing_strategy ?? 'LEGACY',
            issuer_id: result.issuer_id ?? baseVoucher.issuer_id ?? null,
            expires_at: result.expires_at ?? baseVoucher.expires_at ?? null,
            merchant_metadata: result.merchant_metadata ?? baseVoucher.merchant_metadata ?? null,
            memo: baseVoucher.memo || null,
            status: 'active',
            created_at: baseVoucher.created_at || receivedAt,
            received_via: baseVoucher.received_via,
            sender_pubkey: baseVoucher.sender_pubkey,
            correlation_id: baseVoucher.correlation_id
        };
    },

    /**
     * Record transaction to NIP-60 history
     */
    async recordNip60Transaction(voucher, metadata, nip60Wallet) {
        if (!nip60Wallet) {
            return;
        }

        try {
            const senderPubkey = metadata?.sender_pubkey || voucher.sender_pubkey || null;

            // Try to resolve sender's NIP-05 or display name
            let counterpartyDisplay = senderPubkey;
            if (senderPubkey) {
                counterpartyDisplay = await this.resolveSenderDisplay(senderPubkey);
            }

            const transaction = {
                txType: 'received',
                direction: 'in',
                tokenAmount: voucher.token_amount || voucher.face_value,
                voucherId: voucher.voucher_id,
                faceValue: voucher.face_value,
                faceUnit: voucher.face_unit,
                faceDecimals: voucher.face_decimals,
                issuerId: voucher.issuer_id,
                issuerName: voucher.merchant_metadata?.merchant_name || null,
                counterparty: counterpartyDisplay,
                counterpartyPubkey: senderPubkey, // Keep original pubkey for reference
                memo: voucher.memo,
                timestamp: Math.floor(Date.now() / 1000),
                walletDTag: 'default'
            };

            // Paranoid consistency check — feature 007-fix-voucher-currency,
            // data-model rule: "transaction record's face_unit MUST equal its
            // voucher's face_unit at record-time". Both read from the same
            // voucher; divergence implies a future regression.
            if (voucher.face_unit !== transaction.faceUnit) {
                console.warn('[tokenRedemption] face_unit divergence detected', {
                    voucherId: voucher.voucher_id,
                    voucherFaceUnit: voucher.face_unit,
                    txFaceUnit: transaction.faceUnit
                });
            }

            await nip60Wallet.recordTransaction(transaction);
            console.log('[tokenRedemption] Transaction recorded to NIP-60 history');
        } catch (e) {
            console.warn('[tokenRedemption] Failed to record NIP-60 transaction:', e);
            // Non-fatal
        }
    },

    /**
     * Resolve sender pubkey to NIP-05 or display name
     */
    async resolveSenderDisplay(pubkey) {
        if (!pubkey) return null;

        // Try profile lookup first
        try {
            if (typeof api !== 'undefined' && api.getProfile) {
                const profile = await api.getProfile(pubkey);
                if (profile) {
                    if (profile.nip05) return profile.nip05;
                    if (profile.display_name || profile.displayName) return profile.display_name || profile.displayName;
                    if (profile.name) return profile.name;
                }
            }
        } catch (e) {
            console.log('[tokenRedemption] Profile lookup failed:', e.message);
        }

        // Try reverse NIP-05 lookup
        try {
            if (typeof api !== 'undefined' && api.getNip05ByPubkey) {
                const nip05Info = await api.getNip05ByPubkey(pubkey);
                if (nip05Info && nip05Info.nip05) {
                    return nip05Info.nip05;
                }
            }
        } catch (e) {
            console.log('[tokenRedemption] NIP-05 reverse lookup failed:', e.message);
        }

        // Fallback to truncated pubkey
        if (pubkey.length > 16) {
            return pubkey.substring(0, 8) + '...' + pubkey.substring(pubkey.length - 8);
        }
        return pubkey;
    },

    // getDecimals removed — use resolveDecimals() from shared/format.js

    /**
     * Persist a successfully-swapped voucher locally and run the full
     * tail-of-redemption pipeline. Extracted from the two save branches
     * inside `_doRedeem` (spec 021 T002) so the escrow-recovery flow can
     * reuse the same sequence without duplicating it.
     *
     * Pipeline order:
     *   saveVoucher → setActiveVoucher → _acknowledgeEscrow →
     *   markTokenAsReceived → recordNip60Transaction → _emitPaymentReceipt
     *
     * On saveVoucher failure, returns `{ ...voucherShape, saveError: true,
     * receiveId }` — same shape the old inline branches produced, so all
     * existing callers (and the spec-020 claim-layer fork in `redeem()`)
     * keep working.
     *
     * @param {Object} voucherShape - The voucher object to persist
     *   (already built by buildVoucher or consolidateVoucher).
     * @param {Object} ctx
     * @param {string|null} ctx.receiveId - Escrow id for the ack call.
     * @param {string} ctx.token - The original cashu token; passed to
     *   markTokenAsReceived for dedup.
     * @param {Object} ctx.metadata - The metadata blob from redeem()
     *   options.metadata.
     * @param {Object|null} ctx.nip60Wallet - Optional NIP-60 wallet handle.
     * @param {string} [ctx.source] - Spec 039 (T018a) canonical receive
     *   surface. Plumbed verbatim from the `redeem(token, opts)` call site.
     *   Future tightenings (US 1 T030 inspect-before-save) gate on
     *   `ctx.source === 'scan' || 'manual'`. Values: 'scan' | 'manual' |
     *   'sse' | 'catchup' | 'cashback' | 'gift_link' | 'gift_link_reclaim' | 'escrow_recovery' | 'dm-poll' |
     *   'receive-screen' | 'unknown'.
     * @returns {Promise<Object>} The persisted voucher, or a saveError
     *   shape on failure.
     * @private
     */
    async _persistRedeemed(voucherShape, ctx = {}) {
        const { receiveId = null, token = null, metadata = {}, nip60Wallet = null, source = null, eventId = null } = ctx;

        // Spec 038 FR-020: populate receive-provenance fields on the
        // voucher row BEFORE the atomic write so they land alongside the
        // payload in a single IDB transaction. All four fields are
        // optional / nullable per FR-021 backward-compat — paths that
        // can't supply them (manual paste w/o event id) leave them
        // undefined.
        const swapCompletedAt = new Date().toISOString();
        const provenance = {};
        if (eventId) provenance.received_via_event_id = eventId;
        provenance.swap_completed_at = swapCompletedAt;
        if (Array.isArray(voucherShape.swap_proof_ids) && voucherShape.swap_proof_ids.length > 0) {
            // Caller pre-populated (e.g. burn() carries through).
            provenance.swap_proof_ids = voucherShape.swap_proof_ids;
        } else if (Array.isArray(voucherShape.proofs)) {
            // Derive keyset ids from proofs if available (FR-022 — public ids only, no secrets).
            const ids = voucherShape.proofs
                .map((p) => p && (p.id || p.keysetId || p.keyset_id))
                .filter((id) => typeof id === 'string' && id.length > 0);
            if (ids.length > 0) provenance.swap_proof_ids = Array.from(new Set(ids));
        }
        if (source) provenance.source_transport = source;
        const voucherWithProvenance = { ...voucherShape, ...provenance };

        // Spec 038 FR-014: atomic voucher + tx write — both rows in a
        // single IDB transaction; either both land or both are absent.
        // Closes the FR-019 "voucher saved but tx write failed" partial-
        // state class by construction. The downstream listener fanout
        // (recordLocalVoucherTransaction → addTransaction) is idempotent
        // — spec-035's collision detection at storage.js:9682 returns
        // the existing row for type='received' + same tokenId, so the
        // second-arriving downstream write is a no-op.
        //
        // imani-wallet #95: NO non-atomic fallback. There used to be one
        // (a bare `saveVoucher` when `atomicallyWrite` was missing). It
        // wrote the coupon without its transaction row, and the row is
        // the only place a redemption's claim is filed: the wallet's
        // `legacyBridge.stampCorrelation` stamps the voucher id the stall
        // issued onto rows written through `atomicallyWrite`, and
        // nowhere else. A redemption saved by the fallback therefore left
        // the stall's claimed figure and redemption ceiling blind to it.
        // A missing `atomicallyWrite` is now a failed save: the proofs
        // stay in backend escrow, exactly as for any other write failure.
        const canAtomic = typeof walletStorageIntegration !== 'undefined'
            && typeof walletStorageIntegration.atomicallyWrite === 'function';
        try {
            if (!canAtomic) {
                throw new Error('walletStorageIntegration.atomicallyWrite unavailable; refusing a write that files no claim');
            }
            const txRow = _buildReceiveTransactionRow(voucherWithProvenance, metadata);
            await walletStorageIntegration.atomicallyWrite({
                vouchers: [voucherWithProvenance],
                transactions: txRow ? [txRow] : [],
            });
        } catch (saveErr) {
            // #110: the old text here said "proofs are safe in backend escrow".
            // They are not: the gateway stopped storing the fresh token (V4,
            // #58) and recovery is disabled (#95). A retry of the same token is
            // NOT a recovery either: the gateway's same-key replay returns the
            // receive_id with `token: null`, so the value is not recoverable by
            // this wallet. The escrow stays 'settled' on the ledger, never
            // acked, for reconciliation.
            // TODO(imani-gateway-customer#121/#119): recover a HELD escrow's
            // proofs (kept encrypted to the recipient, or replayed by key).
            console.error('[tokenRedemption] persist failed after a settled swap; value NOT recoverable by retry — needs reconciliation', {
                receiveId, source, message: saveErr && saveErr.message,
            });
            // Spec 022 / spec 038 contract: throw RedemptionSaveError so
            // callers can distinguish "swap succeeded but persist failed"
            // (recoverable on next boot via FR-015 + escrow recovery)
            // from generic redemption failure. The boot recovery sweep
            // reclaims via receiveId.
            throw new RedemptionSaveError(receiveId, saveErr);
        }

        // After the atomic write, replace voucherShape with the provenance-augmented copy
        // so downstream consumers see swap_completed_at + source_transport.
        voucherShape = voucherWithProvenance;

        if (typeof setActiveVoucher === 'function' && voucherShape.voucher_id) {
            setActiveVoucher(voucherShape.voucher_id);
        }

        // Acknowledge escrow after successful save. Non-fatal — if the
        // ack fails the next sweep retries against the still-HELD row.
        //
        // #110 review: 'saved' is recorded HERE, after the write, and is the
        // only state the flush acks. A receive whose save threw stays
        // 'settled' and is never acknowledged.
        ReceiveLedger.recordSaved(receiveId, null);
        await this._acknowledgeEscrow(receiveId);

        // Mark token as received for dedup. Skip if no token (the
        // recovery flow may pass null when invoked from PendingReceive
        // and rely on the voucher_id dedup path instead).
        if (token) {
            if (typeof markTokenAsReceivedAsync === 'function') {
                await markTokenAsReceivedAsync(token);
            } else if (typeof markTokenAsReceived === 'function') {
                markTokenAsReceived(token);
            }
        }

        // NIP-60 history publish (cross-device sync).
        await this.recordNip60Transaction(voucherShape, metadata, nip60Wallet);

        // Spec 014: fire-and-forget delivery confirmation back to the
        // original sender so they see a blue tick on their transaction.
        // FR-003: only after redemption is durably persisted.
        // FR-004: must NOT throw — this call never blocks the redemption.
        this._emitPaymentReceipt(voucherShape, metadata);

        // Spec 035 US2 (FR-008/009): emit balance-updated ONLY after the
        // receive has fully persisted (the bridge save above resolved),
        // so the success state and the visible wallet balance agree.
        // The balance card listens for this event and refreshes from the
        // wallet-storage bridge (Constitution III, single source of truth).
        // Best-effort — never blocks redemption.
        try {
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('balance-updated', {
              detail: { source: 'tokenRedemption._persistRedeemed', voucherId: voucherShape.voucher_id }
            }));
            window.dispatchEvent(new CustomEvent('vouchers-updated', {
              detail: { source: 'tokenRedemption._persistRedeemed', voucherId: voucherShape.voucher_id }
            }));
          }
        } catch (_e) { /* observability is best-effort */ }

        return voucherShape;
    },

    /**
     * Acknowledge successful save to release backend escrow.
     * Never throws.
     *
     * #110: this used to swallow a failure with "will retry on next startup",
     * but the startup recovery that would have retried it is disabled (#95),
     * so a single rate-limited ack left the escrow HELD for good (five on
     * staging in one bundle). Now:
     *
     *  - the first attempt is awaited, as before, so the common case finishes
     *    inside the redemption;
     *  - a failure schedules a BOUNDED background retry (ACK_RETRY_BACKOFFS_MS)
     *    that honours the gateway's Retry-After on a 429, capped so a hostile
     *    or confused header cannot park it forever. Background, because a
     *    redemption must not stall a minute on bookkeeping for money that is
     *    already saved;
     *  - the id stays on the ReceiveLedger until an ack succeeds, and
     *    `flushUnacknowledgedEscrows` (called by the poller at startup and on
     *    every catch-up) retries whatever the loop gave up on.
     *
     * @param {string|null} receiveId - The escrow receive ID
     * @returns {Promise<boolean>} true iff the first attempt acknowledged it
     */
    async _acknowledgeEscrow(receiveId) {
        if (!receiveId) return false;
        // Never throws: a gate that rejects (the pacer reset on logout) just
        // leaves the id on the ledger for the next session's flush.
        try { await this._ackGate(); } catch (_) { return false; }
        const ok = await this._ackOnce(receiveId);
        if (!ok.acked && ok.retryable) this._scheduleAckRetry(receiveId, ok.retryAfterMs);
        return ok.acked;
    },

    /** One ack attempt. Never throws. @private */
    async _ackOnce(receiveId) {
        try {
            if (typeof api === 'undefined' || !api || typeof api.acknowledgeReceive !== 'function') {
                return { acked: false, retryable: false, rateLimited: false, retryAfterMs: null };
            }
            // #110 review: nothing is acked unless its save succeeded. A caller
            // passing a 'settled' id (value never kept) is refused here, so a
            // future call site cannot reintroduce ack-before-save.
            if (ReceiveLedger.settledUnsaved().indexOf(receiveId) >= 0) {
                console.error('[tokenRedemption] refusing to ack an escrow whose value was never saved', { receiveId });
                return { acked: false, retryable: false, rateLimited: false, retryAfterMs: null };
            }
            await api.acknowledgeReceive(receiveId);
            ReceiveLedger.markAcked(receiveId);
            this._ackForbidden.delete(receiveId);
            console.info('[tokenRedemption] escrow acknowledged', { receiveId });
            return { acked: true, retryable: false, rateLimited: false, retryAfterMs: null };
        } catch (err) {
            const status = err && err.status;
            // 404/410: the gateway no longer has this escrow (already acked,
            // or expired). Nothing to retry, and keeping it would retry forever.
            if (status === 404 || status === 410) {
                ReceiveLedger.markAcked(receiveId);
                console.info('[tokenRedemption] escrow ack: gateway has no such escrow, dropped', { receiveId, status });
                return { acked: false, retryable: false, rateLimited: false, retryAfterMs: null };
            }
            // 403: usually auth that has not caught up (a signer mid-unlock),
            // occasionally an escrow that is not ours. Retried a bounded number
            // of times across runs, then dropped so it cannot loop forever.
            if (status === 403) {
                const n = (this._ackForbidden.get(receiveId) || 0) + 1;
                this._ackForbidden.set(receiveId, n);
                if (n >= ACK_FORBIDDEN_MAX) {
                    ReceiveLedger.markAcked(receiveId);
                    this._ackForbidden.delete(receiveId);
                    console.warn('[tokenRedemption] escrow ack forbidden repeatedly, dropped', { receiveId });
                    return { acked: false, retryable: false, rateLimited: false, retryAfterMs: null };
                }
            }
            console.warn('[tokenRedemption] escrow ack failed, kept for retry', {
                receiveId, status, code: err && err.code, message: err && err.message,
            });
            return {
                acked: false,
                retryable: true,
                rateLimited: status === 429,
                retryAfterMs: typeof (err && err.retryAfterMs) === 'number' ? err.retryAfterMs : null,
            };
        }
    },

    // receive_id → background retry promise, so one escrow has one loop.
    _ackRetries: new Map(),
    // receive_id → consecutive 403s.
    _ackForbidden: new Map(),
    // Bumped on reset, so a loop started for the previous account stops.
    _ackEpoch: 0,
    // Overridable by tests; production uses real timers.
    _ackSleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    _ackBackoffsMs: ACK_RETRY_BACKOFFS_MS,
    /**
     * Gate every ack goes through, so acks share the receive budget's pacing
     * instead of spending it behind the pacer's back. dmPoll installs its
     * pacer here; the default lets it through.
     */
    _ackGate: async () => {},
    /** Gate every api.receive goes through; dmPoll installs its pacer. */
    _receiveGate: async () => {},
    // #300: bounds on the awaits before api.receive. The gate's covers a full
    // pacer window and more; past it the call defers to the next poll.
    _stepTimeoutMs: 15000,
    _receiveGateTimeoutMs: 180000,
    // #301 review: warn (never abort) when api.receive has not answered by then.
    _receiveSlowWarnMs: 20000,
    // Overridable by tests; the 409 in-flight wait.
    _inFlightSleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    // token fingerprint → timestamps of api.receive calls (review C).
    _receiveCalls: new Map(),
    /** Book one api.receive for this token; false once the budget is spent. */
    _takeReceiveCall(key) {
        const now = Date.now();
        const recent = (this._receiveCalls.get(key) || []).filter((t) => now - t < RECEIVE_CALLS_SPAN_MS);
        if (recent.length >= RECEIVE_CALLS_PER_TOKEN) {
            this._receiveCalls.set(key, recent);
            return false;
        }
        recent.push(now);
        this._receiveCalls.set(key, recent);
        if (this._receiveCalls.size > 500) {
            this._receiveCalls.delete(this._receiveCalls.keys().next().value);
        }
        return true;
    },
    /** Return a booked call that never went out (#300 gate timeout). */
    _releaseReceiveCall(key) {
        const recent = this._receiveCalls.get(key);
        if (recent && recent.length) recent.pop();
    },
    RECEIVE_CALLS_PER_TOKEN,
    // Last flush start, so catch-ups cannot flush more than once a minute.
    _lastFlushAt: 0,

    /**
     * Forget in-memory ack state. Called on logout / account switch so a retry
     * loop for the previous account cannot ack under the next one's session.
     */
    resetAckState() {
        this._ackEpoch += 1;
        this._lastFlushAt = 0;
        this._receiveCalls.clear();
        this._ackRetries.clear();
        this._ackForbidden.clear();
    },

    /** @private */
    _scheduleAckRetry(receiveId, firstRetryAfterMs) {
        if (this._ackRetries.has(receiveId)) return this._ackRetries.get(receiveId);
        const self = this;
        const epoch = this._ackEpoch;
        const loop = (async () => {
            let retryAfterMs = firstRetryAfterMs;
            for (const backoff of self._ackBackoffsMs) {
                const wait = Math.min(
                    Math.max(backoff, typeof retryAfterMs === 'number' ? retryAfterMs : 0),
                    ACK_RETRY_MAX_WAIT_MS,
                );
                await self._ackSleep(wait);
                if (epoch !== self._ackEpoch) return false;
                await self._ackGate();
                if (epoch !== self._ackEpoch) return false;
                const r = await self._ackOnce(receiveId);
                if (r.acked || !r.retryable) return r.acked;
                retryAfterMs = r.retryAfterMs;
            }
            console.warn('[tokenRedemption] escrow ack retries exhausted; left for the next poll', { receiveId });
            return false;
        })().catch(() => false).finally(() => {
            if (self._ackRetries.get(receiveId) === loop) self._ackRetries.delete(receiveId);
        });
        this._ackRetries.set(receiveId, loop);
        return loop;
    },

    /**
     * #110 — acknowledge escrows this account SAVED but never acknowledged.
     * Called by the poller at startup and on catch-up. Never touches a
     * 'settled' (unsaved) escrow. At most ACK_FLUSH_MAX_PER_RUN acks per run,
     * each through `_ackGate` (the receive pacer), and it stops at the first
     * 429 with or without a Retry-After: a backlog must never spend the
     * budget the next coupon needs. Never throws. Returns how many were acked.
     */
    async flushUnacknowledgedEscrows() {
        let acked = 0;
        let sent = 0;
        // Catch-ups fire on SSE open, focus and online; throttled so their
        // flushes cost at most ACK_FLUSH_MAX_PER_RUN calls a minute (review C).
        const now = Date.now();
        if (now - this._lastFlushAt < ACK_FLUSH_MIN_INTERVAL_MS) return 0;
        this._lastFlushAt = now;
        try {
            for (const receiveId of ReceiveLedger.unacknowledged()) {
                if (sent >= ACK_FLUSH_MAX_PER_RUN) break;
                if (this._ackRetries.has(receiveId)) continue;
                await this._ackGate();
                sent += 1;
                const r = await this._ackOnce(receiveId);
                if (r.acked) acked += 1;
                else if (r.rateLimited) break;
            }
        } catch (_) { /* never throws */ }
        return acked;
    },

    /**
     * Recover pending receives from backend escrow.
     * Call on app startup to restore proofs from any previous failed saves.
     * @returns {Promise<number>} Number of recovered vouchers
     */
    async recoverPendingReceives() {
        // imani-wallet #95: disabled, deliberately, and it files no claim.
        //
        //  - It cannot restore anything. The gateway stopped storing the
        //    fresh token (receive_escrow V4, issue #58), so every pending
        //    entry arrives with `fresh_token` absent and the coupon below
        //    would be a row with no money in it.
        //  - It cannot file a claim. `PendingReceive` carries no voucher
        //    id, so the row got `crypto.randomUUID()` and, written by a
        //    bare `saveVoucher` outside `withCorrelation`, no transaction
        //    row at all: the stall's claimed figure and redemption ceiling
        //    could never see it.
        //  - It then ACKNOWLEDGED the escrow, discarding the gateway's only
        //    record that the receive happened.
        //
        // A receive whose save failed is instead retried by dm-poll (the
        // event is not marked processed on a RedemptionSaveError), and that
        // retry writes its row through the same claim-filing
        // `atomicallyWrite` as any other redemption. (Whether the retry
        // still holds the fresh proofs is a separate question, and the
        // same one: the gateway replays a receive without its token.)
        // Nothing in imani-wallet calls this; `claimPaths.test.ts` pins
        // both that and this body.
        return 0;
    },

    /**
     * The original escrow-recovery body, kept for reference only and
     * unreachable. See `recoverPendingReceives` above.
     * @private
     */
    async _legacyRecoverPendingReceives() {
        if (typeof api === 'undefined' || !api.getPendingReceives) {
            return 0;
        }

        try {
            const pending = await api.getPendingReceives();
            if (!pending || !Array.isArray(pending) || pending.length === 0) {
                return 0;
            }

            console.log('[tokenRedemption] Recovering', pending.length, 'pending receives from escrow');
            let recovered = 0;

            for (const escrow of pending) {
                try {
                    const receiveId = escrow.receive_id || escrow.receiveId;
                    const voucher = {
                        voucher_id: crypto.randomUUID(),
                        token: escrow.fresh_token || escrow.freshToken,
                        face_value: escrow.face_value ?? escrow.faceValue ?? escrow.amount_sats ?? escrow.amountSats,
                        face_unit: escrow.face_unit || escrow.faceUnit || 'SAT',
                        face_decimals: escrow.face_decimals ?? escrow.faceDecimals ?? 0,
                        token_amount: escrow.amount_sats ?? escrow.amountSats,
                        token_unit: 'sat',
                        issuer_id: escrow.issuer_id || escrow.issuerId || null,
                        status: 'active',
                        created_at: new Date().toISOString(),
                        received_via: 'escrow_recovery'
                    };

                    saveVoucher(voucher);
                    console.log('[tokenRedemption] Recovered voucher from escrow:', receiveId);

                    // Acknowledge after successful save
                    await this._acknowledgeEscrow(receiveId);
                    recovered++;
                } catch (err) {
                    console.error('[tokenRedemption] Failed to recover escrow entry:', err);
                }
            }

            console.log('[tokenRedemption] Recovery complete:', recovered, 'of', pending.length, 'vouchers recovered');
            return recovered;
        } catch (err) {
            console.error('[tokenRedemption] Failed to fetch pending receives:', err);
            return 0;
        }
    }
};

// Spec 022 — attach error subclasses to the TokenRedemption object so
// callers can `instanceof`-check via `window.TokenRedemption.<Error>`
// without importing them separately.
TokenRedemption.RedemptionSaveError = RedemptionSaveError;
TokenRedemption.RedemptionClaimContendedError = RedemptionClaimContendedError;
// Spec 039 — US 1 / US 3 typed provenance-verification error. Surfaced
// to callers in voucher/js/scan.js + voucher/js/receive.js so they can
// render an actionable error modal (FR-006 + FR-018).
TokenRedemption.ProvenanceVerificationError = ProvenanceVerificationError;
// #110 — terminal "this receive already settled" error, and the ledger, for
// callers (dmPoll) and tests.
TokenRedemption.ReceiveSettledNotSavedError = ReceiveSettledNotSavedError;
TokenRedemption.ReceiveLedger = ReceiveLedger;

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TokenRedemption;
}
// Expose on window so classic-script callers + sandboxes can reach it.
try {
    if (typeof window !== 'undefined' && !window.TokenRedemption) {
        window.TokenRedemption = TokenRedemption;
    }
} catch (_) { /* swallow */ }

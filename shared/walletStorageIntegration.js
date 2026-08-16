/**
 * walletStorageIntegration.js — bridge between shared/storage.js (vanilla
 * JS, sync API) and @imani/wallet-storage (TS, async IDB primitive).
 *
 * Owns:
 *   1. The shadow cache — per-tab in-memory mirror of the IDB stores;
 *      lets shared/storage.js keep its synchronous read API
 *      (getVouchers / getTransactions / etc.) without consumers having
 *      to convert to await.
 *   2. The per-tab write queue — a single async chain that serializes
 *      writes within a tab so the cache stays consistent with IDB even
 *      across rapid back-to-back saves.
 *   3. Cross-tab event handling — subscribes to vouchers:changed /
 *      transactions:changed; marks the shadow cache stale lazily.
 *
 * Bridge contracts: see specs/024-vouchers-tx-idb-migration/contracts/
 *   wallet-storage.contract.md §2.
 *
 * Spec 024 — closes finding #4 of the 2026-05-16 redemption-path review
 * (cross-tab RMW race on localStorage.imani_vouchers / imani_transactions).
 */

// Spec 025 hotfix — wrap the module body in an IIFE so the top-level
// `function saveVoucher(...)` / `function getVouchers(...)` / etc.
// declarations DON'T leak as classic-script globals. Without this wrapper
// they overwrite `shared/storage.js`'s public surface (which is also
// loaded as a classic script and exposes functions with the same names
// as the bridge's internal helpers), causing callers like home.js's
// `enrichMerchantGroupsWithProfiles` to invoke the bridge's bare
// saveVoucher directly — bypassing storage.js's token_id synthesis and
// triggering "saveVoucher: token_id absent and token also absent".
//
// Only `walletStorageIntegration` (the public object) is exposed via
// `globalThis` and `module.exports`.
(function () {

const LEGACY_VOUCHERS_KEY = 'imani_vouchers';
const LEGACY_TRANSACTIONS_KEY = 'imani_transactions';

const STATE = {
  // The @imani/wallet-storage WalletStorage instance. Set by init().
  walletStorage: null,
  // Shadow cache. valid=false → next read triggers refresh.
  cache: {
    vouchers: { valid: false, data: [], lastRefreshedAt: 0 },
    transactions: { valid: false, data: [], lastRefreshedAt: 0 },
  },
  // Async write chain — every write enqueues a new step on this promise.
  writeQueue: Promise.resolve(),
  // Subscribers to local cache-state changes (UI re-render hooks).
  cacheListeners: new Set(),
  // Unsubscribe from the wallet-storage onChange registration.
  unsubscribeChange: null,
  // Has init() resolved? Sync reads before init throw.
  initialized: false,
  // Whether we've already emitted the legacy-residue warning this session.
  residueWarned: false,
  // Background refresh in flight per kind — coalesces racing stale-marks.
  refreshInFlight: { vouchers: null, transactions: null },
  // Spec 025 — set of writer names that have logged their cutover diagnostic
  // at least once this session. Subsequent calls are no-ops (one-shot per
  // writer per tab).
  loggedCutoverWriters: new Set(),
};

/**
 * Async — must complete before any sync method below.
 *
 *   await walletStorageIntegration.init({
 *     walletStorage: new WalletStorage({ db: sharedDb, channelName: 'walletSnapshotSync' })
 *   });
 *
 * The caller (typically shared/storage.js bootstrap) owns the
 * WalletStorage construction so the shared IDB DB lives in one place.
 */
async function init(opts) {
  if (STATE.initialized) return;
  if (!opts || !opts.walletStorage) {
    throw new Error('walletStorageIntegration.init: opts.walletStorage is required');
  }
  STATE.walletStorage = opts.walletStorage;

  // Initialize the wallet-storage instance if the caller hasn't.
  // (Calling init() twice on a WalletStorage is a no-op.)
  await STATE.walletStorage.init();

  // Eager-warm the cache. Sync readers see seeded data on the first call.
  await refreshCache('vouchers');
  await refreshCache('transactions');

  // Subscribe to cross-tab change events.
  STATE.unsubscribeChange = STATE.walletStorage.onChange((event) => {
    if (event.type === 'vouchers:changed') {
      STATE.cache.vouchers.valid = false;
      console.log('[storage] vouchers:changed source=' + event.source + ' ts=' + event.ts);
      // Trigger an async refresh so the next render tick has fresh data.
      refreshCache('vouchers').catch(() => { /* logged inside */ });
    } else if (event.type === 'transactions:changed') {
      STATE.cache.transactions.valid = false;
      console.log('[storage] transactions:changed source=' + event.source + ' ts=' + event.ts);
      refreshCache('transactions').catch(() => { /* logged inside */ });
    }
  });

  // One-shot legacy localStorage residue warning (FR-005 + C-BR-7).
  warnOnLegacyResidue();

  STATE.initialized = true;
}

// ============================================================================
// Voucher operations (sync façade — enqueues async write)
// ============================================================================

function saveVoucher(voucher) {
  ensureInitialized('saveVoucher');
  // Code-review finding #3 — the comments at shared/storage.js promise
  // "sync getVouchers reads see the new state immediately". The bulk
  // primitives (removeVouchers/clearAndReplaceAll*) already mutate the
  // cache pre-commit; this single-row path now matches that contract.
  // Snapshot the previous cache for rollback (finding #5 — partial fix
  // for the single-row path; the bulk primitives still need their own
  // rollback in a follow-up).
  const previousVouchers = STATE.cache.vouchers.data.slice();
  if (voucher && voucher.token_id) {
    upsertCache('vouchers', voucher, (v) => v.token_id);
    notifyCacheListeners('vouchers');
  }
  return enqueueWrite(async () => {
    try {
      const saved = await STATE.walletStorage.saveVoucher(voucher);
      // Replace the optimistic row with the canonical merged row from
      // the package's read-merge-write (handles partial-field saves,
      // created_at/updated_at, etc.).
      upsertCache('vouchers', saved, (v) => v.token_id);
      notifyCacheListeners('vouchers');
      return saved;
    } catch (err) {
      // Rollback the optimistic upsert. Callers that awaited the
      // returned promise will see the rejection; sync readers see the
      // restored prior state.
      STATE.cache.vouchers.data = previousVouchers;
      notifyCacheListeners('vouchers');
      throw err;
    }
  });
}

function getVoucher(tokenId) {
  ensureInitialized('getVoucher');
  const list = STATE.cache.vouchers.data;
  return list.find((v) => v && v.token_id === tokenId) || null;
}

function getVoucherByVoucherId(voucherId) {
  ensureInitialized('getVoucherByVoucherId');
  const list = STATE.cache.vouchers.data;
  return list.find((v) => v && v.voucher_id === voucherId) || null;
}

function getVouchers() {
  ensureInitialized('getVouchers');
  // Stale-but-last-known: per data-model.md §4, on cacheValid=false we
  // return the prior cache data AND trigger an async refresh. The next
  // render tick sees fresh data. The trade is one stale render vs.
  // forcing every sync caller to become async.
  if (!STATE.cache.vouchers.valid) {
    refreshCache('vouchers').catch(() => { /* logged inside */ });
  }
  return STATE.cache.vouchers.data;
}

function removeVoucher(tokenId) {
  ensureInitialized('removeVoucher');
  return enqueueWrite(async () => {
    const removed = await STATE.walletStorage.removeVoucher(tokenId);
    if (removed) {
      STATE.cache.vouchers.data = STATE.cache.vouchers.data.filter(
        (v) => v && v.token_id !== tokenId
      );
      notifyCacheListeners('vouchers');
    }
    return removed;
  });
}

/**
 * Spec 025 — bulk remove. Sync facade over @imani/wallet-storage's
 * `removeVouchers` (single IDB transaction over N rows). The shadow
 * cache is updated synchronously by filtering out matching token_ids;
 * the IDB write happens asynchronously on the write queue and posts
 * exactly ONE cross-tab event after commit.
 *
 * Empty input is a no-op (returns Promise<0>) — no write enqueued.
 *
 * Per spec 025 FR-003, contracts §2.2 C-BR-BULK-1.
 */
function removeVouchers(tokenIds) {
  ensureInitialized('removeVouchers');
  if (!Array.isArray(tokenIds) || tokenIds.length === 0) {
    return Promise.resolve(0);
  }
  // Code-review finding #5 — snapshot the cache for rollback if the
  // IDB write rejects. Without rollback, a failed bulk-delete leaves
  // the cache showing rows-as-deleted while IDB still has them,
  // diverging until the next refresh.
  const previousVouchers = STATE.cache.vouchers.data.slice();
  const idSet = new Set(tokenIds);
  STATE.cache.vouchers.data = STATE.cache.vouchers.data.filter(
    (v) => v && !idSet.has(v.token_id)
  );
  notifyCacheListeners('vouchers');
  return enqueueWrite(async () => {
    try {
      return await STATE.walletStorage.removeVouchers(tokenIds);
    } catch (err) {
      STATE.cache.vouchers.data = previousVouchers;
      notifyCacheListeners('vouchers');
      throw err;
    }
  });
}

/**
 * Spec 025 — atomic replace-all. Sync facade over
 * `@imani/wallet-storage.clearAndReplaceAllVouchers` (clear + N inserts
 * in one IDB transaction). The shadow cache is replaced synchronously
 * with the new rows; the IDB write happens async and posts ONE event.
 *
 * Empty input clears the cache + clears the IDB store (intentional —
 * matches the restore-from-backup semantics where the new backup is
 * empty).
 *
 * Per spec 025 FR-003, contracts §2.2 C-BR-BULK-2.
 */
function clearAndReplaceAllVouchers(rows) {
  ensureInitialized('clearAndReplaceAllVouchers');
  const safeRows = Array.isArray(rows) ? rows : [];
  // Code-review finding #5 — snapshot for rollback. If the IDB write
  // rejects (quota exhausted, browser kill mid-commit), the cache
  // would otherwise show the new rows while IDB still has the old set
  // → cross-tab BroadcastChannel re-syncs but state diverges in the
  // meantime.
  const previousVouchers = STATE.cache.vouchers.data.slice();
  STATE.cache.vouchers.data = [...safeRows];
  notifyCacheListeners('vouchers');
  return enqueueWrite(async () => {
    try {
      await STATE.walletStorage.clearAndReplaceAllVouchers(safeRows);
    } catch (err) {
      STATE.cache.vouchers.data = previousVouchers;
      notifyCacheListeners('vouchers');
      throw err;
    }
  });
}

/**
 * Spec 025 — one-shot cutover-observability logger. Records that a
 * migrated `shared/storage.js` writer fired at least once this session;
 * subsequent calls with the same writer name are silent. Used by
 * support to grep which writers have been exercised in production
 * after the spec-025 deploy.
 *
 * Private (underscore prefix). Only `shared/storage.js` calls this;
 * page code does not.
 *
 * Per spec 025 FR-015, data-model.md §4.
 */
function _logCutover(writerName) {
  if (!STATE.initialized) return;
  if (STATE.loggedCutoverWriters.has(writerName)) return;
  STATE.loggedCutoverWriters.add(writerName);
  const tabIdPrefix = STATE.walletStorage && STATE.walletStorage.tabId
    ? STATE.walletStorage.tabId.slice(0, 8)
    : 'unknown';
  console.log(
    '[storage] cutover_' + writerName + ' tab=' + tabIdPrefix + ' ts=' + Date.now()
  );
}

// ============================================================================
// Transaction operations
// ============================================================================

/**
 * Spec 038 FR-014 — atomic voucher + tx write.
 *
 * Commits N vouchers AND M transactions in a single IDB readwrite
 * transaction via the @imani/wallet-storage primitive. Either all rows
 * land (transaction committed) or none do (transaction aborted) — the
 * partial-state class that FR-019's "voucher saved but tx write failed"
 * row covers cannot happen post-spec-038.
 *
 * Cache + optimistic-update parity with saveVoucher + addTransaction:
 * on the optimistic side, both caches get patched pre-commit and rolled
 * back on rejection.
 *
 * <p><b>Caller contract — Copilot review #296 (K):</b> the underlying
 * `WalletStorage.atomicallyWrite` primitive auto-derives `token_id` from
 * `token` (via the spec-017 hash) when absent. This bridge does NOT
 * mirror that derivation in the optimistic-cache patch path, because
 * computing the hash here would require pulling a sync wrapper around
 * SubtleCrypto / blocking on the await. To keep optimistic-update parity
 * with `saveVoucher` (which has the same gate), <b>callers MUST supply
 * `voucher.token_id`</b> on the row passed to atomicallyWrite. The
 * canonical receive-tx writer (`shared/tokenRedemption.js::_buildReceiveTransactionRow`)
 * and the orphan-reconcile bridge (`voucher/js/home.js::buildTransactionForVoucher`)
 * both populate `token_id` explicitly, so spec-038 callers satisfy this
 * automatically. Rows that omit `token_id` still write successfully
 * (the package auto-derives) but skip the optimistic-cache fast path
 * AND the post-commit re-read (no key to read by).
 *
 * @param {{vouchers?: object[], transactions?: object[]}} input
 * @returns {Promise<void>}
 */
function atomicallyWrite(input) {
  ensureInitialized('atomicallyWrite');
  const vouchers = (input && input.vouchers) || [];
  const transactions = (input && input.transactions) || [];
  if (vouchers.length === 0 && transactions.length === 0) {
    return Promise.resolve();
  }

  // Optimistic snapshot for rollback.
  const previousVouchers = STATE.cache.vouchers.data.slice();
  const previousTransactions = STATE.cache.transactions.data.slice();

  // Optimistic patch on both caches.
  for (const v of vouchers) {
    if (v && v.token_id) upsertCache('vouchers', v, (r) => r.token_id);
  }
  if (vouchers.length > 0) notifyCacheListeners('vouchers');
  for (const t of transactions) {
    if (t && t.id) upsertCache('transactions', t, (r) => r.id);
  }
  if (transactions.length > 0) notifyCacheListeners('transactions');

  return enqueueWrite(async () => {
    try {
      await STATE.walletStorage.atomicallyWrite({ vouchers, transactions });
      // Spec 038 hotfix (2026-06-02) — when the caller doesn't pre-set
      // voucher.token_id, the underlying WalletStorage.atomicallyWrite
      // derives it from voucher.token inside the IDB transaction. The
      // per-row re-read below skips those rows (no token_id to look up
      // by), and the optimistic patch above also skipped them, so the
      // cache ends up missing the newly-written voucher even though
      // IDB has it. Result: getVouchers() returns stale data and the
      // balance card shows the pre-receive balance until hard refresh.
      //
      // Fix: do a full cache refresh from IDB after the commit when
      // any input voucher was missing token_id. This is the same path
      // init() uses to eager-warm; it's authoritative.
      const hasDerivedTokenId = vouchers.some((v) => v && !v.token_id);
      if (hasDerivedTokenId) {
        // refreshCache itself calls notifyCacheListeners on completion, so
        // the post-loop notify below is gated to avoid a double-fire that
        // would dispatch balance-updated/vouchers-updated twice (Copilot
        // review on PR #303, comment 3343192906).
        await refreshCache('vouchers');
      } else {
        // Re-read each row post-commit so the cache reflects the merged
        // canonical IDB row (consistency parity with saveVoucher).
        for (const v of vouchers) {
          if (v && v.token_id) {
            const reread = await STATE.walletStorage.getVoucher(v.token_id);
            if (reread) upsertCache('vouchers', reread, (r) => r.token_id);
          }
        }
        if (vouchers.length > 0) notifyCacheListeners('vouchers');
      }
      for (const t of transactions) {
        if (t && t.id) {
          const reread = await STATE.walletStorage.getTransaction(t.id);
          if (reread) upsertCache('transactions', reread, (r) => r.id);
        }
      }
      if (transactions.length > 0) notifyCacheListeners('transactions');
    } catch (err) {
      // FR-014 all-or-nothing: roll BOTH caches back. The IDB transaction
      // itself rolled back; the optimistic patches above must be undone.
      STATE.cache.vouchers.data = previousVouchers;
      notifyCacheListeners('vouchers');
      STATE.cache.transactions.data = previousTransactions;
      notifyCacheListeners('transactions');
      throw err;
    }
  });
}

function addTransaction(tx) {
  ensureInitialized('addTransaction');
  // Code-review finding #3 — optimistic upsert pre-commit so sync
  // getTransactions reads see the new row immediately. Snapshot + rollback
  // on rejection mirrors saveVoucher.
  const previousTransactions = STATE.cache.transactions.data.slice();
  if (tx && tx.id) {
    upsertCache('transactions', tx, (r) => r.id);
    notifyCacheListeners('transactions');
  }
  return enqueueWrite(async () => {
    try {
      const saved = await STATE.walletStorage.addTransaction(tx);
      upsertCache('transactions', saved, (r) => r.id);
      notifyCacheListeners('transactions');
      return saved;
    } catch (err) {
      STATE.cache.transactions.data = previousTransactions;
      notifyCacheListeners('transactions');
      throw err;
    }
  });
}

function updateTransaction(id, patch) {
  ensureInitialized('updateTransaction');
  // Code-review finding #3 — optimistic patch pre-commit.
  const previousTransactions = STATE.cache.transactions.data.slice();
  const existing = STATE.cache.transactions.data.find((r) => r && r.id === id);
  if (existing && patch) {
    upsertCache('transactions', { ...existing, ...patch, id }, (r) => r.id);
    notifyCacheListeners('transactions');
  }
  return enqueueWrite(async () => {
    try {
      const updated = await STATE.walletStorage.updateTransaction(id, patch);
      if (updated) {
        upsertCache('transactions', updated, (r) => r.id);
        notifyCacheListeners('transactions');
      }
      return updated;
    } catch (err) {
      STATE.cache.transactions.data = previousTransactions;
      notifyCacheListeners('transactions');
      throw err;
    }
  });
}

function getTransaction(id) {
  ensureInitialized('getTransaction');
  return STATE.cache.transactions.data.find((r) => r && r.id === id) || null;
}

function getTransactionsByVoucher(voucherId) {
  ensureInitialized('getTransactionsByVoucher');
  return STATE.cache.transactions.data.filter((r) => r && r.voucher_id === voucherId);
}

function getTransactions() {
  ensureInitialized('getTransactions');
  if (!STATE.cache.transactions.valid) {
    refreshCache('transactions').catch(() => { /* logged inside */ });
  }
  return STATE.cache.transactions.data;
}

function removeTransaction(id) {
  ensureInitialized('removeTransaction');
  // Code-review finding #3 — optimistic remove pre-commit.
  const previousTransactions = STATE.cache.transactions.data.slice();
  STATE.cache.transactions.data = STATE.cache.transactions.data.filter(
    (r) => r && r.id !== id
  );
  notifyCacheListeners('transactions');
  return enqueueWrite(async () => {
    try {
      const removed = await STATE.walletStorage.removeTransaction(id);
      // If the row didn't exist in IDB, also restore cache (we
      // already filtered above optimistically, but the row may have
      // been a stale local-only entry).
      if (!removed) {
        STATE.cache.transactions.data = previousTransactions;
        notifyCacheListeners('transactions');
      }
      return removed;
    } catch (err) {
      STATE.cache.transactions.data = previousTransactions;
      notifyCacheListeners('transactions');
      throw err;
    }
  });
}

/**
 * Spec 025 (T030) — bulk remove. Mirrors `removeVouchers` semantics:
 * filters the shadow cache synchronously, queues the IDB delete on the
 * write queue. Returns a Promise resolving to the actually-removed count.
 */
function removeTransactions(ids) {
  ensureInitialized('removeTransactions');
  if (!Array.isArray(ids) || ids.length === 0) return Promise.resolve(0);
  // Code-review finding #5 — snapshot for rollback.
  const previousTransactions = STATE.cache.transactions.data.slice();
  const idSet = new Set(ids);
  STATE.cache.transactions.data = STATE.cache.transactions.data.filter(
    (r) => r && !idSet.has(r.id)
  );
  notifyCacheListeners('transactions');
  return enqueueWrite(async () => {
    try {
      return await STATE.walletStorage.removeTransactions(ids);
    } catch (err) {
      STATE.cache.transactions.data = previousTransactions;
      notifyCacheListeners('transactions');
      throw err;
    }
  });
}

/**
 * Spec 025 (T030) — atomic replace-all. Mirrors `clearAndReplaceAllVouchers`
 * semantics. Updates the shadow cache synchronously, then queues the clear
 * + N inserts as a single IDB transaction on the write queue.
 */
function clearAndReplaceAllTransactions(rows) {
  ensureInitialized('clearAndReplaceAllTransactions');
  const safeRows = Array.isArray(rows) ? rows : [];
  // Code-review finding #5 — snapshot for rollback.
  const previousTransactions = STATE.cache.transactions.data.slice();
  STATE.cache.transactions.data = [...safeRows];
  notifyCacheListeners('transactions');
  return enqueueWrite(async () => {
    try {
      await STATE.walletStorage.clearAndReplaceAllTransactions(safeRows);
    } catch (err) {
      STATE.cache.transactions.data = previousTransactions;
      notifyCacheListeners('transactions');
      throw err;
    }
  });
}

// ============================================================================
// Coordination
// ============================================================================

/** Drain the write queue. Used by tests + shutdown paths. */
async function flush() {
  await STATE.writeQueue;
}

/** Subscribe to local cache-state changes (post-write or post-refresh). */
function onCacheUpdate(listener) {
  STATE.cacheListeners.add(listener);
  return () => {
    STATE.cacheListeners.delete(listener);
  };
}

// ============================================================================
// Internals
// ============================================================================

function ensureInitialized(operation) {
  if (!STATE.initialized || !STATE.walletStorage) {
    throw new Error(
      'walletStorageIntegration: ' + operation + '() called before init(). ' +
      'Call await walletStorageIntegration.init({walletStorage}) during boot.'
    );
  }
}

/**
 * Enqueue an async write so concurrent same-tab writes execute in call
 * order. The queue's chain is never broken by individual write errors
 * (per C-BR-6) — failed writes propagate to their caller but don't
 * block subsequent writes.
 */
function enqueueWrite(fn) {
  let result;
  const next = STATE.writeQueue
    .catch(() => { /* swallow upstream errors — they belong to their caller */ })
    .then(() => fn())
    .then((r) => { result = r; return r; });
  // Replace the queue head; downstream awaits on `next` to chain.
  STATE.writeQueue = next.catch(() => { /* swallow for chain only; caller still gets the rejection */ });
  // The original caller awaits on `next` so they get the real result + any rejection.
  return next.then(() => result);
}

async function refreshCache(kind) {
  // Coalesce concurrent refreshes — many stale-marks → one IDB read.
  if (STATE.refreshInFlight[kind]) {
    return STATE.refreshInFlight[kind];
  }
  const promise = (async () => {
    try {
      const data = kind === 'vouchers'
        ? await STATE.walletStorage.getAllVouchers()
        : await STATE.walletStorage.getAllTransactions();
      STATE.cache[kind].data = data || [];
      STATE.cache[kind].valid = true;
      STATE.cache[kind].lastRefreshedAt = Date.now();
      notifyCacheListeners(kind);
    } catch (err) {
      console.warn('[storage] walletStorageIntegration refresh_failed kind=' + kind + ' err=' + (err && err.message));
    } finally {
      STATE.refreshInFlight[kind] = null;
    }
  })();
  STATE.refreshInFlight[kind] = promise;
  return promise;
}

function upsertCache(kind, row, keyFn) {
  const list = STATE.cache[kind].data;
  const key = keyFn(row);
  const idx = list.findIndex((r) => r && keyFn(r) === key);
  if (idx >= 0) {
    list[idx] = row;
  } else {
    list.push(row);
  }
}

function notifyCacheListeners(kind) {
  for (const listener of STATE.cacheListeners) {
    try {
      listener({ kind });
    } catch (err) {
      console.warn('[storage] walletStorageIntegration cache_listener_error err=' + (err && err.message));
    }
  }
  // Spec 038 hotfix (2026-06-02) — bridge cache mutations to window events.
  // The balance card + activity feed listen for 'balance-updated' /
  // 'vouchers-updated' / 'transactions-updated' but most storage-layer
  // mutations (saveVoucher, deleteVoucher, updateVoucherAfterSplit,
  // applyKeepTokenToAuthoritativeStore, atomicallyWrite) never fired
  // those events. Putting the dispatch here means EVERY mutation
  // routed through the bridge wakes the UI mid-session.
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      const detail = { source: 'walletStorageIntegration.notify', kind };
      if (kind === 'vouchers') {
        window.dispatchEvent(new CustomEvent('vouchers-updated', { detail }));
        window.dispatchEvent(new CustomEvent('balance-updated', { detail }));
      } else if (kind === 'transactions') {
        window.dispatchEvent(new CustomEvent('transactions-updated', { detail }));
        // balance-updated too — many flows mutate tx-only (purchase tx,
        // sent tx) and the balance card needs to re-render activity rows.
        window.dispatchEvent(new CustomEvent('balance-updated', { detail }));
      }
    }
  } catch (_) { /* observability best-effort */ }
}

function warnOnLegacyResidue() {
  if (STATE.residueWarned) return;
  if (typeof localStorage === 'undefined') return;
  try {
    const vRes = localStorage.getItem(LEGACY_VOUCHERS_KEY);
    const tRes = localStorage.getItem(LEGACY_TRANSACTIONS_KEY);
    if (vRes || tRes) {
      console.warn(
        '[storage] legacy_localStorage_residue keys=' +
        [vRes && LEGACY_VOUCHERS_KEY, tRes && LEGACY_TRANSACTIONS_KEY]
          .filter(Boolean).join(',') +
        ' — pre-spec-024 data found in localStorage. Per spec 024 (dev only) ' +
        'this is NOT migrated. Clear browser storage manually for a fresh slate.'
      );
      STATE.residueWarned = true;
    }
  } catch {
    // localStorage access can throw in some embedded contexts; ignore.
  }
}

// ============================================================================
// Exports
// ============================================================================

const walletStorageIntegration = {
  init,
  flush,
  onCacheUpdate,

  // Voucher operations
  saveVoucher,
  getVoucher,
  getVoucherByVoucherId,
  getVouchers,
  removeVoucher,
  removeVouchers,
  clearAndReplaceAllVouchers,

  // Spec 038 — atomic voucher + tx write (FR-014)
  atomicallyWrite,

  // Transaction operations
  addTransaction,
  updateTransaction,
  getTransaction,
  getTransactionsByVoucher,
  getTransactions,
  removeTransaction,
  removeTransactions,
  clearAndReplaceAllTransactions,

  // Spec-025 cutover observability (private — only shared/storage.js calls)
  _logCutover,
};

// CommonJS export for Node test runners.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { walletStorageIntegration, default: walletStorageIntegration };
}

// Browser global — shared/storage.js consumes via window.walletStorageIntegration.
// Loaded as a classic <script> on every page that touches voucher storage
// (spec 025 FR-016). ESM `export` declarations are intentionally OMITTED:
// classic scripts treat `export` as a syntax error and abort parsing, which
// would leave the global undefined and break every reader/writer that
// references it. Node test runners (vitest) consume the module via dynamic
// `import()`, which sees the `module.exports` block above and exposes the
// same `walletStorageIntegration` key as a named export.
if (typeof globalThis !== 'undefined') {
  globalThis.walletStorageIntegration = walletStorageIntegration;
}

})();

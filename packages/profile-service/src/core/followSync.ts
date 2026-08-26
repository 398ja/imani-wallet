/**
 * NIP-02 follow-list sync core (spec 044, US4).
 *
 * Pure helpers for parsing/validating/building NIP-02 kind-3 contact-list
 * events and reconciling the local follow store with the relay. Implements
 * NIP-02 — Contact List:
 *   https://github.com/nostr-protocol/nips/blob/master/02.md
 * (pinned reference — re-test on upstream amendment, per Constitution II).
 *
 * The kind-3 event encodes follows as "p" tags:
 *   ["p", "<pubkey>", "<relay-url>", "<petname>"]
 * content is empty (relay preferences are out of scope here).
 */
import type { NostrEvent } from '../adapters/NostrLookupAdapter.js';
import type { FollowEntry } from '../types/follow.js';
import { isValidPubkey, normalizePubkey } from '../utils/validate.js';

/** Kind-3 = NIP-02 contact list. */
export const KIND_CONTACTS = 3;

/** A single followed entry as carried on the relay (NIP-02 p-tag). */
export interface RemoteFollowEntry {
  pubkey: string;
  relayHint: string | null;
  petname: string | null;
}

/** A parsed, validated remote follow list. */
export interface RemoteFollowList {
  entries: RemoteFollowEntry[];
  createdAt: number;
  eventId: string;
}

/** Optional signature verifier injected by the host (e.g. nostr-tools). */
export type VerifyEventFn = (event: NostrEvent) => boolean;

/**
 * Parse + validate a single kind-3 event for `expectedAuthor`.
 * Returns the parsed list, or null if the event is invalid (wrong kind, wrong
 * author, or failed signature). A VALID event with zero p-tags yields an
 * empty `entries` array (an intentional empty follow list) — callers
 * distinguish that from "no event" (null at the pull layer).
 */
export function parseContactListEvent(
  event: NostrEvent | null | undefined,
  expectedAuthor: string,
  verify?: VerifyEventFn
): RemoteFollowList | null {
  if (!event || event.kind !== KIND_CONTACTS) return null;
  if (!event.pubkey || !isValidPubkey(event.pubkey)) return null;
  if (!isValidPubkey(expectedAuthor)) return null;
  if (normalizePubkey(event.pubkey) !== normalizePubkey(expectedAuthor)) return null;
  if (verify && !verify(event)) return null;

  const seen = new Set<string>();
  const entries: RemoteFollowEntry[] = [];
  for (const tag of event.tags ?? []) {
    if (!Array.isArray(tag) || tag[0] !== 'p') continue;
    const raw = tag[1];
    if (typeof raw !== 'string' || !isValidPubkey(raw)) continue; // drop malformed, keep valid
    const pk = normalizePubkey(raw);
    if (seen.has(pk)) continue; // duplicates collapse to first valid occurrence
    seen.add(pk);
    entries.push({
      pubkey: pk,
      relayHint: typeof tag[2] === 'string' && tag[2].length > 0 ? tag[2] : null,
      petname: typeof tag[3] === 'string' && tag[3].length > 0 ? tag[3] : null,
    });
  }

  return { entries, createdAt: event.created_at, eventId: event.id };
}

/**
 * Pick the latest VALID kind-3 from a relay result. Highest `created_at` wins;
 * deterministic event-id tie-break (lexicographic) so every device converges
 * on the same baseline. Returns null when no valid event is present.
 */
export function pickLatestValid(
  events: readonly NostrEvent[],
  expectedAuthor: string,
  verify?: VerifyEventFn
): RemoteFollowList | null {
  let best: RemoteFollowList | null = null;
  for (const ev of events ?? []) {
    const parsed = parseContactListEvent(ev, expectedAuthor, verify);
    if (!parsed) continue;
    if (
      !best ||
      parsed.createdAt > best.createdAt ||
      (parsed.createdAt === best.createdAt && parsed.eventId > best.eventId)
    ) {
      best = parsed;
    }
  }
  return best;
}

/**
 * Build NIP-02 `p` tags from follow entries, sorted by `order`, preserving
 * relay hints + petnames where known (lossless republish — FR-017 / SC-008).
 */
export function buildContactListTags(
  entries: ReadonlyArray<Pick<FollowEntry, 'pubkey' | 'order' | 'relayHint' | 'petname' | 'createdAt'>>
): string[][] {
  const sorted = [...entries].sort((a, b) => (a.order ?? a.createdAt ?? 0) - (b.order ?? b.createdAt ?? 0));
  return sorted.map((e) => {
    const tag: string[] = ['p', e.pubkey];
    const hasPet = typeof e.petname === 'string' && e.petname.length > 0;
    const hasRelay = typeof e.relayHint === 'string' && e.relayHint.length > 0;
    if (hasRelay || hasPet) tag.push(hasRelay ? (e.relayHint as string) : '');
    if (hasPet) tag.push(e.petname as string);
    return tag;
  });
}

/** Result of a reconcile pass. */
export interface ReconcileResult {
  /** Entries to write locally as `synced` (from the remote baseline). */
  upserts: Array<{ pubkey: string; relayHint: string | null; petname: string | null; order: number }>;
  /** Pubkeys to delete locally (removed remotely, or local pending-removal). */
  removes: string[];
  /** Whether local pending changes require publishing a fresh kind-3. */
  shouldPublish: boolean;
  /** Pending (pending-publish + pending-removal) count; 0 ⇒ equivalent. */
  pendingCount: number;
}

/**
 * Reconcile local entries against the latest remote list (research R2):
 * remote is the baseline; local pending mutations are re-applied so an in-flight
 * change is never lost; remote removals (a synced-locally pubkey absent from a
 * newer remote, with no local pending) drop locally.
 */
export function reconcile(local: ReadonlyArray<FollowEntry>, remote: RemoteFollowList | null): ReconcileResult {
  const pendingPublish = local.filter((e) => e.syncState === 'pending-publish');
  const pendingRemoval = new Set(local.filter((e) => e.syncState === 'pending-removal').map((e) => e.pubkey));
  const pendingCount = pendingPublish.length + pendingRemoval.size;

  if (!remote) {
    // No remote baseline yet: keep local as-is; publish if we have pending work.
    return { upserts: [], removes: [], shouldPublish: pendingCount > 0, pendingCount };
  }

  const upserts: ReconcileResult['upserts'] = [];
  const removes: string[] = [];
  const remotePks = new Set(remote.entries.map((e) => e.pubkey));
  const localByPk = new Map(local.map((e) => [e.pubkey, e]));

  // Remote baseline → synced locally (unless the user is removing it locally).
  // Emit an upsert ONLY when the local row is missing or actually differs, so a
  // steady-state sync produces zero writes and no `onChange` re-render churn
  // (the coordinator marks every applied upsert `synced` and flags `changed`).
  remote.entries.forEach((re, idx) => {
    if (pendingRemoval.has(re.pubkey)) return;
    const le = localByPk.get(re.pubkey);
    const upToDate =
      le !== undefined &&
      le.syncState === 'synced' &&
      le.order === idx &&
      (le.relayHint ?? null) === (re.relayHint ?? null) &&
      (le.petname ?? null) === (re.petname ?? null);
    if (!upToDate) {
      upserts.push({ pubkey: re.pubkey, relayHint: re.relayHint, petname: re.petname, order: idx });
    }
  });

  // Local `synced` entries absent from a present remote, and not pending →
  // removed on another device; drop locally.
  for (const e of local) {
    if (e.syncState === 'synced' && !remotePks.has(e.pubkey) && !pendingRemoval.has(e.pubkey)) {
      removes.push(e.pubkey);
    }
  }
  // Local pending-removal → ensure gone locally too.
  pendingRemoval.forEach((pk) => {
    if (!removes.includes(pk)) removes.push(pk);
  });

  // pending-publish entries the remote doesn't have yet stay as local follows;
  // they are not in `upserts` (they keep their pending-publish state) but they
  // mean we must publish.
  const localOnlyPending = pendingPublish.filter((e) => !remotePks.has(e.pubkey));

  const shouldPublish = localOnlyPending.length > 0 || pendingRemoval.size > 0;
  return { upserts, removes, shouldPublish, pendingCount };
}

/**
 * BundleSender property-based tests for spec 012-multi-voucher-send (T060).
 *
 * For any random voucher set with 1..20 vouchers and any send amount that the set
 * covers, the resulting BundlePlan must satisfy three invariants:
 *
 *   FR-002 — earliest-expiry-first: each part's source voucher's expiry is <= the
 *            next part's source voucher's expiry.
 *   FR-003 — no skipping for fewer parts: the orchestrator never skips an
 *            earlier-expiry eligible voucher in favour of a later-expiry one to
 *            produce fewer parts.
 *   FR-009a — change preserved on the latest-expiry source: the change-bearing
 *            part (if any partial part exists, it's always the LAST part) carries
 *            the source voucher's expiry, never any other voucher's expiry.
 *
 * No external property library — uses a seeded LCG so failures are reproducible
 * via the seed printed on assertion failure.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createBundleSender,
  type BundleSendAdapters,
  type BundleSendApiAdapter,
  type BundleSendVoucherAdapter,
  type BundleSendJournalAdapter,
  type BundleSendTransactionAdapter,
  type BundleSendIdAdapter,
  type BundleSendClockAdapter,
  type BundleCandidateSelection,
  type AtomicSendInitiateParams,
} from '../src/orchestrator';
import type {
  BundleSendJournalEntry,
  Voucher,
  MerchantGroup,
  BundleSendParams,
} from '../src/types';

const RECIPIENT_HEX = 'a'.repeat(64);
const FROZEN_NOW = new Date('2026-05-02T12:00:00.000Z');
const RUN_COUNT = 50; // total random scenarios per property; bumps up coverage without slowing the suite

/* ---------- Seeded LCG for reproducible randomness ---------- */

function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function makeVoucher(id: string, faceValue: number, expiresAtMs: number): Voucher {
  return {
    voucher_id: id,
    token: `cashuB-${id}`,
    face_value: faceValue,
    face_unit: 'EUR',
    face_decimals: 2,
    token_amount: faceValue * 10,
    issuer_id: 'merchant-1',
    expires_at: new Date(expiresAtMs).toISOString(),
    status: 'active',
  } as unknown as Voucher;
}

function makeGroup(vouchers: Voucher[]): MerchantGroup {
  return {
    groupKey: 'merchant-1-EUR-2',
    merchantId: 'merchant-1',
    unit: 'EUR',
    decimals: 2,
    totalFaceValue: vouchers.reduce((s, v) => s + ((v as { face_value?: number }).face_value ?? 0), 0),
    totalTokenAmount: 0,
    vouchers,
  } as unknown as MerchantGroup;
}

function makeSelection(vouchers: Voucher[], amount: number): BundleCandidateSelection {
  const total = vouchers.reduce((s, v) => s + ((v as { face_value?: number }).face_value ?? 0), 0);
  return {
    vouchers,
    needsConsolidation: vouchers.length > 1 && total > 0,
    totalAvailable: total,
    isValid: total >= amount,
    voucherIds: vouchers.map((v) => (v as { voucher_id?: string }).voucher_id ?? ''),
    groupMetadata: { merchantId: 'merchant-1', unit: 'EUR', decimals: 2 },
  };
}

interface ApiCall { params: AtomicSendInitiateParams; idempotencyKey: string }

function makeAdapters(opts: { keepTokens: Array<{ token: string; faceValue: number } | null> }): {
  adapters: BundleSendAdapters;
  apiCalls: ApiCall[];
  voucherCalls: Array<{ voucherId: string; partAmount: number; sourceExpiresAt: string | null; keepFaceValue: number | null }>;
} {
  const apiCalls: ApiCall[] = [];
  const voucherCalls: Array<{ voucherId: string; partAmount: number; sourceExpiresAt: string | null; keepFaceValue: number | null }> = [];
  const journalState = new Map<string, BundleSendJournalEntry>();
  const api: BundleSendApiAdapter = {
    initiateAtomicSend: vi.fn(async (params, idempotencyKey) => {
      apiCalls.push({ params, idempotencyKey });
      return { send_id: `send-${apiCalls.length - 1}`, status: 'PENDING', keep_token: null };
    }),
    awaitTerminal: vi.fn(async (sendId) => {
      const idx = parseInt(sendId.replace('send-', ''), 10);
      const keep = opts.keepTokens[idx];
      return {
        status: 'COMPLETED',
        keep_token: keep?.token ?? null,
        keep_face_value: keep?.faceValue ?? null,
      };
    }),
  };
  const voucher: BundleSendVoucherAdapter = {
    applyKeepToken: vi.fn(async (voucherId, partAmount, _kt, keepFaceValue, _ka, sourceExpiresAt) => {
      voucherCalls.push({ voucherId, partAmount, sourceExpiresAt, keepFaceValue });
    }),
  };
  const journal: BundleSendJournalAdapter = {
    begin: vi.fn(async (e) => { journalState.set(e.bundleId, e); return e; }),
    upsert: vi.fn(async (e) => { journalState.set(e.bundleId, e); return e; }),
    markTerminal: vi.fn(async (id, state) => {
      const ex = journalState.get(id);
      const next = { ...(ex ?? ({} as BundleSendJournalEntry)), bundleId: id, state };
      journalState.set(id, next as BundleSendJournalEntry);
      return next as BundleSendJournalEntry;
    }),
  };
  const transaction: BundleSendTransactionAdapter = {
    recordSentBundle: vi.fn(async () => ({ transactionId: 'tx' })),
  };
  const ids: BundleSendIdAdapter = { newBundleId: () => 'b'.repeat(32) };
  const clock: BundleSendClockAdapter = { now: () => FROZEN_NOW };
  return { adapters: { api, voucher, journal, transaction, ids, clock }, apiCalls, voucherCalls };
}

function paramsFor(group: MerchantGroup, amount: number): BundleSendParams {
  return { userId: 'u'.repeat(64), recipient: RECIPIENT_HEX, merchantGroup: group, amount, callbacks: {} };
}

/* ---------- Property runner ---------- */

interface PropertyScenario {
  seed: number;
  vouchers: Voucher[];
  amount: number;
}

function generateScenario(seed: number): PropertyScenario {
  const rng = lcg(seed);
  const n = randInt(rng, 1, 20);
  const baseExpiryMs = Date.parse('2026-05-15T00:00:00.000Z');
  const vouchers: Voucher[] = [];
  let totalAvailable = 0;
  for (let i = 0; i < n; i++) {
    const faceValue = randInt(rng, 1, 200);
    // Random expiry days in [0, 90), with collisions possible (FR-003 tiebreak path).
    const daysOut = randInt(rng, 0, 89);
    const expiresAtMs = baseExpiryMs + daysOut * 86_400_000;
    vouchers.push(makeVoucher(`v${i}`, faceValue, expiresAtMs));
    totalAvailable += faceValue;
  }
  // Pick an amount in [1, totalAvailable].
  const amount = randInt(rng, 1, Math.max(1, totalAvailable));
  return { seed, vouchers, amount };
}

function annotate(label: string, s: PropertyScenario): string {
  const summary = s.vouchers.map((v) => {
    const fv = (v as { face_value?: number }).face_value ?? 0;
    const ea = (v as { expires_at?: string }).expires_at ?? '?';
    return `${(v as { voucher_id?: string }).voucher_id}=${fv}@${ea.slice(0, 10)}`;
  }).join(', ');
  return `${label} | seed=${s.seed} amount=${s.amount} vouchers=[${summary}]`;
}

/* ---------- The property ---------- */

describe('BundleSender T060 — property: plan invariants over random voucher sets', () => {
  it.each(Array.from({ length: RUN_COUNT }, (_, i) => i + 1))(
    'random scenario %s satisfies FR-002 + FR-003 + FR-009a',
    async (seed) => {
      const scenario = generateScenario(seed);
      const { vouchers, amount } = scenario;

      // The orchestrator's send() doesn't expose the plan publicly, but every part's
      // (voucherId, partAmount, sourceExpiresAt) shows up in the api.initiateAtomicSend
      // call sequence. We rebuild the observed order from there.
      const { adapters, apiCalls, voucherCalls } = makeAdapters({
        // Pre-fill keep tokens for every potential part — orchestrator only consumes
        // the ones it needs.
        keepTokens: Array.from({ length: vouchers.length }, (_, i) => ({ token: `kt-${i}`, faceValue: 0 })),
      });

      const sender = createBundleSender({ adapters });
      await sender.send(paramsFor(makeGroup(vouchers), amount), makeSelection(vouchers, amount));

      // Plan covers exactly the requested amount.
      const totalDrawn = apiCalls.reduce((s, c) => s + (c.params.amount ?? 0), 0);
      expect(totalDrawn, annotate('totalDrawn != amount', scenario)).toBe(amount);

      // ---------- FR-002: earliest-expiry-first across consecutive parts ----------
      for (let i = 1; i < apiCalls.length; i++) {
        const prevExpiry = apiCalls[i - 1].params.expiresAt ?? Number.MAX_SAFE_INTEGER;
        const curExpiry = apiCalls[i].params.expiresAt ?? Number.MAX_SAFE_INTEGER;
        expect(prevExpiry, annotate(`FR-002 violated at part ${i}: prev=${prevExpiry} cur=${curExpiry}`, scenario))
          .toBeLessThanOrEqual(curExpiry);
      }

      // ---------- FR-003: no skipping for fewer parts ----------
      // Walk the planned sequence; for each consumed voucher, any UN-consumed voucher
      // that has STRICTLY EARLIER expiry must have been zero face value (so it was
      // legitimately skipped because it carried no value).
      const consumedIds = new Set(apiCalls.map((c) => c.params.voucherId));
      const lastConsumedExpiry = apiCalls.length > 0
        ? (apiCalls[apiCalls.length - 1].params.expiresAt ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER;
      for (const v of vouchers) {
        const id = (v as { voucher_id?: string }).voucher_id ?? '';
        if (consumedIds.has(id)) continue;
        const fv = (v as { face_value?: number }).face_value ?? 0;
        const expIso = (v as { expires_at?: string }).expires_at ?? null;
        const expSec = expIso ? Math.floor(new Date(expIso).getTime() / 1000) : Number.MAX_SAFE_INTEGER;
        // Only skipping is allowed if EITHER the voucher has zero value, OR it expires
        // strictly LATER than every consumed voucher (i.e., we filled the amount
        // before we needed it). Strict-earlier-expiry-and-non-zero-value would be a
        // violation of FR-003.
        if (fv > 0 && expSec < lastConsumedExpiry) {
          throw new Error(annotate(
            `FR-003 violated: skipped earlier-expiry voucher ${id} (fv=${fv}, exp=${expSec}) while consuming a later-expiry one (lastConsumedExp=${lastConsumedExpiry})`,
            scenario
          ));
        }
      }

      // ---------- FR-009a: change preserved on the LAST part's source voucher ----------
      // The orchestrator only ever produces partial draw on the LAST part. For the
      // change-bearing keep_token call (if any), the source voucher's expiry passed
      // to applyKeepToken must be the LAST part's source voucher's expiry — never
      // an earlier voucher's.
      if (voucherCalls.length === 0) return; // single-voucher short-circuit may bypass voucher adapter when no debit happens

      const lastApiCall = apiCalls[apiCalls.length - 1];
      const lastSourceVoucher = vouchers.find((v) => (v as { voucher_id?: string }).voucher_id === lastApiCall.params.voucherId);
      const lastSourceExpiryIso = (lastSourceVoucher as { expires_at?: string } | undefined)?.expires_at ?? null;

      // Find the change-bearing applyKeepToken call: the one whose voucherId matches
      // the last consumed voucher AND whose partAmount < that voucher's face value.
      const lastFaceValue = (lastSourceVoucher as { face_value?: number } | undefined)?.face_value ?? 0;
      const isPartialDraw = lastApiCall.params.amount! < lastFaceValue;
      if (!isPartialDraw) return; // no change → FR-009a vacuously satisfied

      const changeCall = voucherCalls.find((c) => c.voucherId === lastApiCall.params.voucherId);
      expect(changeCall, annotate('FR-009a: change call missing for partial last part', scenario)).toBeDefined();
      expect(changeCall!.sourceExpiresAt, annotate(
        `FR-009a: change voucher expiry ${changeCall!.sourceExpiresAt} != last source voucher expiry ${lastSourceExpiryIso}`,
        scenario
      )).toBe(lastSourceExpiryIso);
    }
  );
});

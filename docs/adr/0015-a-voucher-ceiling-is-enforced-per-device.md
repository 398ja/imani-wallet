# A voucher's ceiling is enforced per device, and bounded across devices by the mint

A voucher's redemption ceiling ("this £10 voucher has £4 left") is computed from
the stall's **own local rows**: the sum of claims filed against the `issued` row
(`redemptionLedger.ts`, `merchantClaim.ts`). On one device that check and the
write it guards now run under one Web Lock per voucher (`redeemLockName`), held
from the check through the mint swap to the row write, so two tabs serialise
(#97, test: `merchantClaim.test.ts`, "two tabs redeeming one voucher past its
ceiling").

Two devices do not share that lock, or those rows until the relay backup
round-trips. **We accept that, and do not add a server-side ceiling.**

## Why the gap is narrower than it looks

Value in this wallet is proof-backed. A redemption is a mint swap of the
customer's proofs, the mint refuses a proof it has already spent, and the
credit for a part is derived from the proofs presented (`tokenAmount × ratio`,
clamped to the signed face, `creditableFaceValue`). So "two tills each honour
the full remaining value" needs two sets of **unspent** proofs whose credits
together exceed the face. A customer holding one voucher's proofs can present
each proof once, anywhere; the mint makes every proof count once across every
device. The per-part cumulative rounding in `@imani/redemption` stops splitting
from manufacturing value on one device.

What the device-local ceiling adds on top is protection against a voucher whose
proofs are worth MORE than its face (a rewritten ratio on a legacy voucher, or
rounding across parts). On one device the ceiling catches it. Across two devices
it does not, and the excess is bounded by that mismatch: at most the rounding
across the parts each device saw, or, for a legacy voucher with an unsigned
ratio, what those proofs would credit before the per-presentation clamp to the
signed face.

## Options considered

- **Proof-backed value only** (drop the counter, let the mint be the ceiling).
  This is already what bounds the multi-device case. We keep the local counter
  as well, because it is what enforces the signed face against a legacy ratio
  and against cumulative rounding, and it costs nothing offline.
- **Server ceiling**, a `POST /redemptions/{voucherId}/reserve` with
  `UPDATE ... WHERE remaining >= ?`. Rejected: redemption must not need the
  network to authorise it (ADR 0003), and the till is exactly where a signal is
  least reliable. It would also give the gateway a per-voucher record of a
  stall's takings, which the attestation design (`attestation.ts`) exists to
  avoid.
- **Aggregate relay-published claims before redeeming.** The kind-7376 rows are
  already backed up and restored (`txRecords.ts`), so a second device converges
  on the first's claims at its next restore. Pulling that into the redeem path
  would be a relay round trip at the till and only narrows the window. Not done.

## What this costs, and where it is said

- A stall running two devices can, for a legacy or rounding-affected voucher,
  honour slightly more than its face if the same voucher's parts reach both
  devices before either has restored the other's rows. The mint still refuses
  every double-spent proof.
- The claimed and outstanding figures are **this device's** figures. The voucher
  record screen says so under the claimed bar, and `imani-docs/wallet/merchants.md` says so
  where it describes that screen.
- Claims that were never filed (#95) weaken the ceiling further. The paths that
  wrote a redemption without a claim are closed or pinned (`claimPaths.test.ts`,
  `burnUnreachable.test.ts`), and `claimReconcile.ts` re-files pre-#90 rows at
  login under the same lock.

## Revisit if

A stall routinely runs more than one till against the same vouchers, or legacy
(unsigned-ratio) vouchers are still in circulation in volume. Then the relay
aggregation option becomes worth its round trip.

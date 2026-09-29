# The wallet swaps its own receives

This note explains why the gateway performs the receive swap today, what that
costs us, and the design that removes it. It closes two open bugs at once:
imani-gateway-customer#133 (the gateway holds a spendable copy of every coupon
you receive) and imani-wallet#123 (a receive whose response is lost is
unrecoverable).

It is an explanation, not a how-to. It argues for a design and states what the
design does not solve.

## Status

The mechanism is built and tested. It is **not yet wired in**, so neither bug is
closed in a shipped build:

| Piece | State |
|---|---|
| Mint and unit pinned before crediting | Live, on both crediting paths |
| Wallet-side blinding, swap and unblinding | Built, verified against the real mint |
| Swap intent persisted, lost response recovered | Built, verified against the real mint |
| The receive orchestration | Built, verified against the real mint |
| A transport against the real mint | Built, verified against the real mint |
| Decode, check and sign a token string | Built, nothing calls it yet |
| Recovering interrupted receives at start-up | Built, wired, no save behind it yet |
| The issuer re-signing call for vouchers | Built in the gateway, not called from here |

**The live receive is still the gateway endpoint.** Everything above exists and is
tested; what remains is the last edit, replacing the `api.receive` call in
`tokenRedemption.js`, and that is deliberately not done yet. Until it is, the
custody exposure described below is unchanged.

Two things have to land with that edit rather than after it:

- **A save for recovered proofs.** The start-up sweep is wired and currently passes
  a save that throws, because nothing creates the intents it reads. A save that
  quietly dropped the proofs would look wired and lose money the first time it
  fired.
- **A voucher receive that works.** `receiveTokenByOwnSwap` refuses a voucher
  outright, because a wallet-chosen swap generates random secrets and a voucher's
  secret carries its whole identity. The gateway can now re-sign
  (`POST /api/v1/wallet/vouchers/reissue`), and calling it from here is not built.
  Switching the plain-ecash path over first is possible, and means two receive
  mechanisms live at once.

## The shape of the problem

A Cashu proof is a bearer instrument. Whoever knows its secret and its
signature can spend it. So when a coupon arrives, the sender still holds
everything needed to spend it, and so does anyone who saw it in transit.

The only thing that makes an arriving coupon *yours* is swapping it at the mint
for fresh proofs whose secrets only you know. That swap burns the old proofs,
which is what ends the sender's ability to spend them. A swap on receipt is
therefore not an implementation detail we can optimise away. It is the
double-spend protection.

The question is not **whether** to swap. It is **who performs it**.

## What happens today

The gateway performs it.

`POST /api/v1/wallet/receive` reaches `JdbcWalletPort.receive`, which calls
`H2WalletService.importProofs`. That generates the output secrets, generates
the blinding factors, swaps at the mint, unblinds, and then does two things
with the resulting proofs:

1. saves them into the gateway's own float
   (`aggregateRepository.save(aggregate, newProofs)`), and
2. re-encodes the same proofs as the token returned to you.

Both consequences follow from the same fact: the gateway chose the secrets, so
the gateway knows them.

### Consequence one: custody (#133)

After every receive, two parties hold the same spendable proofs. The gateway's
own send and melt paths select from that float, and the selection query has no
provenance column, so a recipient's proof is indistinguishable from the
gateway's own money. Nothing removes it when the escrow is acknowledged.

This breaks the non-custodial promise directly. On staging the float holds
about 3.0M sats, and no query can say how much of it shadows a customer's
holdings.

### Consequence two: the lost receive (#123)

The fresh token exists in exactly one place: the body of one HTTP response. If
that response is lost, and there are at least seven ways to lose it, the money
has been minted and only the gateway has it.

The wallet retries with the same idempotency key. Since gateway-customer V4 the
escrow keeps no copy of the token, so the replay answers `token: null`. The
wallet correctly refuses to book a receive with no token, the escrow stays
`HELD`, and the customer's coupon is missing. This happened in three of the
last three post-deploy runs.

These are not two bugs. They are one design decision seen from two sides.

## The design: the wallet swaps

The wallet generates its own output secrets and blinding factors and posts the
swap to the mint itself. The gateway is not in the path.

Everything this needs already exists:

- **The crypto.** The wallet already depends on `@cashu/crypto`, which provides
  `blindMessage`, `constructProofFromPromise`, `hashToCurve` and the NUT-09 and
  NUT-11 modules.
- **The reachability.** The mint is public and its CORS policy already names
  the wallet's origin. `OPTIONS /v1/swap` with `Origin: https://wallet.staging.398ja.xyz`
  returns that origin with `POST` allowed.
- **A worked example.** `src/lib/__tests__/burnProbe.test.ts` already mints,
  blinds, swaps and checks state directly against the staging mint with no
  gateway involved.
- **The key handling.** `src/lib/witness.ts` already signs NUT-11 witnesses in
  the page, for the documented reason that the gateway must never be able to.

What changes is which party calls `/v1/swap`.

### Why this closes both bugs rather than mitigating them

- **#133 stops existing.** The gateway never learns a secret and never learns a
  blinding factor, so there is no copy to store, nothing to delete on
  acknowledgement, and no float separation to build.
- **#123 stops existing.** If the swap response is lost, the wallet re-posts
  the same blinded outputs. The mint replays its own response (NUT-19), or the
  wallet asks for the signatures back (NUT-09 `/v1/restore`). Recovery needs
  nobody's cooperation but the mint's. No stored token, no escrow replay.

## Locking at issuance, and what it buys

A coupon bought by a named customer is already minted locked to that customer's
key, as `P2PK_VOUCHER` (issue #58). The mint runs both conditions: the voucher
checks and the P2PK lock. So the gateway, which holds no customer keys, cannot
spend it.

This is the right design and it is already implemented. It also removes the
receive swap in the most common case, but not in every case, and the difference
matters.

**A lock protects you from everyone except the person it names.**

| Case | Swap needed on receipt | Who swaps | Gateway involved |
|---|---|---|---|
| You buy a coupon | **No.** It is minted locked to you | Nobody | No |
| Another customer sends you theirs | Yes, to re-lock to your key | The wallet | One signing call |
| A bearer coupon | Yes, to make it yours | The wallet | **No.** See "Decisions taken" |

The first row is the common path, and it loses the swap entirely. Nothing to
lose, nothing to store, no gateway call. Both bugs are absent by construction.

The second row still needs the swap, and it needs it *precisely because* the
sender is the one person the old lock does not protect you from. Their coupon
was locked to them. Until it is re-locked to you, they can still spend it.

Bearer coupons stay supported. They are the weakest case and always have been:
no lock means the swap is the only protection, which is exactly why it must
happen on receipt.

## The one place the gateway is unavoidable

Re-locking a voucher requires the issuer to sign again.

The issuer's signature commits to `[kind, "data_hex", "nonce", [tags]]`
(`VoucherCanonicalBytes`). The lock key **is** `data`. Change the owner and the
old signature no longer verifies, and the mint refuses the proof with
`voucher_signature_invalid`. There is no way around this that does not weaken
the signature, and we have already rejected weakening it: cashu-voucher#46 and
#47 were closed for exactly that reason.

So a transfer needs one call to the gateway: the wallet proposes the new secret,
the gateway signs it as issuer, and the wallet blinds it and swaps.

**This is a signing step, not custody.** The gateway sees the secret but never
the blinding factor, and a proof needs `C` to spend. `C = C_ - rK` requires `r`,
which never leaves the wallet. The gateway can compute `Y` and watch whether the
proof gets spent, which is a privacy leak worth naming, but it cannot spend it.

### Why that call must not be an open oracle

This is the same hazard the cashu-voucher#47 security review found, in a new
shape. A gateway that signs any voucher secret a wallet asks for is a forgery
machine: the mint balances amounts but never sees output secrets, so a lock
holder could swap a few sats into outputs carrying a valid signed tag set and
mint unlimited copies of a coupon.

Two facts make the call safe to offer:

1. **The mint refuses to mix voucher and regular proofs in one swap**
   (`validateNoMixedProofTypes`). So sats cannot be laundered into voucher
   proofs through a swap. A voucher output must come from a voucher input.
2. **`/v1/checkstate` is public.** The gateway can verify for itself that the
   old proof is `SPENT` before it signs the replacement.

So the binding is: **the gateway re-signs only for a proof it can see was
genuinely spent.** That makes re-signing a *move* rather than a *duplication*.
The number of valid signed vouchers cannot grow, because each new signature
costs a burnt predecessor.

The exact ordering needs care, and is the main thing to get right in
implementation:

- Sign **after** the old proof is spent, and the wallet has a window where it
  holds a spent input and an unsigned output. It must persist its secrets and
  blinding factors before swapping, or a lost response is unrecoverable.
- Sign **before**, and the oracle is open again.

The resolution is that the swap and the re-sign are the same transition seen
from two sides, and the wallet must be the one holding the recovery material.
This is why the wallet persisting its intent before the request is not optional.

## The issuance warrant survives this unchanged

A warrant attests that something outside the issuing service authorised a sale.
It matters here because a receive re-locks a coupon, and anything that breaks
the warrant would turn a verified coupon into an unverifiable one.

It survives, and the reason is structural rather than lucky. The warrant's
digest covers `issuerId`, `saleTotalMinor`, `faceDecimals`, `unit` and
`saleNonce`. **It does not cover the lock key, the nonce or the voucher id.**
So re-locking changes nothing the warrant committed to.

Verification is a ceiling test: this coupon's face value must not exceed the
warranted sale total. That test is already designed to survive a coupon being
split, because a split lowers face value and a ceiling stays true when the
number underneath it falls. A re-locked coupon is the same coupon at the same
face value, so the ceiling holds for exactly the same reason.

Two consequences follow, and both are requirements on the re-signing call:

- **The warrant tag must be carried across verbatim.** It is one of the tags the
  issuer signature covers, so the gateway re-signs it along with everything
  else. Dropping it does not merely lose a nice-to-have. An absent warrant tag
  means "this coupon predates warrants and the issuer said nothing", which is a
  different and weaker claim than a warrant whose form is `none`. Silently
  turning the second into the first is how a stripped warrant reads as a legacy
  coupon.
- **The re-signing call must not alter face value, unit or decimals.** Those are
  what the warrant's digest binds. Changing any of them under a carried-over
  warrant would produce a coupon whose warrant verifies against numbers it no
  longer has.

So the re-signing call changes the lock key and the nonce, and nothing else.
That is a narrow enough contract to state as a test rather than a convention.

## The wallet pins the mint and unit before crediting

A received voucher is credited today without checking which mint issued the
proofs or what unit they are in. `voucherToken.ts` reads the token's `m` and `u`
and checks neither, and the `getMintUrl` hook is optional. So a copy of a signed
voucher secret, backed by proofs from a mint nobody trusts, is credited as
money.

That is already a bug and is filed as such. This design promotes it to a
requirement, for two reasons:

- **The wallet now talks to the mint directly**, so the mint URL stops being
  something the gateway resolved and becomes an input the wallet acts on. An
  unchecked URL is no longer just a crediting error, it is where the wallet
  sends its swap.
- **The signature does not bind the mint.** The issuer signature covers the
  voucher's terms, not which mint holds the value behind them, so no amount of
  signature checking substitutes for this.

So: before crediting, and before swapping, the wallet requires that the token's
mint URL is the trusted mint and its unit is `sat`. Anything else is refused
rather than credited at a lower confidence. This is a check the wallet can make
alone, with no network call, which is what makes it worth doing at both points.

## Decisions taken

These were open when this note was first drafted and have since been settled.

**A foreign issuer's voucher is not re-signed.** The gateway signs only vouchers
it issued, which is what `OwnIssuanceVoucherResigner` already enforces. The
consequence is deliberate: a coupon from another issuer can be held and redeemed
at its own issuer, but it cannot be re-locked, so it cannot be transferred onward
through us. The alternative is worse. Signing another issuer's voucher would mean
asserting terms we have no authority over, and a gateway willing to do that is a
gateway whose signature means nothing.

**The transfer attestation in ADR 0014 does not change.** It records that a
transfer happened, which is a claim about history. Re-locking changes who can
spend, which is a claim about control. They answer different questions, the two
already coexist, and collapsing them would make the attestation load-bearing for
spending. Nothing to do here.

**Bearer vouchers are not re-signed on receipt.** The swap still happens, because
that is what burns the sender's copy, but the voucher keeps its original
signature and its original bearer form. Re-signing would mean minting a fresh
signed voucher on a bearer secret the gateway cannot tie to a named holder, which
is the broadest version of the oracle this design is trying to close. Receiving a
bearer voucher therefore needs no gateway call at all.

That last decision interacts with a filed cashu-mint bug: the mint does not check
unlocked vouchers' signatures. So today a bearer voucher's carried-over signature
is not verified by the mint anyway, and the protection on this path is the swap
and the wallet's own verification. That is a reason to fix the mint bug, not a
reason to re-sign bearer vouchers.

## What is deliberately not solved here

- **Numeric tags have several wire forms under one signature**
  (cashu-voucher, filed). Java and TypeScript can read different face values
  from the same signed voucher. This design does not fix it and is not made
  worse by it, but the re-signing call should refuse a non-canonical rendering.
- **The mint does not check unlocked vouchers' signatures** (cashu-mint, filed).
  Independent of this design, and the reason bearer vouchers are the weakest
  case. Worth fixing on its own merits, as noted under "Decisions taken".
- **The privacy leak.** The gateway learns each voucher output secret at the
  signing call and can watch spentness. Blind-signing the secret is not possible
  with BIP-340 as specified. Worth a follow-up, not a blocker.

- **An unfinished receive does not survive losing the device.** The secrets and
  blinding factors live in that browser's storage and nowhere else, so a wallet
  restored from a seed on a new device cannot rebuild them. Restore is keyed on the
  blinded message, and the blinded message cannot be rebuilt without the blinding
  factor, so the mint cannot help either.

  NUT-13 derives both from a seed, which would close this for plain ecash. It
  cannot close it for vouchers: a voucher secret carries an issuer signature no
  derivation produces. Using it for the plain path only is worth doing and is not
  done here. Until then the exposure is bounded by how long a receive stays
  unfinished, which is normally seconds.

- **A keyset that charges an input fee.** Amounts are requested to equal the
  inputs exactly, which NUT-02 refuses when a fee applies, so every receive would
  fail on a fee-bearing keyset. The failure is safe rather than lossy: the mint
  refuses before signing and the inputs stay spendable. Staging reports
  `input_fee_ppk: 0` today, and the fee should be read from the keyset rather than
  assumed to stay zero.

Pinning the mint and unit was on this list when it was only a filed bug. It is
now a requirement of this design and has its own section above.

## No migration

Staging is a development environment. There is no compatibility path and no
support for old clients: the receive endpoint's proof-importing behaviour is
removed rather than deprecated, existing `HELD` escrows are not recovered, and
existing staging coupons may stop working. New test coupons are issued after the
deploy.

This is the same clean-break stance taken elsewhere in this stack, and it is
what makes the design small: there is no dual path to maintain, and the gateway
float logic leaves the receive path entirely rather than being fenced off.

## What this changes, by component

- **imani-wallet.** Generates output secrets and blinding factors, persists them
  before swapping, calls `/v1/swap` at the mint, unblinds locally. Recovers a
  lost response via NUT-19 replay or NUT-09 restore. Pins the mint URL and unit.
- **imani-gateway-customer.** The receive path stops importing proofs. Keeps one
  endpoint that re-signs a voucher secret for a demonstrably spent predecessor.
  The escrow becomes a claim ledger and nothing more.
- **imani-wallet-lib.** The receive-side import path is no longer used by the
  gateway.
- **cashu-mint.** No change required by this design. The separate signature and
  mixing issues are filed independently.

Only one of the three receive cases involves the gateway at all, and in that one
it signs without ever being able to spend.

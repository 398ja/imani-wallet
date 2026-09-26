# A customer-to-customer transfer is signed by both parties, under keys that name neither

When one customer sends a voucher to another, the sender now signs the
transfer and the receiver publishes an attestation that they received it (#91).
Neither signature is made with an identity key in public, neither can block the
transfer, and a customer still never publishes a kind-7377.

This note describes payload **version 2**. Version 1 shipped in 38a93a8 and
was withdrawn before release after review; see "Why v1 was refused" at the end.
Every reader refuses v1.

## The claim is different, so the kind is different

A kind-7377 says "I honoured this coupon". `reconcileAttestations` reads every
7377 under a merchant's ledger key and matches it to a redemption row, and the
audit reader sums their commitments. A customer receiving a gift has honoured
nothing, and a 7377 from them would be a false entry in a ledger that has no
row to match it.

The receiver's claim is "I received this transfer from the holder of this
sender key". That gets its own kind, **7378** (`TRANSFER_RECEIPT_KIND` in
`src/lib/attestationKind.ts`), beside 7375/7376/7377 for the same reason 7377
sits there. It is a regular kind: append-only, like the redemption ledger. No
other number in 7378's neighbourhood is used anywhere in this repo or its
sibling repos. The only hits there are coverage-HTML line numbers and UUID
fragments in imani-apps and imani-bridge.

## What travels, and how

The gateway cannot carry the sender's signature. `/api/v1/atomic-send` accepts
a fixed set of fields and ignores the rest, and the only free-text field, `memo`,
is hashed into the idempotency check, embedded in the Cashu token and shown to
the recipient as their note. So the sender publishes a **second NIP-17 gift
wrap** of its own, once the saga reports `COMPLETED`. Its content is:

```json
{
  "type": "imani_transfer_signature",
  "v": 2,
  "transfer": "<sent_voucher_id>",
  "nonce": "<HMAC(sender key, transfer, recipient), hex>",
  "sender": "<sender identity pubkey>",
  "recipient": "<recipient identity pubkey>",
  "amount": 250, "unit": "EUR", "decimals": 2,
  "transferKey": "<sender's per-transfer pubkey>",
  "transferSig": "<transferKey over tag, receiver key, commitment, unit, decimals>",
  "bareSig": "<transferKey over tag, receiver key, and 'none'>",
  "sig": "<sender IDENTITY signature over all of the above>"
}
```

`transfer` is `sent_voucher_id`, which the gateway already defines as
`sha256(send_token)[:32]` and returns to the sender on the status response. The
receiver computes the same value from the token they redeem
(`getTokenFingerprint`). It is the one identifier both parties hold without the
sender ever holding the send token, which stays server-side.

An idempotent `initiate` can answer with a send that is already `COMPLETED`, so
the wallet never polls and never sees `sent_voucher_id`. `awaitAndSettle` then
reads the status once more for that one field. A gateway too old to return it,
or a failed read, means the send is not signed, and nothing else changes.

`unit` is restricted to the wallet's alphabet (three to five uppercase letters:
ISO 4217 codes plus SAT, SATS, MSAT, BTC, FCFA), so it can carry neither the
digest separator nor a `cashuB...` string. `decimals` is 0 to 8.

`v` is there so a later version can add fields: #94's signed bundle manifest is
the expected first one. A reader refuses a version it does not know.

## Which key signs what

Three keys, and only one of them is an identity key:

| Signature | Key | Seen by |
|---|---|---|
| `sig` over the whole payload | sender IDENTITY | the receiver only (inside the gift wrap) |
| `transferSig` or `bareSig` | sender per-transfer key | public, on the 7378 |
| the 7378 event itself | receiver per-transfer key | public |

**The nonce** is `HMAC-SHA256(sender identity secret, "imani-transfer-nonce-v2:" || transfer || ":" || recipient)`.
Derived rather than random so the sender can recompute it after a device wipe
from nothing but their key and the `transferId` on their `sent` row. Keyed so
nobody else can: the gateway knows `transfer` and both parties, and an unkeyed
hash of those would hand it everything below.

**The tag** is `t = sha256("imani-transfer-v1:" || transfer || ":" || nonce)`.

**The per-transfer keys** are the identity keys, tweaked:
`P' = lift_x(P) + h(role, t, nonce)·G`, and `sk' = d + h(role, t, nonce) mod n`
with `d` the identity secret normalised to BIP-340's even-y point. So:

- either party, holding the nonce, can compute the OTHER's per-transfer public
  key, which is how the sender signs over the receiver's key before it exists;
- only the key's owner can sign with it;
- anyone later SHOWN the nonce can check which two identities the receipt
  belongs to, which is what disclosure means here;
- without the nonce, the keys are unlinkable to any identity and to each other
  across transfers. The tweak is derived from the nonce as well as the tag
  because the tag is public: a tweak from the tag alone could be subtracted
  from the published key to recover the identity.

The identity signature binds "this per-transfer key is mine, tweaked for this
transfer, to you, for this amount" to the sender's real key, and only the
receiver ever sees it. `verifyTransferSignature` also checks that `transferKey`
really is the sender tweaked, so a payload cannot bind the sender to a key they
do not hold.

## What is published

The 7378 carries `n = t`, the sender's per-transfer key, and one of the
sender's two public signatures:

- **With a commitment**, when the receiver's VERIFIED credited value, unit and
  decimals all equal what the sender signed: `commitment`, `unit`, `decimals`,
  and `transferSig`, which signed exactly those plus `t` and the receiver's
  per-transfer key. The commitment is `amount·G + blind·H` with the blind
  derived from the nonce, so both parties can open it and nobody else can.
- **Without**, when they disagree or the voucher did not verify: no amount, no
  unit, and `bareSig`, which signed `t`, the receiver's key and the literal
  `none`. It asserts the link and nothing about value, so it cannot contradict
  a commitment. A sender-written envelope figure is never committed to, for the
  reason `attestRedemption` gives.

`verifyTransferReceipt` (anyone can run it) rebuilds the signed message from
the event itself: its author must be the receiver key the sender signed over,
and its commitment, unit and decimals must be the ones the sender signed, or
absent with the `none` marker. A copied `{tag, senderKey, senderSig}` under a
new author fails, and so does a shifted commitment `C + k·G`, which would
otherwise open to `amount + k` with the same blind.

`openTransferReceipt(event, payload)` is the auditor's check once either party
discloses the payload: it proves the two per-transfer keys are the named
sender and recipient, and that the commitment opens to the named amount.

Not published: either identity, the amount, the voucher id, `transfer`, or the
nonce.

## Who keeps what (recovery and disclosure)

The nonce is what finds (`#n`), opens and discloses a receipt, so both parties
must be able to get it back:

- **Sender**: keeps nothing extra. The `sent` row carries `transferId`
  (`buildSentTransaction`), which is backed up to the relay with the rest of
  the history (`txRecords`, NIP-44 sealed to self). After a wipe, `signTransfer`
  with the same key and row rebuilds the same nonce, tag, keys and commitment.
- **Receiver**: the redemption stamps `transferId` on the `received` row
  (`withCorrelation`), and once a signature pairs, `recordTransferSignature`
  files the whole payload on that row as `transferSignature`, locally. First
  writer wins. The row's relay backup (a kind-7376 re-published under the same
  `d`) is NOT sent at pairing: see "Timing" for why it waits.

Both fields round-trip through `toContent`/`toRow`
(`src/lib/__tests__/transferRecovery.test.ts`).

## Delivery: best-effort, and stated plainly

The sender's wrap is published to the wallet's `RELAY_URL`. The gateway's
`RelayIngestPump` does NOT pick it up: it subscribes only to
`kinds=[1059], #p=<gateway's own pubkey>`. A wallet-published wrap to a
customer reaches the recipient through one of two paths:

1. `RecipientRelaySubscriptions`, opened only while that recipient has a live
   SSE stream, with a 7-day `since`.
2. The catch-up `/api/v1/nostr/query`, through
   `CachingNostrGatewayDecorator.queryEventsWithCache`, which asks the relay
   only when its local cache is stale or empty, over a 30-minute default
   window. This section first said freshness was judged without `#p`; the
   measurement below shows it is judged on the recipient's own cached wraps,
   and that those alone are enough to hide a relay-only wrap.

The coupon's own wrap has neither problem, because the gateway publishes it and
mirrors it into its cache. So the signature is delivered **best-effort**. The
common case, a recipient with a live stream, works as the wallet's other
user-to-user wraps do, and a miss costs the receipt and nothing else.

### Measured on staging (#98)

`e2e/probe-transfer-signature-delivery.mts`, run twice on 2026-09-26 against
`wallet.staging.398ja.xyz` (relay `wss://relay.staging.398ja.xyz`), with
throwaway identities only. B never opens an SSE stream. Each arm uses fresh
identities, and B's catch-up is the query `DmPollService.fetchRecentDms`
issues: `{kinds:[1059], pTags:[B], since: now - 7d, limit: 50}`. "Warm" means a
1059 for B with `created_at = now` was stored through
`POST /api/v1/nostr/events` and served back by one catch-up before the wrap was
sent. Each arm queried twice, 1.5 s and 6.5 s after the send.

| Arm | Wrap sent to | B's cache | Delivered (run 1) | Delivered (run 2) |
|---|---|---|---|---|
| cold | relay only | empty | yes | yes |
| warm | relay only | fresh 1059 for B | **no** | **no** |
| warm-other | relay only | fresh 1059 for C, none for B | yes | yes |
| warm+mirror | relay and `POST /nostr/events` | fresh 1059 for B | yes | yes |
| mirror-only | `POST /nostr/events` only | empty | yes | yes |

What this shows:

- **The warm-cache miss is real.** A recipient with any 1059 of their own
  inside the 30-minute window is answered from the cache, and a relay-only wrap
  is invisible to that catch-up. It stays invisible until the cached one ages
  out of the window.
- **Freshness is already per recipient.** The local result set is filtered by
  the server filter, `#p` included, before the freshness check, so a fresh wrap
  for someone else does not hide B's (warm-other). The issue's worry that any
  fresh local 1059 short-circuits every recipient does not hold. Only B's own
  fresh wraps do.
- **The mirror closes it.** A wrap posted to `POST /api/v1/nostr/events` is
  stored where the catch-up reads, so it is returned whether or not the cache
  was warm, and even with no relay copy at all.

How likely the miss was in practice is a separate question the probe does not
answer: NIP-59 back-dates a wrap's `created_at` by up to two days, so a real
wrap only makes B's cache "fresh" if it happens to land in the last 30 minutes.
The warmer here used `now`, which is the worst case.

### Decision

- **The wallet mirrors the wrap** (`mirrorToGateway` in
  `src/lib/transferSignature.ts`). `sendTransferSignature` publishes to the
  relay and posts the same signed event to `POST /api/v1/nostr/events` (NIP-98,
  `signedFetch`) side by side. Either one succeeding counts as delivered; the
  mirror has its own 15 s cap, never throws, and the relay result does not wait
  on it longer than that. The call is still fire-and-forget from `pay.ts`.
- **No new gateway endpoint.** The existing `POST /api/v1/nostr/events` already
  does what #98 proposed, minus the relay publish, which the wallet keeps doing
  itself. It is NIP-98 authenticated and verifies the id and signature. It
  leaks nothing new: the wrap is signed by NIP-59's throwaway key and its
  content is encrypted to the recipient. It is not rate-limited per pubkey
  beyond the gateway's general limits; one extra POST per customer send does
  not change that picture.
- **No SSE dispatch from `storeEvent`.** A recipient with a live stream gets the
  relay copy through `RecipientRelaySubscriptions`, which is unaffected by the
  cache (read from source, not re-measured here). A gateway change is not
  needed for this wrap.
- **`#p`-aware freshness in nostrdb: declined.** It is already effectively
  per recipient (warm-other above). Removing the remaining short-circuit, a
  recipient's own fresh wrap, would put a relay round trip back on every
  non-addressable query, which is the hot-path cost the short-circuit was added
  to remove (loadtest run 004). For this wrap the mirror makes it moot. Other
  wallet-to-relay-only 1059s share the gap and would want the same mirror.

Not measured on staging: that the receiver then publishes the kind-7378 within
the 10 min to 6 h window. That needs a real A to B coupon send between two
customers on staging and a wait of up to six hours. The pairing, delay and
publish logic after the wrap arrives is covered by
`src/lib/__tests__/transferSignature.test.ts`.

## Timing, and what the nonce does not hide

The nonce stops a third party who has seen the coupon's id from finding the
receipt. It does nothing against the **gateway**, which already knows sender,
recipient, amount and `sent_voucher_id`, sees the receiver's NIP-98
authenticated `/api/v1/wallet/receive` to the second, and runs the relay the
7378 lands on (strfry, same compose stack), receiving it from the receiver's
IP. Publishing at redemption time would let it pin each 7378 to its transfer by
timing alone.

So the receiver does not publish at redemption. A paired receipt is queued in
local storage and published after a **uniformly random delay of 10 minutes to
6 hours**, with `created_at` jittered up to **1 hour backward** from the
publish time. A failed publish is retried on a fresh random delay, three
attempts in all, then dropped. Nothing blocks on any of this, and a receiver
who never opens their wallet again simply never publishes.

**Resume.** The queue survives a closed tab, and because the delay is at least
ten minutes and mobile sessions are short, most receipts come due while the app
is closed. Publishing them at startup would put a burst of 7378s in the same
second as the login's NIP-98 traffic, from the same IP. So `startDmPoll` gives
every overdue entry a **fresh random delay of 1 to 30 minutes** from start
instead. A session shorter than that publishes nothing and the entries wait for
the next.

**The backup.** Pairing also files the payload on the `received` row, and that
row's backup is a kind-7376 authored by the identity key, about 1.1 KB larger
once it carries the payload. Re-publishing it at pairing would tell any relay
reader "this identity just paired a customer-transfer signature". So the row is
updated locally at pairing, and its backup goes out as a second queued step,
after the 7378 publishes, on another random 10-minute to 6-hour delay.

**The backup's size (#99).** NIP-44 v2 pads plaintext to powers of two, and
that is what leaked: a typical `received` row is about 450 bytes of JSON
without the payload and about 1380 with it, which became 772 and 2140
characters of ciphertext, so the size said "this row carries a transfer
signature". Every kind-7376 is now padded to the first of a fixed set of
plaintext sizes (`TX_PAD_BUCKETS` in `src/lib/txRecords.ts`: 2048, 4096, 8192,
16384 bytes) with a `pad` field the reader ignores. Every ordinary row (received
with or without the payload, payment, issued, cashback) measured under 2048, so
all of them produce the same ciphertext length (2820 characters), far inside
the relay's 64 KB event limit. Only rows with unusual issuance evidence or long
memos reach a larger bucket, and that says nothing about a transfer signature.
Records written before this have no `pad` and still restore. What remains is
the event itself: a 7376 for a `received` row appearing hours after the row
was first backed up says the row changed, not how.

**Several tabs.** Every tab runs the poller and arms a timer over the same
queue. A publish pass runs under a Web Lock per account
(`imani-transfer-receipts:<pubkey>`), and each entry is claimed (removed from
the queue) before its relay round trip and put back only on failure, so a
second tab, or a browser without the Locks API, finds nothing to publish twice.

**Residual leak, accepted.** This narrows the gateway's guess from "the 7378
that arrived within a second" to "one of the 7378s in a six-hour window", and
no further. The anonymity set is the number of customer transfers received in
that window, which on a small deployment may be one. Connection metadata (IP,
TLS session) is not addressed at all. It is the same trade
`docs/research/redemption-attestation-privacy.md` makes for merchants under
"Residual leaks" (timing: batch, at the cost of freshness), with a longer
window because nothing reads 7378s for completeness. Batching, or publishing
through a relay the gateway does not run, would narrow it further. Neither is
done here.

## Linkability, stated plainly

- The sender's public signature and the receiver's 7378 are linked to each other
  by being in the same event, under the same `t`, with the sender's signature
  naming the receiver's key. That is the requirement.
- Neither is linked to an identity or to another transfer, except by someone
  holding the nonce: the two parties, and anyone they disclose it to.
- Neither is linked to the gift wrap that carried the coupon, except by the
  gateway's timing guess above.
- An observer learns that **some** customer-to-customer transfer was received
  within a window. The count of 7378s across the relay is a cardinality leak for
  the network as a whole, not for a person. Accepted.
- The receiver can link sender identity to the event (they hold `sig`). They
  could anyway: they received the coupon from that person.

## Who may sign, and who is paired

The receiver pairs a signature with a coupon only when the signature's
`sender` is the key that actually SENT the coupon: the payload's
`sender_pubkey` (which gateway-core sets from the send row), else the wrap
author for a bare wallet-to-wallet wrap, and never `issuerId`. Signatures are
held one per `(transfer, signer)`, first writer wins, so a stranger who learns
a coupon's fingerprint can neither pre-empt nor overwrite the genuine
signature. The held store caps each signer at 20 entries and expires anything
unpaired after 30 days, so a flood from ONE key only evicts its own entries.

Keys are free, though, so a flood can come from many. The global cap (200)
therefore evicts unprotected entries first: a signature already paired and
queued, or one signed by a key this wallet has dealt with (the sender of a
coupon held here, or a counterparty anywhere in its history), goes only when
nothing else is left.

**The wrap is held at the relay until it pairs (#99).** A flood of fresh keys
could still evict a first-time sender's signature from that local store before
its coupon arrived (the re-review's repro: one genuine signature, 200 one-shot
keys, then the coupon, 0 receipts). The local store is now only a cache. A
signature that does not pair on arrival leaves its gift wrap UNPROCESSED
(dm-poll's `UnwrappedDm.hold`, and the `held_until_paired` outcome for the
catch-up tick), so the relay keeps it and every catch-up offers it again. When
the coupon arrives and the cached signature is gone, the redemption path runs
a catch-up at once and the wrap is read again and pairs. Bounds:

- A held wrap is answered from its id alone (`heldWrapDecision`), so it costs
  no decryption per catch-up. It is opened again only when its coupon is here
  and has not paired, which is the flood case.
- It is released (marked processed) once it pairs, once its coupon has arrived
  from another key, or after 7 days (`WRAP_HOLD_TTL_MS`, the poller's fetch
  window, counted from the wrap's own `created_at` or first sight, whichever is
  earlier).
- At most 1000 wraps are held (`MAX_HELD_WRAPS`, about 150 KB). Past that a new
  wrap is not held, so a flood cannot displace one already held.
- `runCatchupTick` never lets the persisted watermark pass a held event, so it
  is fetched again, but examines each held event at most once per tick, lets
  at most 50 pin the watermark, and releases one older than its TTL.

What a flood can still do is fill the 1000 slots before a genuine signature
arrives, and then evict that signature from the cache before its coupon: that
takes a thousand wraps within the week, and still costs a receipt, never money.

**The gateway can still name the sender.** On every gateway-relayed coupon the
envelope's `sender_pubkey` is written by the gateway, and pairing trusts it. A
malicious gateway can therefore name a key of its own as sender and send the
matching signature, and the receiver will publish a receipt linking that key.
This is closed against third parties, not against the gateway. The receiver
has no end-to-end way to learn who paid, short of the sender signing the coupon
itself, so this is accepted rather than fixed here.

`nip59.unwrapEvent` in nostr-tools 2.24.1 checks neither the seal's signature
nor that the seal and rumor name the same author, so `rumor.pubkey` is not
authenticated. dmCrypto opens the seal again (`sealAuthorOf`) and hands a
signature over only when the seal verifies and matches the rumor. The identity
`sig` remains what binds the signer, and the coupon-sender check is what binds
the signer to the coupon.

## It never blocks, and never reverses

The money has moved before either signature exists. So:

- **Sender.** Signed and wrapped after the saga completes and the local row is
  written, fire-and-forget. A locked wallet, a missing `sent_voucher_id`, a
  unit outside the alphabet, or a relay refusing the wrap costs the receipt,
  never the send. `settleSend` also runs for sends finished late by
  `reconcilePendingSends`, so those are signed too.
- **Receiver.** Queued after redemption, published later, never throwing.
- **A signature that does not verify is ignored**, not escalated. It is evidence
  that was optional in the first place, as `cashAttestation.ts` says of its own.
- **Without a sender signature, nothing is published.** A unilateral "I received
  something" has nothing to link to and no auditable value, and would be a
  public record of a gift the sender never asked to have recorded. A transfer
  from an older build, or a coupon issued directly by a stall, therefore
  produces no 7378.

## Merchants are unchanged

A wallet with a stall record keeps publishing 7377 through `attestRedemption`
and publishes no 7378: the check is in `dmPoll`, and again in every
`transferSignature` entry point and at publish time, so a wallet that noted a
receipt as a customer and then opened a stall publishes nothing. The sender
does not sign a plain send to a stall's key either (`merchantStatus`, the
lookup `refuseIfWrongMerchant` uses; an unreachable relay skips signing).
`reconcileAttestations` reads 7377 only and is untouched.

## Why v1 was refused

Version 1's `transferSig` signed only `H(domain || tag)`. It covered neither
the receiver's key nor the commitment, so anyone could copy
`{tag, senderKey, senderSig}` into a new 7378 under a fresh key with a shifted
commitment, and it verified. v1 also used random nonces the sender never
stored, keyed held signatures by transfer alone (last writer wins), trusted the
unauthenticated rumor author, and published at redemption time. v2 fixes all of
these, bumps `v`, and every reader refuses v1.

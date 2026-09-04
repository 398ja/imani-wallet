# 05: Sell one, by hand

**What to build:** The seller's side, out-of-band: mint a licence voucher for a
named customer, locked to the key they give us, with a term, a price and a
subscription id, and send it.

Deliberately manual. There is no purchase flow and building one before knowing
what customers ask is guessing. This is the pilot mechanism, and it does not
scale past a few dozen — which is the point at which the in-app flow will have
evidence behind it.

**Blocked by:** 01

**Status:** done

- [x] A licence can be minted for a customer's key, with a term and a price, and
      delivered.
- [x] The price paid is recorded on the voucher, in the currency the customer
      paid in, whether that was fiat or sats.
- [x] A subscription id is carried in the voucher's metadata and survives both
      renewal and a re-issue to a new key.
- [x] A pilot licence is marked as one, so a pilot is distinguishable from a
      paying customer without asking.
- [x] A renewal reuses the subscription id, so a year of renewals reads as one
      relationship.

## What it took

`src/lib/licenceIssue.ts` says what a licence IS — the metadata, the term, the
price paid, the renewal rule — and `scripts/sell-subscription.mjs` mints and
delivers one. The split is so the part with rules can be tested without a
gateway, a mint or a relay.

Two things were found rather than assumed:

- **The portal endpoint cannot mint a licence.** `POST /portal/vouchers` builds
  `merchant_metadata` itself and admits exactly one key, `campaign_id`, so a
  licence sold through it would carry no subscription id, no grant and no lock
  key. The script uses the wallet tier's `POST /wallet/vouchers`, which takes a
  full `CreateVoucherRequest`.
- **`merchant_metadata` never reached the signed bytes.** The gateway carried it
  on the request, echoed it on the response and persisted it, but
  `VoucherAdapter` did not pass it to `VoucherSecret.builder()` — so it was
  absent from the token the customer receives. Every licence would have arrived
  as an ordinary coupon: spendable, summed into the merchant's takings, granting
  nothing. Fixed in imani-gateway-customer, with a test that fails without it.

The wallet-side tests are round trips — terms, to metadata, to a real signed
voucher, back through `licences.ts` and `verifyLicence` — because the failure
worth catching is the writer and the reader disagreeing. Verified adversarially:
dropping `lock_key` fails 5 tests, renaming `subscription_id` fails 11.

## What was verified against the real thing, and what was not

The wallet-side tests mint tokens with a TypeScript fixture, which signs and
verifies with the same canonicalizer — so on their own they prove the app agrees
with itself. Three checks were run against the actual Java and the actual DTOs to
close that:

- **Canonical bytes, cross-language.** `VoucherCanonicalBytes.of()` from
  cashu-voucher-domain 0.12.1 (the version gateway-customer resolves) was run
  over a licence `VoucherSecret` and diffed against `voucherCanonicalBytes`:
  byte-identical, including `merchant_metadata`'s tag position and the escaping
  of the JSON nested inside it. Every prior cross-language proof used a voucher
  with no metadata, so this tag had never been checked. Now pinned in
  `voucherToken.test.ts`.
- **The request body binds.** The body the script actually sends was captured by
  driving the real script with `fetch` stubbed, then deserialised with
  `CreateVoucherRequest` and run through Jakarta bean validation: every field
  binds, zero violations.
- **The portal endpoint fails silently, not loudly.** `CreatePortalVouchersRequest`
  has no metadata component and is `@JsonIgnoreProperties(ignoreUnknown = true)`,
  so a licence sent there returns 201 with the subscription id, grant and lock
  key DROPPED. Worth knowing: the seller would see a successful sale and the
  customer would get an ordinary coupon.

**Not verified: a live end-to-end sale.** The local stack is down and the gateway
images are not present, so no licence has been minted by a running gateway,
delivered by DM, and unlocked on a device. Ticket 04 is where that happens, and
it needs gateway-customer rebuilt with b0fdca5 deployed.

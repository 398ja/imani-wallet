# 05: Sell one, by hand

**What to build:** The seller's side, out-of-band: mint a licence voucher for a
named customer, locked to the key they give us, with a term, a price and a
subscription id, and send it.

Deliberately manual. There is no purchase flow and building one before knowing
what customers ask is guessing. This is the pilot mechanism, and it does not
scale past a few dozen — which is the point at which the in-app flow will have
evidence behind it.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] A licence can be minted for a customer's key, with a term and a price, and
      delivered.
- [ ] The price paid is recorded on the voucher, in the currency the customer
      paid in, whether that was fiat or sats.
- [ ] A subscription id is carried in the voucher's metadata and survives both
      renewal and a re-issue to a new key.
- [ ] A pilot licence is marked as one, so a pilot is distinguishable from a
      paying customer without asking.
- [ ] A renewal reuses the subscription id, so a year of renewals reads as one
      relationship.

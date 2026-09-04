# 04: Deliver an issued coupon

**What to build:** `/v1/issue/deliver-request` — an unsigned NIP-17 event the
caller signs and publishes, handing the coupon to the customer.

A prepare, and it has to be, because wrapping a gift wrap needs the customer's
private key and the service never has one (ADR 0002). The same reason the spend
path returns an unsigned event rather than delivering.

The partial-failure window is the point of splitting this from ticket 03. A
coupon can be issued and undelivered, and the app already handles that: its error
names the voucher so it can be recovered by hand. An API that hid delivery inside
issuance would turn a recoverable state into a silent loss of value, so this
seam is exposed deliberately rather than smoothed over.

**Blocked by:** 03

**Status:** todo

- [ ] The endpoint returns an UNSIGNED event; the service never publishes.
- [ ] An issued-but-undelivered coupon is reported with the voucher id, so it can be retried rather than lost.
- [ ] Retrying delivery of the same coupon does not mint a second one.
- [ ] The event carries the stall as sender, never the calling device, so a customer's coupon does not name a till.
- [ ] A probe delivers a REAL coupon to a REAL recipient and the recipient can decrypt it.

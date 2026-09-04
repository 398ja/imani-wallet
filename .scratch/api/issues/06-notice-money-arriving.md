# 06: Notice money arriving

**What to build:** A way for a headless caller to learn it has been paid.
Probably `/v1/inbox/drain` and an ack, mirroring what the app's
`startIncomingNotifications` and `startDmPoll` do with long-running loops in a
browser.

**This is the gap that changes what the API is for.** Spending without receiving
is half a wallet: the "bookkeeping tool" named in the README's own opening can
currently read a balance and never see income. Every other ticket here adds an
operation; this one makes an advertised use case possible.

**Start by locating the service.** Signed POSTs to
`/api/v1/incoming-notifications/drain` and `/ack` both return 404 on
gateway-customer. They may live on the portal (28084, not running on this stack)
or elsewhere. Do not design over them until they answer — an earlier draft of the
assessment asserted they "already exist behind NIP-98" and that was wrong.

Unwrapping the gift wrap needs the caller's private key, so decryption stays
client-side exactly as delivery does. The service couriers and never decrypts.

**Blocked by:** None, but starts with an investigation rather than an endpoint

**Status:** todo

- [ ] Where the drain endpoint actually lives is established and written down, before any endpoint is designed over it.
- [ ] A caller holding only a key can learn that a coupon arrived for it.
- [ ] Acknowledged envelopes stop coming back.
- [ ] The service never decrypts: the caller unwraps, and a probe proves the service could not have.
- [ ] The redemption ceiling still applies on this path — `refuseIfOverRedeemed` is enforced on receive, and covering redemption without receipt would enforce it in one place only.
- [ ] A probe receives a REAL coupon sent by another party.

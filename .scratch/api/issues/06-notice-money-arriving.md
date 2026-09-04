# 06: Notice money arriving

**What to build:** A way for a headless caller to learn it has been paid.
Probably `/v1/inbox/drain` and an ack, mirroring what the app's
`startIncomingNotifications` and `startDmPoll` do with long-running loops in a
browser.

**This is the gap that changes what the API is for.** Spending without receiving
is half a wallet: the "bookkeeping tool" named in the README's own opening can
currently read a balance and never see income. Every other ticket here adds an
operation; this one makes an advertised use case possible.

**Located.** They are on **gateway-core (28081)**, not customer-wallet (28082)
where the 404 came from. Both answer a plain NIP-98 signature from an
unregistered key:

```
POST 28081/api/v1/incoming-notifications/drain  200  {"envelopes":[],"moreAvailable":false}
POST 28081/api/v1/incoming-notifications/ack    200  {"acknowledged":0}
```

So this is buildable as a courier today, and the assessment's earlier claim
that they "already exist behind NIP-98" was right about the mechanism and wrong
about the host. The service already talks to gateway-core for splits, so the
URL is one it holds.

Unwrapping the gift wrap needs the caller's private key, so decryption stays
client-side exactly as delivery does. The service couriers and never decrypts.

**Blocked by:** None — the investigation is done, see below

**Status:** done

- [x] Where the drain endpoint lives is established: **gateway-core (28081)**, not customer-wallet.
- [x] A caller holding only a key can drain its own inbox.
- [x] Acknowledged envelopes stop coming back, and acknowledging nothing is refused.
- [x] The service never decrypts: it returns bytes to sign and never sees a plaintext coupon.
- [ ] **Not done:** the redemption ceiling on this path. See below.
- [x] A probe drains and acknowledges against the live gateway, signed by a key the service never sees.

## What it took

Two couriers, and the investigation was most of the work. The endpoints answer
a plain NIP-98 signature from an unregistered key — the assessment's claim that
they "already exist behind NIP-98" was right about the mechanism and wrong about
the host, which is why a 404 made them look absent.

Draining and acknowledging are separate calls on purpose: acknowledging before
persisting would lose a coupon on a crash, and only the caller knows when its
own write has landed.

## Still outstanding, and worth its own ticket

`refuseIfOverRedeemed` enforces the redemption ceiling on the app's receive
path. This API does not, because the service never sees a decrypted coupon —
the caller unwraps the gift wrap with its own key, so by the time a coupon
exists in plaintext, this service is out of the loop.

That is the right split for custody and the wrong one for the ceiling. A caller
should run `/v1/redeem/check` on what it unwraps, and the README should say so.
Recorded rather than quietly dropped: covering redemption but not receipt means
the ceiling is enforced in one place out of two.

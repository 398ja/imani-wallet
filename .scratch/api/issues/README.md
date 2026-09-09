# Tickets: the rest of the API

Tracked as [#50](https://github.com/398ja/imani-wallet/issues/50).

Twelve tickets. Read [the spec](../spec.md) first; it carries the decisions
these depend on.

## Order

Four can start immediately and unblock most of the rest:

| # | ticket | why now |
|---|---|---|
| [12](https://github.com/398ja/imani-wallet/issues/62) | the service still cannot spend | land it EARLY, so every later ticket is constrained by it |
| [01](https://github.com/398ja/imani-wallet/issues/51) | extract the redemption ceiling | blocks redemption, and carries the drift risk worth isolating |
| [07](https://github.com/398ja/imani-wallet/issues/57) | reads and reports | cheapest, and the first thing a bookkeeping integration asks for |
| [05](https://github.com/398ja/imani-wallet/issues/55) | payment requests | nearly pure, and how an EPOS asks to be paid |

Then the money paths:

| # | ticket | blocked by |
|---|---|---|
| [02](https://github.com/398ja/imani-wallet/issues/52) | redeem a coupon | 01 |
| [03](https://github.com/398ja/imani-wallet/issues/53) | issue a coupon | — |
| [04](https://github.com/398ja/imani-wallet/issues/54) | deliver an issued coupon | 03 |
| [09](https://github.com/398ja/imani-wallet/issues/59) | subscription status | — |

Then the three that must find their service before they can be built. Each
starts with an investigation, because a signed request to the endpoint the app
uses returns **404** on this stack:

| # | ticket | where it actually lives |
|---|---|---|
| [06](https://github.com/398ja/imani-wallet/issues/56) | notice money arriving | drain/ack 404 on gateway-customer |
| [08](https://github.com/398ja/imani-wallet/issues/58) | cashback | portal (28084), not running here |
| [10](https://github.com/398ja/imani-wallet/issues/60) | register a stall | account-app (28081) |

And one blocked on a product decision rather than on code:

| # | ticket | blocked by |
|---|---|---|
| [11](https://github.com/398ja/imani-wallet/issues/61) | terminals | a ruling on owner-side revocation |

## The two that carry real risk

**[01](https://github.com/398ja/imani-wallet/issues/51)**, because an extracted ceiling that drifts from the app's leaves a till and
an API enforcing different limits on the same voucher, each internally
consistent, neither failing a test.

**[06](https://github.com/398ja/imani-wallet/issues/56)**, because it is the one that changes what the API is for. Spending without
receiving is half a wallet.

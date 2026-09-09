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

**Status:** done

- [x] The endpoint returns bytes to sign; the service never publishes.
- [x] An issued-but-undelivered coupon is found by its voucher id, so it can be retried rather than lost.
- [x] Retrying delivery does not mint a second coupon — delivery is a separate call that mints nothing.
- [x] The event carries the stall as sender, never the calling device.
- [x] A probe delivers a REAL coupon through the live gateway, which returns an event id.

## What it took

A second courier, deliberately not folded into issuance.

**The seam is the point.** A coupon can be minted and undelivered, and that is
recoverable only if the caller holds the voucher id — so `voucherId` is
REQUIRED on this endpoint rather than optional, and the error says why. Hiding
delivery inside a single "sell" call would turn a recoverable state into a
silent loss of value.

The GATEWAY does the NIP-17 wrapping, as it does for the app. The ticket
anticipated returning an unsigned event; the gateway's `TokenDmTransferAdapter`
builds the gift wrap in exactly the shape the receive pipeline parses, so
hand-rolling one here would only risk drifting from that format. The caller
signs the request to the gateway instead, which is the same courier shape and
one fewer thing to get wrong.

`relay_urls` carries the relay the GATEWAY can reach, from an environment
variable rather than `import.meta.env` — that is a Vite global no Node service
has, and the distinction `src/lib/relay.ts` draws still applies: the gateway
publishes from inside the compose network where `localhost` is its own
container.

## Evidence

26 tests shared with ticket 03, and the delivery half of `probe-issue.mts`.

Live: the caller signed the delivery body this service produced and the gateway
answered **HTTP 200 with a real `event_id`**. The body was checked first for the
property that matters — `issuer_id` and `sender_pubkey` are both the stall,
never the calling device, so a customer holds a coupon from a stall they can
look up rather than from a till that may not exist next week.

Mutation control: making the delivery body name a different issuer fails "names
the STALL as both issuer and sender".

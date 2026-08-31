# The API plans, the caller signs

A send is delivered as a NIP-17 gift-wrapped DM, and wrapping one requires the
customer's private key. Since the wallet API never has that key (ADR-0001), it
cannot deliver a send itself. Instead it builds an **unsigned** event template and
returns it; the caller signs it locally and publishes it to the relay. Where the
gateway must be called to mint a replacement coupon, the API forwards the
caller's own NIP-98 signature rather than minting a credential of its own.

The alternative was a NIP-46 remote-signer round trip, which would have let the
API drive the whole flow. It was rejected because it requires a bidirectional
connection and abandons statelessness for the one operation where being stateless
matters most.

## Consequences

- The service has **no code path capable of spending**. This is the property that
  makes a public spending endpoint defensible at all.
- Callers must link a Nostr signing library. A pure-shell integration can read but
  cannot spend.
- The signing step is a seam where a caller can insert its own policy: an approval
  gate, a hardware signer, an HSM.
- Spending is two-phase — plan, then prepare each part — so partial failure is
  recovered by the caller, which is where the coupons already live.
- `refuseIfWrongMerchant` is enforced **server-side and fail-closed** even though
  the caller could route around the API entirely. It is the check that stops a
  customer's money from stopping dead at a stall that cannot honour it, and a
  programmatic caller is more likely to hit it than a human one.

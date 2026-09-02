# Terminals are authorised by locked vouchers

A stall runs more than one terminal, and they are not all the same: some only
take coupons back, some also issue them, and most have no business seeing the
stall's figures at all. The stall owner needs to create these terminals, say what
each may do, and take that away again, without handing out anything that would
let the holder act as the stall.

A terminal is authorised by a **Cashu voucher P2PK-locked to a key the terminal
generated and never discloses**, presented at login under NAP extension 0001,
voucher-bound authorization
(`nap/docs/extensions/0001-voucher-bound-authorization.md`).
The terminal's key `K` is born on the terminal; the stall owner mints a voucher
locked to `K`, tagged with the terminal's fixed role and signed by the owner as
issuer; the gateway resolves the session's permissions from the voucher rather
than from a stored row.

The alternative, and the one specified first in `possa-merchant` 008, was to
generate an nsec per subaccount and hand it to the delegate as a QR. It was
rejected because that QR is a bearer secret in transit: whoever photographs it
over the delegate's shoulder becomes the terminal. Under the locked voucher both
QRs are safe to observe. The one travelling to the owner is a public key, and the
one travelling back is inert without `K`.

## Consequences

- **The gateway holds no row per terminal.** A stall provisions terminals without
  the gateway learning they exist, which is what makes this cheaper than
  federating a user table.
- **A stolen credential is not a credential.** Possession of the voucher without
  `K` cannot sign the completion, so the enrolment exchange no longer needs to be
  a one-time secret-bearing screen.
- **`grant()` must scope permissions to the issuing stall.** The voucher says
  `redeem`; it must be read as `redeem for this stall`. A grant that omits the
  scope authorises one stall's terminal against every other stall, and this is
  the highest-risk line in the design.
- **The issuer allowlist is dynamic.** Every stall is an issuer, so the
  `(mint, issuer_pubkey)` pair is resolved against the stall registry rather than
  a static list, and a closed stall stops being a trusted issuer.
- **Revocation is a burn, and there is no pause.** The mint models *spent*, not
  *suspended*. Withdrawing a terminal's access means spending its voucher, and
  restoring it means minting a new one. A pause that could be resumed with the
  same credential would need server-side state, which is the row this decision
  removes.
- **Revocation is bounded, not immediate.** A session outlives the credential it
  was opened with, up to `maxSessionLifetimeSeconds`. Terminals set that to a
  shift rather than the 24-hour ceiling, so a burned voucher's session is dead by
  the end of trading. The Nostr ledger watcher that would cut this to seconds is
  blocked upstream: the ledger cannot yet represent a P2PK-locked voucher.
- **The mint becomes an availability dependency of logging a terminal in.** This
  is a real regression for a stall on a market's connectivity. Degraded mode
  issues a redeem-only session on the DLEQ alone, because redemption must never
  need the network to authorise, while issuance is value-bearing and waits.
- **It cannot ship before the mint does.** The composite `P2PK_VOUCHER` kind is
  required in `cashu-lib`, `cashu-voucher`, and `cashu-mint` first.

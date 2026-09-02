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

The alternative, and the one specified in the retired `possa-merchant`'s
subaccounts work, was to generate an nsec per delegate and hand it over as a QR.
It was rejected because that QR is a bearer secret in transit: whoever
photographs it over the delegate's shoulder becomes the terminal. Under the
locked voucher both QRs are safe to observe. The one travelling to the owner is a
public key, and the one travelling back is inert without `K`.

This app owns the terminal, because `possa-merchant` is retired and its merchant
surface has come here. A stall and a customer now run the same binary, and a
terminal is a third way into it: enrolled rather than onboarded, holding a
disposable key rather than a person's identity, and never a wallet of its own.

## Consequences

- **The gateway holds no row per terminal.** A stall provisions terminals without
  the gateway learning they exist, which is what makes this cheaper than
  federating a user table.
- **A stolen credential is not a credential.** Possession of the voucher without
  `K` cannot sign the completion, so the enrolment exchange no longer needs to be
  a one-time secret-bearing screen.
- **An authorisation voucher is unbacked, and the mint must know it.** It carries
  no face value and no funding row, so it needs a backing strategy naming it as
  authorisation rather than money. Minting it as ordinary dust would make every
  terminal an Orphan Issuance, which is the one thing the mint's accounting must
  never contain.
- **Trust in an issuer comes from the mint, not the relay.** A stall's identity is
  a self-published relay record, so treating a live record as issuing authority
  would let anyone who publishes an event authorise their own terminals. The
  `(mint, issuer_pubkey)` pair is honoured only for pubkeys the mint itself
  recognises as issuers.
- **`grant()` returns permissions parameterised by the stall**, in the form
  `voucher:redeem:<issuer_pubkey>`. An unparameterised `redeem` authorises
  redeeming for every stall, and only the parameterised form is visible to the
  registry validation that runs on `grant()`'s output.
- **Revocation is a burn, and there is no pause.** The mint models *spent*, not
  *suspended*. Withdrawing a terminal's access means spending its voucher, and
  restoring it means minting a new one. A pause that could be resumed with the
  same credential would need server-side state, which is the row this decision
  removes, so the merchant screens say re-enrol rather than offering a pause.
- **Revocation is bounded, not immediate.** A session outlives the credential it
  was opened with, up to `maxSessionLifetimeSeconds`, set to **12 hours** so that
  a terminal re-authenticates once a trading day and never mid-shift. A ceiling
  that interrupts a shift is one the staff work around. The Nostr ledger watcher
  that would cut this to seconds is blocked upstream: the ledger cannot yet
  represent a P2PK-locked voucher.
- **The mint becomes an availability dependency of logging a terminal in.** This
  is a real regression for a stall on a market's connectivity. Degraded mode
  issues a redeem-only session on the DLEQ alone, because redemption must never
  need the network to authorise, while issuance is value-bearing and waits.
- **It cannot ship before the mint does.** The composite `P2PK_VOUCHER` kind is
  required in `cashu-lib`, `cashu-voucher`, and `cashu-mint` first.

# 11: Terminals

**What to build:** `/v1/terminals/list`, `/v1/terminals/enrol-request` and
`/v1/terminals/revoke-request` — manage a fleet of tills from a management
system rather than by hand on a phone.

**Revocation must not claim more than it does.** Proven against the live mint:
an owner revoking a terminal in the app marks a LOCAL roster row and the
credential remains `UNSPENT`, so the device keeps working. `revokeTerminal` sets
`revokedAt` and stops; the revocation that bites spends the credential and only
runs on the device being decommissioned.

An endpoint over that would reproduce the gap at machine speed, for integrators
who reasonably assume revoke means revoked. So either the product gap is fixed
first, or this endpoint reports exactly what it did — marked, not revoked — and
says so in the README.

P2PK makes the fix non-obvious and is why this is not simply "call the mint":
spending a locked credential needs a witness from the DEVICE key, which the owner
does not hold by design. `TerminalRecord.revocationSecret` exists, is parsed, and
is documented as "what the owner needs to spend this terminal's proof" — and
nothing writes it. That field is the intended mechanism, unwired.

**Blocked by:** A product ruling on owner-side revocation (see the assessment)

**Status:** blocked

- [ ] Enrolment mints a credential locked to the device's key, and the key never transits.
- [ ] The roster lists live and revoked terminals with their roles.
- [ ] Revocation either genuinely revokes, or the response and the README state plainly that it only marks.
- [ ] A terminal cannot enrol or revoke another terminal through the API.
- [ ] A credential is inert on any device but the one it was locked to.
- [ ] A probe checks the mint's own view after a revoke, rather than trusting the response.

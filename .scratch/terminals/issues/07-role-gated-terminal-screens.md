# 07: Role-gated terminal screens and lapsed authority

**What to build:** A terminal shows only the actions its role permits, and tells
staff plainly when it has lost its authority.

A redemption-only terminal has no Sell and no dashboard. The hiding is the
courtesy, not the control: the same request made around the UI is refused too,
because the session carries no permission for it. Both halves are tested, and the
refusal is tested adversarially rather than by trusting the absent button.

The lapse case is what staff actually hit. A terminal whose authority has ended,
or been revoked, or whose trading day has rolled over, should say so once and
stop offering to serve, rather than failing on each attempt and leaving somebody
to guess whether to retry.

Redemption keeps working when connectivity is poor, on reduced authority, because
a queue at a stall cannot wait for the network to agree. Issuance does wait,
because it is value-bearing.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] A terminal shows only what its role permits.
- [ ] The same action attempted around the UI is refused, not merely hidden.
- [ ] A terminal whose authority has lapsed says so plainly and stops offering to
      serve.
- [ ] Redemption remains available on reduced authority when the network is
      unreliable; issuance does not.
- [ ] A stall on its own device sees no change.

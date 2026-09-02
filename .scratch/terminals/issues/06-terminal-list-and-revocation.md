# 06: The owner's terminal list, and revocation

**What to build:** The owner can see every terminal they have out: its name, its
role, and when it was last used. From there they can revoke one, and the device
stops trading for the stall.

Revocation must work for a device the owner cannot reach, because the lost,
stolen, and dead-battery cases are the only ones that really matter. It takes
effect within the trading day rather than instantly, and the screen says so, so
that an owner losing a device can decide whether that is good enough or whether
to close the stall.

Revoking withdraws authority and never erases history. A revoked terminal's past
movements stay in the stall's records, marked as belonging to a terminal no
longer in service.

There is no pause. Withdrawing a terminal is revocation, and bringing it back is
enrolling it again, which the screens should say rather than implying a
suspension exists.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] Live terminals are listed with name, role, and last use.
- [ ] The owner can revoke a terminal, and the terminal stops being able to act.
- [ ] Revocation works with the device absent, unreachable, or destroyed.
- [ ] The delay before revocation bites is stated on the screen, not left to be
      discovered.
- [ ] A revoked terminal's history remains, attributed and marked as revoked.
- [ ] No pause or resume is offered anywhere in the flow.

# 01: Name the terminal role vocabulary and permission shape

**What to build:** The fixed catalog of terminal roles, and the form a granted
permission takes. A role names a job a device is put on the counter to do:
redemption only, or issuance and redemption. A granted permission carries the
stall it was granted for, so that holding "may redeem" is always holding "may
redeem for this stall".

This ticket ships no screen. It exists because the stall parameter is the
boundary between one stall's terminals and every other stall's business, and it
should be settled and adversarially tested on its own rather than arrived at
while building a screen.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] The role catalog is fixed and closed: a role outside it cannot be assigned.
- [x] A granted permission carries the issuing stall, and a permission without one
      cannot be constructed.
- [x] A permission granted for one stall does not authorise the same action for a
      different stall. Tested adversarially, not by confirming the happy path.
- [x] Granted output is validated against the permission registry, and an
      undeclared role or permission is a denial rather than a silent pass.
- [x] The vocabulary matches CONTEXT.md: these are terminals and stalls, not
      subaccounts and merchants.

## What it took

`src/lib/terminalRole.ts`. No screen, as the ticket asks.

The shape is `voucher:redeem:<stall pubkey>`. The stall is IN the string rather
than beside it because the things that check permissions check STRINGS — NAP's
registry validates grant output, and `@PreAuthorize("hasAuthority(...)")` on the
gateway compares authorities. A bare role would authorise a terminal against
every stall on the deployment and neither check would notice.

So `permissionFor` demands a stall and there is no overload without one: an
unused-but-available bare constructor is how the hole would come back. It throws
on a malformed stall rather than emitting `voucher:redeem:undefined`, which is a
permission that silently matches nothing — or matches another malformed one.

`roleOf` refuses an unknown role rather than defaulting. A role arrives from a
voucher tag, through a mint and a QR code, so it is data from outside; defaulting
to the weaker role would be a silent downgrade a terminal could not distinguish
from working correctly.

`isValidGrant` requires the EXACT expected set. Subset would let a redeem-only
terminal carry an issue permission unnoticed; superset would let anything the
registry does not declare ride along.

## Evidence

22 tests, written adversarially — most assert something does NOT happen, because
a confirmatory suite would pass against an implementation that authorised every
terminal against every stall.

Three mutation controls, all verified to bite:

- Emitting bare permissions with no stall — **9 failures**. That is the hole this
  ticket exists to close.
- Prefix matching instead of exact — 1 failure.
- Subset validation instead of the exact set — 1 failure.

# 08: A lapse takes tills, never trade

**What to build:** What happens when a subscription ends with terminals live. The
extra terminals stop; the free one — the owner's device — does not. No new
enrolments. Nothing is revoked and no voucher is burned, so renewing restores
service instantly.

This is the ticket where the whole design is either kind or punitive. Revoking on
lapse would mean re-enrolling every device by hand after payment, which is a
punishment for someone who just paid. Stopping every till would take a working
stall off the market over a billing problem.

**Blocked by:** 07

**Status:** done — terminals 05, 06 and 07 all landed, which unblocked this.

- [x] The extra terminals stop serving; the free one keeps serving. Tested by
      lapsing with terminals live, not by asserting the check returns false.
- [x] No terminal credential is burned or revoked by a lapse.
- [x] Renewing restores every terminal with no re-enrolment.
- [x] New enrolments are refused while lapsed, with the same message as the free
      limit.
- [x] Staff on a stopped till are told plainly that the till is not authorised,
      rather than being left to watch actions fail.

## What ticket 07 already settled

The half of this ticket that is a subscriptions decision is done and tested in
`src/lib/terminalAllowance.ts`: while lapsed, `mayEnrol` refuses a NEW terminal
with the same message shape as the free-limit refusal, and it still allows the
free one. Nothing in that module burns or revokes anything, which is the
property this ticket turns on — renewal has to restore service instantly.

What remains is genuinely about terminals and cannot be built here:

- Extra terminals STOPPING while the free one keeps serving needs the terminal
  list (terminals 06) and the session check that reads it.
- "Tested by lapsing with terminals live" needs terminals that can be live.
- "Staff on a stopped till are told plainly" is a screen on the TERMINAL, which
  by design never checks a licence and never carries one — so the message has
  to come from the authorisation it already does check.


## What it took

`src/lib/lapseService.ts`, plus lapse markers on the owner's terminal list.

The half that was already done in `terminalAllowance.ts` (refusing NEW
enrolments while lapsed) is unchanged. What this adds is the other question:
which of the terminals already out may still serve.

Which till keeps serving is decided by enrolment age, oldest first. The
allowance has to land on one of them and the choice must be stable — a rule
that shuffled would stop a different device each time anyone looked, which
from behind a counter is indistinguishable from a broken app. The test roster
is deliberately unsorted, so a rule keying on array position fails.

The staff message says the till is not authorised and points at the owner. It
cannot diagnose a subscription: a terminal never checks a licence and never
carries one. It also does not blame the device (staff would go looking for a
charger) and does not leak the stall's billing to whoever is holding the till,
who may not be the owner. Both asserted.

On the owner's list, a stopped till stays under "In service" rather than
moving beside retired ones. Stopped by a bill is not retired by the owner, and
unlike a revoked terminal it needs nothing done on the device.

## Evidence

34 tests. The lapse is a REAL expiry on the gateway-minted licence fixture,
travelling through the signed metadata, the verifier and the grace window
before the roster sees it — which is the spec's "tested by lapsing with
terminals live, not by asserting the check returns false".

Nine mutation controls, all caught:

| Mutation | Tests killed |
| --- | --- |
| Lapse stops every terminal, no free one | 5 |
| Newest kept instead of oldest | 5 |
| Revoked terminals still take the free slot | 1 |
| Lapse message names the subscription | 2 |
| Live subscription capped at the free allowance | 4 |
| Screen marks every terminal on lapse | 4 |
| Marker never shown | 4 |
| Marker shown regardless of subscription | 5 |

One mutation SURVIVED and was right to: a defensive `.slice()` before the sort
changed nothing, because `filter` already returns a new array. Removed rather
than left in — a defensive copy that defends against nothing misleads the next
reader into thinking there is a hazard here.

1811 tests pass, lint clean, tsc at the pre-existing 81 in 6 files.

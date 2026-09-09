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

**Status:** blocked — needs terminals 05 (enrolment) and 06 (the terminal list)

- [ ] The extra terminals stop serving; the free one keeps serving. Tested by
      lapsing with terminals live, not by asserting the check returns false.
- [ ] No terminal credential is burned or revoked by a lapse.
- [ ] Renewing restores every terminal with no re-enrolment.
- [ ] New enrolments are refused while lapsed, with the same message as the free
      limit.
- [ ] Staff on a stopped till are told plainly that the till is not authorised,
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

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

**Status:** blocked

- [ ] The extra terminals stop serving; the free one keeps serving. Tested by
      lapsing with terminals live, not by asserting the check returns false.
- [ ] No terminal credential is burned or revoked by a lapse.
- [ ] Renewing restores every terminal with no re-enrolment.
- [ ] New enrolments are refused while lapsed, with the same message as the free
      limit.
- [ ] Staff on a stopped till are told plainly that the till is not authorised,
      rather than being left to watch actions fail.

# 07: Stop at the free terminal, and say what to do

**What to build:** The gate itself. The owner's device counts as terminal 1 and is
free; enrolling a second needs a licence. Without one, enrolment is refused with a
message naming the limit and how to lift it.

The gate is at enrolment, on the owner's device, because a terminal cannot exist
without the owner creating it — so refusing here gates the feature entirely, on
the one device that holds the licence. Terminals never check the licence and never
carry one.

The owner's device is counted, not converted: it keeps authenticating as the stall
exactly as it does today. Making it a real enrolled terminal would be a migration
of every existing merchant's device for no benefit they can perceive.

**Blocked by:** 02, and terminals 05 (the owner-side enrolment screen)

**Status:** blocked

- [ ] Enrolling a second terminal without a licence is refused, at enrolment
      rather than by hiding a button.
- [ ] The refusal names the limit and how to lift it, with the contact route
      present while selling is by hand.
- [ ] With a licence, enrolment proceeds with no further check.
- [ ] The owner's own device continues to work exactly as before and is never
      asked to enrol.
- [ ] No inert terminal is ever created: enrolment either completes or does not
      begin.

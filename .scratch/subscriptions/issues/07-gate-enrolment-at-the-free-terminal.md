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

**Status:** part-landed — the rule is built and tested; the GATE waits on terminals 05

- [ ] Enrolling a second terminal without a licence is refused, at enrolment
      rather than by hiding a button.
- [ ] The refusal names the limit and how to lift it, with the contact route
      present while selling is by hand.
- [ ] With a licence, enrolment proceeds with no further check.
- [ ] The owner's own device continues to work exactly as before and is never
      asked to enrol.
- [ ] No inert terminal is ever created: enrolment either completes or does not
      begin.

## What has landed, and what has not

`src/lib/terminalAllowance.ts` is the RULE: `mayEnrol(status, enrolledCount)`
and `remainingTerminals`. It is built and tested here rather than inside the
enrolment screen because it is a subscriptions decision, and a screen that is
really about scanning a QR code should ask it, not restate it.

Landed:

- One free terminal, counted against ENROLLED terminals — so the owner's device
  is counted, not converted, and never appears in that number.
- A live licence allows any number: "one voucher, however many terminals". A
  numeric cap would be the rejected per-terminal pricing reintroduced by
  accident.
- Two distinct refusals. "You are using your free till" and "your subscription
  has ended" send a merchant to different actions — buy versus renew — and a
  gate that could only say no would send them nowhere. Both name the contact
  route, since selling is by hand.
- Neither message implies the stall stops trading, and a lapse still allows the
  free one: a lapse suspends, it never revokes.

NOT landed, and it is the acceptance criterion itself: **the refusal is not yet
wired to anything**, because `terminals 05` — the owner-side enrolment screen —
does not exist. There is no enrolment flow in the app at all (`grep -rn enrol
src/pages` finds only onboarding and login). When that screen is built it must
call `mayEnrol` at the point of enrolment, not use `remainingTerminals` to hide
a button; the module's own doc comment says so, because hiding the button is
exactly what this ticket refuses.

## Evidence

10 tests, run against the REAL gateway-minted licence
(`fixtures/live-licence.token`) rather than a fixture this app signed for
itself. Mutation controls bite: opening the gate unconditionally fails 4, and
collapsing the two refusals into one fails 2.

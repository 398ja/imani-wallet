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

**Status:** done — terminals 05 landed the enrolment screen the gate needed.

- [x] Enrolling a second terminal without a licence is refused, at enrolment
      rather than by hiding a button.
- [x] The refusal names the limit and how to lift it, with the contact route
      present while selling is by hand.
- [x] With a licence, enrolment proceeds with no further check.
- [x] The owner's own device continues to work exactly as before and is never
      asked to enrol.
- [x] No inert terminal is ever created: enrolment either completes or does not
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

## A bug found on re-check

The first version told the two refusals apart with `status.licence != null`.
That is wrong in the case that matters most: past the grace window with an
unreadable store, the decision refuses with `grace-elapsed` and the licence is
NULL because the voucher could not be read — so a PAYING customer whose storage
failed was told to go and buy a subscription they already held.

The refusal REASON distinguishes them, not the licence in hand: only `absent`
and `never-verified` mean nobody ever subscribed. Fixed, with a test that fails
against the old logic.

The same re-check found that grace was never exercised here at all. It behaves
correctly — a carried licence still allows enrolment, which is ADR 0007's
fail-open — but it is now tested rather than assumed.

## Evidence

13 tests, run against the REAL gateway-minted licence
(`fixtures/live-licence.token`) rather than a fixture this app signed for
itself. Mutation controls bite: opening the gate unconditionally fails 4, and
collapsing the two refusals into one fails 2.


## The gate (landed with terminals 05)

The note above said the gate waited on an enrolment screen. That screen is
`src/pages/TerminalEnrolPage.tsx`, and the gate is wired exactly as this ticket
asked:

- `checkEnrolment` consults `mayEnrol` at the point of enrolment, and the
  screen renders the refusal as a sentence with the form still visible. Not a
  hidden button — a hidden button leaves an owner with nothing to act on.
- The refusal message is passed through from `mayEnrol` verbatim rather than
  reworded, so there is one sentence per situation and the contact route
  cannot drift out of it.
- The owner's own device is never counted or converted; `FREE_TERMINALS` is an
  allowance against ENROLLED terminals only.
- Nothing is created before the check passes, so no inert terminal exists.

Covered by the screen tests under "the subscription gate is on the screen, not
behind it", including that the first terminal is allowed WITHOUT a
subscription — a stall trying the product must reach a working terminal, or
nobody ever sees what they would be paying for.

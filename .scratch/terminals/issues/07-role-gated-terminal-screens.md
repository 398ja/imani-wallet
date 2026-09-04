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

**Status:** done — pending the terminal LOGIN that supplies the session, which is ticket 10.

- [x] A terminal shows only what its role permits.
- [x] The same action attempted around the UI is refused, not merely hidden.
- [x] A terminal whose authority has lapsed says so plainly and stops offering to
      serve.
- [x] Redemption remains available on reduced authority when the network is
      unreliable; issuance does not.
- [x] A stall on its own device sees no change.

## What it took

`src/lib/terminalSession.ts` (the ceiling, lapse reasons, and the two
session-aware permission questions), a session-aware enforcement point in
`issue.ts`, and role gating on `MerchantHomePage`.

The key move was making the SCREEN and the ENFORCEMENT POINT ask one question.
`issueAndDeliver` asked `mayIssue` — "does the role allow it" — which stays
true of a terminal whose session died an hour ago. It now asks `canIssueNow`,
the same function the screen calls. Without that, the hidden button really was
the control.

A missing session is refused for a terminal rather than defaulted to fine.
A default would make this a check any caller skips by forgetting a field.

Three decisions worth recording:

- **Revocation is checked before expiry.** Both stop trading, but "sign in
  again for today" tells staff to do the one thing the owner just prevented.
- **The ceiling is imported from the roster, not restated.** The owner is
  promised twelve hours on the revocation screen; a second literal here is how
  the promise and the behaviour drift apart.
- **Expiry is not phrased as a fault.** It happens to every terminal every
  day. An alarming message for the most routine event in the system teaches
  staff to ignore all of them.

## Evidence

43 tests. The strongest enumerates every role against every session state and
asserts the screen offers Sell exactly when `canIssueNow` allows it — spot
checks would miss the combination somebody forgot, and both directions hurt.

Ten mutation controls, all caught:

| Mutation | Tests killed |
| --- | --- |
| Reduced session may issue | 1 |
| Lapsed session may still redeem | 2 |
| Expiry checked before revocation | 1 |
| Session ceiling doubled | 1 |
| Reduced blocks redemption too | 1 |
| Screen uses role-only check (disagrees with enforcement) | 2 |
| Lapsed terminal still shown the buttons | 2 |
| Reduced authority also hides Redeem | 3 |
| Owner dragged into the session check | 1 |
| One lapse icon for every reason | 1 |

The bypass tests call `issueAndDeliver` directly, the way a modified client or
a stale tab would, and assert no request left the device — a refusal after a
mint leaves a voucher nobody can deliver.

1789 tests pass, lint clean, tsc back to the pre-existing 81 in 6 files.

## Left for 10

`MerchantHomePage` takes `actor` and `session` as optional props and defaults
to the owner's behaviour, because no UI holds a terminal actor yet — terminal
LOGIN is ticket 10. When it lands, App passes them through and the gating is
already tested. Nothing here is a stand-in: the rules and both enforcement
halves are real.

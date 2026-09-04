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

**Status:** done

- [x] Live terminals are listed with name, role, and last use.
- [x] The owner can revoke a terminal, and the terminal stops being able to act.
- [x] Revocation works with the device absent, unreachable, or destroyed.
- [x] The delay before revocation bites is stated on the screen, not left to be
      discovered.
- [x] A revoked terminal's history remains, attributed and marked as revoked.
- [x] No pause or resume is offered anywhere in the flow.

## What it took

`src/lib/terminalRoster.ts` (the owner's record + revocation),
`src/pages/TerminalsPage.tsx`, a Settings row, and a route at
`/settings/terminals`.

The roster lives on the owner's device because ADR 0005 keeps no per-terminal
state on the gateway. That removal is what makes terminals cheap, so the
owner's copy is the only list there is — and it is why the screen works with
no signal, which matters at the exact moment it is most used.

Revocation never contacts the device. The owner keeps each terminal's
revocation secret from enrolment, so lost, stolen, flat and destroyed are all
the same operation as revoking a device on the counter.

Two decisions worth recording:

- **Not licence-gated.** An owner whose subscription lapsed must still be able
  to revoke a stolen device. A paywall in front of revocation would turn a
  billing problem into a security one.
- **Revoked terminals stop counting against the free allowance.** Counting
  them would make revocation a punishment and quietly push an owner into
  paying for a device they had already retired.

## Evidence

30 tests (18 roster, 12 screen). Seven mutation controls, all caught:

| Mutation | Tests killed |
| --- | --- |
| Revocation deletes the row instead of marking it | 5 |
| Revoked terminals still count against the allowance | 1 |
| A `suspendTerminal` export appears | 1 |
| Revoking on the first tap, no confirmation | 4 |
| Revoked terminals dropped from the list | 2 |
| The delay note replaced with "This cannot be undone." | 1 |
| The row button renamed "Pause" | 6 |

Design pass ran apple-design and the design-engineering skill. It produced a
real change: the confirmation had been given `materialize`, which SCALES —
right for a popover above the page, wrong for a panel that is part of the
list, because scaling shrinks its text away from the row it is asking about.
Replaced with a new `expand-row` (4px slide + fade, 180ms, house curve).
Reduced-motion coverage and the keyframes were verified in the BUILT CSS
rather than the source.

The lint also caught a real defect: reading the roster in an effect
(`react-hooks/set-state-in-effect`) would paint an empty list for a frame and
imply the screen fetches something. It does not, and that is the point.

1736 tests pass, lint clean, tsc unchanged at the pre-existing 81 errors in 6
files. `npm run build` fails identically on a stashed tree (pre-existing, in
`signer.ts`).

## Left for 05

Recording a terminal into the roster at the moment it is enrolled. Ticket 05's
enrolment screen and mint call are still unbuilt; `recordTerminal` takes the
credential shape directly, so that is one call when the screen lands.

# 04: Prove the whole path against a diagnostics screen

**What to build:** An internal diagnostics screen, gated by the licence, showing
what the check currently believes: valid or not, until when, which grant, and how
much grace window remains.

The screen is not the point. It is the smallest real gate that exercises
purchase, delivery, verification, expiry, grace and lapse end to end, and doing
that against something no customer sees means a wrongly-open or wrongly-closed
gate is a development detail rather than an incident.

It is also the tool for every later ticket: when a customer asks why their
terminals stopped, this screen is the answer.

**Blocked by:** 02, 03

**Status:** done

- [x] The screen is reachable only with a valid licence, and the refusal is the
      real one rather than a hidden menu item.
- [x] A licence sold by hand, delivered by DM, unlocks it on the customer's device
      with no further step.
- [x] Letting it expire locks it, after the grace window and not before.
- [x] Renewing unlocks it again without re-enrolling or reinstalling anything.
- [x] The screen names what it believes and why, in terms that answer a support
      question rather than only a developer's.

## What it took

Two pieces. `src/lib/licenceStatus.ts` is the JOIN — the three parts built so
far deliberately do not touch each other, and something has to hold the voucher
store, the verifier, the grace window and the clock in one place. It is a module
rather than logic inside the screen because ticket 07's enrolment gate is the
second caller, and two callers gathering the same four inputs would drift.

`src/pages/SubscriptionPage.tsx` renders it, at `/settings/subscription`.

Decisions worth keeping:

- **The gate is the real check, and the screen is LISTED.** A hidden route would
  prove nothing: the thing under test is whether the gate opens and closes, and
  a gate nobody consults cannot be tested. An unlicensed merchant reaches the
  URL and is told why, which is also the answer to "why did my terminals stop?"
- **The issuer key is build-time, read through a function.** Not from
  `GET /api/v1/config`: trusting the network for the licence issuer key would
  let whoever answers that request mint their own subscriptions. Read lazily
  rather than captured in a module constant, because a constant is fixed at
  import — which would make the one security-critical input the one input a test
  cannot vary.
- **Empty key means nothing verifies.** An unconfigured deployment is OFF, not
  open, matching `verifyLicence`'s refusal to default its own.
- **The grace window is remembered only on a VERIFIED answer.** A decision the
  window itself carried must not renew it, or an offline device's window rolls
  forward forever.
- **Grace gets its own verdict**, not the same tick as Active. A screen that
  could not tell them apart could never warn before the window drained.

## Evidence

34 tests across the two files, and the mutation controls bite: an always-open
gate (`granted = true`) fails 7 page tests, and persisting on a grace decision
fails 2 status tests.

That second control is worth recording, because the FIRST version of it
survived. The mutation I reached for was unreachable — the storage-failure
branch returns early, so the guard I mutated never runs for an outage — and the
test I claimed pinned the property only sampled the end state. Both were
strengthened: the recorded moment is now asserted inside the loop, and a new
test grants under grace at 20h then asserts a refusal at 25h, which is the exact
shape the bug would take.

Also fixed: the ticket-05 drift-guard test imported an untyped `.mjs` and added
2 `tsc` errors. Declared in `src/types/legacy.d.ts` alongside the existing
patterns, so the casts came out of the test too. Back to the pre-existing 81.

**Still not verified: a live sale.** The stack is down and the gateway images are
absent locally, so no licence has been minted by a running gateway, delivered by
DM and unlocked on a device. This screen is the tool for that when a stack with
b0fdca5 and b282e87 is available; everything above it is now proven against real
signed vouchers.

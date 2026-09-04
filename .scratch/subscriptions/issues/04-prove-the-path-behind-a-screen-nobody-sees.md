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

## The live attempt, and what it actually showed

The earlier claim that this was "blocked, images absent" was WRONG, and worth
correcting rather than repeating: the images were present, and the stack is
project `imani-test` (not `imani-deploy`) with the wallet's own
`deploy/compose.override.yml`. It was stopped, not missing.

So it was brought up, with gateway-customer rebuilt from source via
`jib:dockerBuild` so the image actually contained b0fdca5 and b282e87. One
pre-existing obstacle on the way: `imani-vault-jpa:latest` fails Flyway
validation against the existing volume ("applied migration not resolved
locally: 3..8"). Fixed by using the newer local `imani-vault-jpa:libfix` image
rather than deleting the volume, which would have destroyed mint keysets.

**What was proven live.** The seller script authenticated, the gateway accepted
the request with `merchant_metadata`, and the log line reads
`wallet_adapter create_voucher_direct` — which is b282e87 working on a real
gateway. That is the routing fix confirmed outside a unit test: a request
carrying metadata went to the path that can sign it rather than to
`issueAndBackup`, which would have dropped it.

**What still did not complete, and why it is not ours.** The voucher stays
PENDING: the gateway's mint client throws `RestClientException: Mint client
execution failed` with no root cause, while the same quote read directly from
inside the container returns `"state":"PAID"`. A CONTROL was run to place the
blame properly — the identical endpoint, same seller, **no metadata at all** —
and it stalled at PENDING in exactly the same way. So this is a
locally-built-gateway against pinned-mint-image incompatibility in the client
library, present with or without any licence work.

The consequence for this ticket: nothing reached a wallet, so the screen has not
yet been driven by a licence that a real gateway minted and a real DM delivered.
Everything up to the mint's settlement step now has live evidence; that last hop
needs a stack whose gateway and mint images are built from the same BOM.

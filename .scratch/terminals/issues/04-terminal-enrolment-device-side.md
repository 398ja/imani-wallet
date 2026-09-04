# 04: Terminal enrolment, the device side

**What to build:** A device can be set up as a terminal. It generates its own key,
protects it with a passphrase entered when the terminal opens for trade, and
displays that key as an enrolment code for the stall owner to scan. It then
accepts and stores whatever the owner hands back, and uses it to log itself in
from then on.

The property that matters is that the key never leaves the device. The code the
terminal displays is public, and safe to photograph, which is what makes setting
up a till in a busy market an ordinary act rather than a security event.

Until the real credential exists (ticket 10), the terminal accepts a stand-in and
the flow is demoable end to end without a mint.

**Blocked by:** 01

**Status:** done

- [x] A device generates its own key, and nothing it emits contains private key
      material. Tested as a negative, over everything the flow displays, stores,
      and transmits.
- [x] The key is protected at rest by a passphrase, entered when the terminal
      opens for trade.
- [x] The enrolment code is displayed for scanning and is safe to observe.
- [x] What the owner returns is stored and reused to log in, without a person
      present.
- [x] Nothing is stored and no session begins until enrolment actually completes.

## What it took

`src/lib/terminalEnrol.ts`, following `registration.ts`'s ordering discipline
because the correctness argument is identical: nothing is persisted and no
session begins until enrolment actually completes.

The key is minted in memory in a module-level `pending`, deliberately not
exported — a caller that could read it could log it, and the one thing this
module promises is that nothing outside it sees the private half.
`completeEnrolment` is the only thing that writes, and it writes only AFTER
`terminalActor` has verified the credential against this device's own key, so a
credential meant for another terminal is never stored even briefly.

`enrolledActor` re-verifies the stored record rather than casting it. The record
lives on disk where anything could edit it, so a device whose storage was
tampered with to add issuance is refused at launch rather than at the API.

Retrying shows the SAME code: an owner who scanned once and hit a network error
should not have to rescan a new key.

## Evidence

16 tests. The key-safety one is a real negative — it takes the secret the key
store was actually handed and asserts that exact string appears in nothing the
flow displayed or wrote.

Three mutation controls, all verified to bite:

- Saving the key at `begin()` instead of on completion — 6 failures.
- Leaking the private key into the enrolment URI — 2 failures.
- Verifying the credential against its own claimed lock rather than this
  device's key — 1 failure. That is the one that makes a photographed
  credential worthless.

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

**Status:** ready-for-agent

- [ ] A device generates its own key, and nothing it emits contains private key
      material. Tested as a negative, over everything the flow displays, stores,
      and transmits.
- [ ] The key is protected at rest by a passphrase, entered when the terminal
      opens for trade.
- [ ] The enrolment code is displayed for scanning and is safe to observe.
- [ ] What the owner returns is stored and reused to log in, without a person
      present.
- [ ] Nothing is stored and no session begins until enrolment actually completes.

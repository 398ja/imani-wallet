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

**Status:** ready-for-agent

- [ ] The screen is reachable only with a valid licence, and the refusal is the
      real one rather than a hidden menu item.
- [ ] A licence sold by hand, delivered by DM, unlocks it on the customer's device
      with no further step.
- [ ] Letting it expire locks it, after the grace window and not before.
- [ ] Renewing unlocks it again without re-enrolling or reinstalling anything.
- [ ] The screen names what it believes and why, in terms that answer a support
      question rather than only a developer's.

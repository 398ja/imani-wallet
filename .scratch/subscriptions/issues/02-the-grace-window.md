# 02: Keep working when nothing can be checked

**What to build:** The grace window. A verified licence unlocks its features for
twenty-four hours from the last successful verification, and the app keeps
working through that window even when it can check nothing at all.

The window is measured from the last verification rather than from install, so
staying offline cannot extend it indefinitely.

This is the fail-open half of ADR 0007 and the opposite of how the money path
behaves. Refusing a paying merchant mid-trade over an outage that is ours is
worse than granting a lapsed one an extra day, and that asymmetry is the whole
reason this ticket exists separately: it is easy to build a verifier that is
correct and unusable.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] A licence verified once keeps its features through the window with every
      check made impossible.
- [ ] The features stop when the window passes, tested by moving the clock rather
      than by waiting.
- [ ] The window is measured from the last successful verification, so an app
      that has never verified gets no window.
- [ ] An EXPIRED voucher locks at once and gets no window, because an expiry is a
      signed answer rather than an outage.
- [ ] A test fails against an implementation with no window at all — a happy-path
      test would not.

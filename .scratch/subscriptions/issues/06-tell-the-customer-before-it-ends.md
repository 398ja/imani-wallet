# 06: Say it is ending, before it ends

**What to build:** Expiry notice. An in-app banner from seven days out, and a DM at
seven days and again on the last day.

Two channels because they reach different moments: the DM reaches an owner who is
not looking at the app, on the delivery path already trusted for everything else,
and the banner reaches them at the till. One missed message should not be a lapse.

Neither blocks anything. This is information, not a gate, and a notice that
interrupts trade to talk about billing would be the same mistake the lapse design
exists to avoid.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] A banner appears from seven days out and names the date.
- [ ] A DM goes at seven days and on the last day.
- [ ] Neither blocks, modals over, or interrupts anything in progress.
- [ ] Renewing clears the notice without the customer dismissing it.
- [ ] A customer who never renews is told twice and then simply lapses, with no
      further nagging.

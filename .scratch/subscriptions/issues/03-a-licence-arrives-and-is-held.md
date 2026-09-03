# 03: A licence arrives, and the wallet keeps it

**What to build:** Delivery and storage. A licence voucher reaches the customer by
the same gift-wrapped DM everything else uses, the wallet recognises it as a
licence rather than as money, and keeps it where the check can find it.

The recognition matters more than the storage. A licence is a voucher, so a
wallet that treats it as an ordinary coupon will offer it for spending and sum
it into a balance — and a merchant whose takings figure silently includes a
subscription they bought is being told something false about their business.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] A licence arriving by DM is recognised and kept, without the customer
      activating anything or typing a code.
- [ ] A licence is never offered for spending and never counted in a balance or a
      takings total.
- [ ] A licence carrying a later expiry replaces the one held, so a renewal needs
      no action from the customer.
- [ ] A second licence for the same subscription id does not produce two.
- [ ] The customer can see what they paid and until when, from the voucher itself.

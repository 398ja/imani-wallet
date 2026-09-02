# 09: Terminal attribution on the stall's records

**What to build:** The stall's own records show which terminal handled each
movement, so an owner can reconcile a till at the end of the day and answer a
question about a particular sale.

Attribution is private to the stall. It goes on the stall's copy of the record
and never onto the coupon, because a customer holding a coupon should learn who
honours it and nothing about how the stall is staffed.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] A movement handled by a terminal records which terminal it was.
- [ ] The owner can see that attribution in their records.
- [ ] The customer's copy carries no terminal information.
- [ ] Attribution survives the terminal's revocation, and reads as a terminal no
      longer in service.
- [ ] Movements the stall handled on its own device are attributed to the stall.

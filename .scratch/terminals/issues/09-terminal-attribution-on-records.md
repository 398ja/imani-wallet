# 09: Terminal attribution on the stall's records

**What to build:** The stall's own records show which terminal handled each
movement, so an owner can reconcile a till at the end of the day and answer a
question about a particular sale.

Attribution is private to the stall. It goes on the stall's copy of the record
and never onto the coupon, because a customer holding a coupon should learn who
honours it and nothing about how the stall is staffed.

**Blocked by:** 05

**Status:** done

- [x] A movement handled by a terminal records which terminal it was.
- [x] The owner can see that attribution in their records.
- [x] The customer's copy carries no terminal information.
- [x] Attribution survives the terminal's revocation, and reads as a terminal no
      longer in service.
- [x] Movements the stall handled on its own device are attributed to the stall.

## What it took

`src/lib/terminalAttribution.ts`, a `terminalPubkey` on the stall's own
transaction row, and a "Handled by" line on the record screen.

The privacy criterion is the one worth the care, and it is asserted against
the payload a customer ACTUALLY receives rather than against the function that
builds it. The stall's record and the customer's coupon are constructed a few
lines apart in the same function, so putting attribution on the wrong one is a
one-word mistake and nothing about the resulting coupon would look wrong. The
test stringifies every body that left the device and asserts the terminal key
appears in none of them.

Three readings that are each a decision rather than a default:

- The stall's own movements are attributed to the STALL, not left blank. A
  blank reads as "unknown", and an owner scanning a day's takings should not
  have to learn that most rows being empty is normal.
- A revoked terminal keeps its NAME and gains a status. Revoking withdraws
  authority and never erases history.
- A key with no roster row reads as "no longer listed", NOT as the stall —
  that would be a claim the data does not support, and would hide a till from
  a reconciliation.

The row stores the terminal's KEY rather than its name, so a rename does not
orphan six months of history.

## Evidence

14 tests. Mutation controls: leaking into the coupon (2 failures), a revoked
terminal losing its name (1), an unknown terminal read as the stall (1), owner
movements gaining an attribution (1).

One mutation appeared to survive and had simply not been applied — shell
escaping failed silently on a template literal. Re-applied properly, it kills
its test. Recorded because a mutation that does not apply looks exactly like a
test that does not work, and trusting the first reading would have left a real
gap unnoticed.

1917 tests pass, lint clean, tsc at the pre-existing 81, and the 33-check
browser E2E still passes.

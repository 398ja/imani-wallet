# 05: Terminal enrolment, the owner side

**What to build:** A stall owner can put a device on the counter. They name the
terminal, choose its role, scan the code the device is showing, and issue it its
authority. The terminal is live at the end of this, and the owner keeps whatever
is needed to revoke it later without the device present.

Enrolment needs connectivity, and there is no degraded path: the authority has to
be created, and creating it is an online act. The owner is told so, so that
terminals are set up before the market opens rather than during the first queue.
Pre-issuing a stock of unassigned terminal authorities is deliberately not
offered, as those would be credentials to the stall sitting in a drawer.

**Blocked by:** 01, 04

**Status:** ready-for-agent

- [ ] The owner names a terminal and picks a role from the fixed catalog; a
      terminal cannot go live without a role.
- [ ] Scanning the device's code and confirming issues its authority.
- [ ] The owner retains the means to revoke this terminal later without the device.
- [ ] Enrolment requires connectivity, and says so plainly rather than failing
      obscurely.
- [ ] Authority is issued for the owner's own stall, and cannot be issued for
      another.

# 01: Name the terminal role vocabulary and permission shape

**What to build:** The fixed catalog of terminal roles, and the form a granted
permission takes. A role names a job a device is put on the counter to do:
redemption only, or issuance and redemption. A granted permission carries the
stall it was granted for, so that holding "may redeem" is always holding "may
redeem for this stall".

This ticket ships no screen. It exists because the stall parameter is the
boundary between one stall's terminals and every other stall's business, and it
should be settled and adversarially tested on its own rather than arrived at
while building a screen.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] The role catalog is fixed and closed: a role outside it cannot be assigned.
- [ ] A granted permission carries the issuing stall, and a permission without one
      cannot be constructed.
- [ ] A permission granted for one stall does not authorise the same action for a
      different stall. Tested adversarially, not by confirming the happy path.
- [ ] Granted output is validated against the permission registry, and an
      undeclared role or permission is a denial rather than a silent pass.
- [ ] The vocabulary matches CONTEXT.md: these are terminals and stalls, not
      subaccounts and merchants.

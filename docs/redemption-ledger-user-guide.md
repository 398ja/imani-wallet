# The redemption ledger — user guide

When a customer hands you a coupon and you give them goods, the wallet publishes
a small public record saying *"a coupon was honoured"*. That record carries no
amount, no customer, no stall name, and not your account key.

This is the difference between **"trust us, we're honest"** and **"don't trust
us — here's the receipt, check it yourself"**.

- [What the ledger is for](#what-the-ledger-is-for)
- [Your ledger ID](#your-ledger-id)
- [Your published record](#your-published-record)
- [Checking for gaps](#checking-for-gaps)
- [Proving your totals to an auditor](#proving-your-totals-to-an-auditor)
- [For auditors and coupon issuers](#for-auditors-and-coupon-issuers)
- [What the ledger cannot tell you](#what-the-ledger-cannot-tell-you)
- [Common questions](#common-questions)

## What the ledger is for

Your own transaction history is private: it is encrypted to your key, and nobody
else can read it. That is excellent for privacy and useless for proving
anything. If a customer or a coupon issuer asks "did that stall really honour
the coupons it accepted?", an encrypted history cannot answer.

The redemption ledger is the other half. One small unencrypted record per
redemption, published to a public network, carrying only what an audit needs:

| Published | Not published |
|---|---|
| An opaque tag, unique to the coupon token | The amount you credited |
| A sealed "commitment" to the amount | Your stall name or account key |
| The currency | Which customer paid |
| A signature from your **ledger key** | The voucher ID |

Anyone can read it. Nobody reading it can tell it is *you*, or what any single
redemption was worth.

## Your ledger ID

**Settings → Redemption ledger.**

Your ledger ID is a 64-character code that identifies your published record. It
is a pseudonym: it is derived from your account key, but nobody can work
backwards from it to your account, and nobody can guess it from a coupon you
issued.

Share it with an auditor, a coupon issuer, or anyone who needs to check your
record. Copy it with the **Copy ledger ID** button rather than reading it out,
since one wrong character points at a different stall entirely. The code itself
stays folded away under **Show ledger ID** until you ask for it.

Two things worth knowing:

- **It is not your account key and never acts like one.** Sharing it lets
  someone *read* your published redemptions. It gives them no ability to spend,
  issue, or sign anything.
- **It survives a lost phone.** Restore your wallet from your key and you get
  the same ledger ID back, along with the ability to audit everything you ever
  published. There is nothing extra to write down.

You must unlock your wallet to see it. If the screen says so, tap through the
unlock and come back.

## Your published record

The same screen shows what your stream looks like **read back from the network**,
not from your phone. This matters: you are being shown exactly what an outside
auditor sees about you, using the same reader they would use. A screen that ran
a gentler check would be reassurance about nothing.

| Row | Meaning |
|---|---|
| **Redemptions published** | How many records are on the network under your ledger ID |
| **Currencies** | The units you have traded in |
| **Most recent** | When your last record was published |
| **Conflicting records** | Only ever shown when non-zero — see below |
| **Unreadable records** | Events under your ID this reader refuses |

No amounts appear here, and there is nowhere to put one. Hiding your takings is
the entire point of the scheme. Your own figures are in your transaction list,
where they belong.

**"Conflicting records" is the one to act on.** It means the same coupon appears
twice with different details, which should never happen from normal trading.
Contact support with your ledger ID.

**"Unreadable records" is usually harmless.** Anyone can publish to a public
network, so junk under your ID may simply be junk. It can also mean a newer app
version is publishing in a format this one predates.

## Checking for gaps

A record can fail to publish. The app closed mid-send, the network dropped, the
network was briefly unreachable. Your customer got their goods and your books are
correct, but the public record has a hole in it.

**Settings → Redemption ledger → Check now.**

This compares the redemptions on your device against what is actually published,
and republishes anything missing. You will see one of:

- *"All 12 redemptions are published."* — nothing to do.
- *"Found 2 missing of 12. Republished 2."* — the gaps are now closed.
- *"No redemptions to check yet."* — nothing on this device qualifies.
- *"Could not finish the check."* — nothing was changed. Try again in a moment.

Republishing is safe to repeat. Running the sweep twice produces an identical
record rather than a second, conflicting one, so you can never create a
"conflicting records" finding by pressing the button again.

**Run this before anyone audits you.** A gap and a dishonest merchant look
identical from outside, and the sweep is what turns "there's no record of this"
from an accusation into a question. Anyone reading your ledger is expected to
give you the chance to sweep first.

Some rows are skipped rather than treated as gaps. Redemptions from before this
feature existed, and coupons that carried no verified issuer signature, cannot
be republished and were never meant to be.

## Proving your totals to an auditor

You can prove what you took over a set of redemptions **without revealing any
single amount**, and without handing over any key.

The maths: each published record seals one amount. Those seals add up. If you
disclose which redemptions you are covering and one extra number from your
wallet, an auditor can check that the sealed amounts sum to exactly the total
you claim. Understate or overstate by a penny and it fails.

What you give the auditor:

1. the list of coupon tags (nullifiers) you are covering,
2. the total you say you credited,
3. the summed blinding scalar from your wallet.

One currency per disclosure. A total mixing XAF and EUR verifies perfectly and
means nothing, so the wallet refuses to produce it.

**Be honest about what this proves.** It proves the redemptions *you disclosed*
add up to the total you claimed. It does not prove you disclosed all of them —
you chose the list, and leaving one out reconciles perfectly at a lower total.
Completeness has to come from somewhere else, such as a customer producing a
coupon tag that is missing from your disclosure.

## For auditors and coupon issuers

Given a merchant's ledger ID, you can check their record yourself. On staging:

```console
# Everything published under one ledger ID
$ curl -s https://audit.staging.398ja.xyz/api/v1/audit/ledger/<ledger-id>
```

You get the redemption count, the currencies, first and last activity, any
conflicts, and the individual records. You get no amounts, because they are not
knowable.

```console
# Every ledger on the stream
$ curl -s https://audit.staging.398ja.xyz/api/v1/audit/ledgers

# Tokens claimed twice with conflicting details, across all merchants
$ curl -s https://audit.staging.398ja.xyz/api/v1/audit/duplicates

# Check a disclosed total
$ curl -s -X POST https://audit.staging.398ja.xyz/api/v1/audit/verify-total \
    -H 'Content-Type: application/json' \
    -d '{"nullifiers":["<hex>","<hex>"],"total":4000,"blindSum":"<hex>"}'
```

No account, no key, no login. That is deliberate: a login would protect nothing,
since everything served is already public, while implying a confidentiality this
data does not have.

**An empty result is not a finding.** A ledger ID with no records and a ledger ID
that does not exist are indistinguishable on a pseudonymous stream, so the
service returns success either way rather than inventing a distinction the data
cannot support.

**A single coupon check needs the coupon's own tag**, not a ledger ID. Both are
64-character hex and the service cannot tell them apart, so feeding a ledger ID
to the coupon endpoint will cheerfully answer "missing" about a coupon that
never existed. That is not a finding about the merchant.

### Reading a coupon verdict

| Verdict | What it means |
|---|---|
| `honoured` | A signed record exists. This is **proof**. |
| `conflicting` | Claimed more than once with different details. Needs a human. |
| `pending` | No record yet, and not yet late. Says nothing. Ask again later. |
| `missing` | No record, and past the one-hour window. **Evidence of a gap.** |

The asymmetry is the important part. `honoured` is proof, because a signed
record either exists or it does not. `missing` is only ever evidence: a lost
publish looks exactly like a dishonest merchant until the merchant runs their
sweep. Never quote `missing` at a stall as though it settled the matter.

## What the ledger cannot tell you

Stated plainly, because these are deliberate trades and not gaps waiting to be
closed:

- **Which real stall a ledger ID belongs to.** There is no lookup table, by
  decision. Such a table would be the one artefact whose breach de-anonymises
  every merchant at once, retroactively. A merchant who wants to be known links
  their own ID, to whom they choose.
- **What any single redemption was worth.** That is what the commitments are for.
- **Whether a merchant published everything.** Nothing inside a ledger reveals a
  redemption that was never written down. A plain-text ledger has exactly the
  same hole. What closes it is the mint, which independently knows a coupon was
  spent.

Some things are visible whether you like it or not, and no cryptography fixes
them. Anyone watching one ledger ID can see how busy that stall is, roughly when
it trades, and which currencies it takes. A rare currency narrows the field
considerably.

## Common questions

**Does this reveal my takings?**
No. Amounts are sealed, and your identity is not on the record. Someone watching
your ledger ID learns how many coupons you honoured and when, not for how much.

**Can a customer work out my ledger ID from a coupon I issued?**
No. It is derived from your secret key, not your public one. A pseudonym derived
from public information would be broken by the first customer who checked.

**Can someone publish fake records under my ledger ID?**
They can publish events claiming to be you, but they cannot sign them as you.
Every reader verifies the signature and refuses the rest. Forgeries show up as
refused events rather than as redemptions.

**I lost my phone. Is my ledger gone?**
No. Restore from your key and you get the same ledger ID and the ability to
re-open every commitment you ever published.

**Do I have to do anything for this to work?**
No. Publishing happens automatically when you redeem a coupon with a verified
issuer signature. The only manual action is **Check now**, and only if you want
to be sure there are no gaps.

**A redemption isn't in my published record. Did I lose money?**
No. The ledger is a record, not the money. Your customer was served and your
transaction list is correct. Press **Check now** to close the gap.

**Why do plain ecash payments not appear?**
There is no issuer claim to attest to. The face value of plain ecash comes from
whoever sent it, and signing "I credited N" where N is a figure a counterparty
supplied would be attesting to something nobody established.

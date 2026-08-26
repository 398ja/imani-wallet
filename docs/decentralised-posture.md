# No honeypot to raid: the decentralised posture of Imani Wallet

Every few months another mass breach lands: a tax authority, a health service, a
payments company spills the personal and financial records of hundreds of
thousands of people. The official response is always the same shape, different
platforms, regular audits, no zero risk anywhere anyway. It is worth understanding
why these breaches keep happening, because the reason is also the argument on which
Imani Wallet is built.

## The argument

Four observations, taken together, explain both the breaches and the design.

1. **The economics of attack have inverted.** Breaking into a system used to take
   real expertise: find one flaw in the fortress wall, patiently. Today an attacker
   with a computer and a credit card can throw every known weakness at a target at
   once, cheaply, with no deep security knowledge. The reward for a successful hit,
   especially for tax or payment data, stays high; the cost of the attack has
   collapsed. Defence and attack are now badly asymmetric, in the attacker's favour.

2. **Centralised data stores are the target, by construction.** Call them
   *honeypots*: concentrations of data so valuable that they draw the attacks. When
   the asymmetry favours the attacker, the rational response is not a taller wall.
   It is to stop building the honeypot, collect the minimum, distribute the stores,
   keep only what an activity actually needs, so that attackers go after a bigger,
   softer target instead of you. There is no zero risk, but you can always arrange
   for the neighbour to be attacked rather than you.

3. **Assume everything you hand over will leak.** The only safe posture toward any
   central custodian is to treat it as if it runs an open-data programme on your
   private information: whatever you declare ends up in the wild eventually.
   Minimise what you expose, separate your identities, and verify everything sent to
   you.

4. **The trust model can be inverted.** A system can be built as if every user were
   a potential criminal, transparent and decentralised, and be secure not despite
   operating in a hostile environment but *because* it was designed for one. Strong
   encryption and digital signatures, a standard that has run the internet for
   decades and has never been broken, let users secure themselves with no central
   point of vulnerability to raid. This posture presumes people have natural rights,
   to privacy and to property, and treats them as adults who own their money and
   their risk rather than as suspects to be monitored.

Strip it to an engineering doctrine and you have: **minimise the data, distribute
the stores, encrypt by default, trust no central custodian, and design as if the
environment is already compromised.** Imani Wallet is a working application of that
doctrine to everyday money.

## What Imani Wallet is

Imani Wallet is a phone wallet for coupons you spend like cash at local
businesses: the market stall, the farm gate, the corner shop. A merchant issues a
coupon with a value; it lands in a shopper's wallet in seconds; the shopper later
spends it back with that merchant, in full or in part, with change returned as a
smaller coupon.

The interesting part is not the feature. It is the posture. Every architectural
choice in the wallet is the choice the doctrine above demands, and the one a
conventional payments system refuses to make.

## 1. There is no honeypot

The single most important fact about Imani Wallet is what the backend is *not*
allowed to hold.

The customer wallet is **self-custodial**, and this is enforced as a first
principle, not a preference. The backend literally refuses to store the things a
conventional payments company would centralise. From the code that issues a
coupon:

> the customer-wallet is self-custodial (Constitution Principle II). Voucher
> state is client-held; the backend MUST NOT persist vouchers, proofs, or
> balances. If a caller is hitting this guard, its request is routing to the wrong
> tier.

A traditional wallet keeps every user's balance in one database. That database is
the honeypot: a concentration of value that draws every attack, where one breach
spills everyone's money and history at once. Imani has no such table. Your coupons
are **bearer tokens that live on your own device**, like cash in your own pocket.
There is no central ledger of who holds what, because the tokens *are* the value
and they are not on a server.

This is decentralisation as damage-limitation: make yourself a small target so an
attacker goes after a bigger, softer one. There is no mammoth to aim at.

## 2. Collect the minimum, and split what remains

The prescription is to minimise collected data and distribute what is kept across
many small stores rather than one attractive one. Imani does both.

- **Coupons** live on the phone.
- **Your key** lives on the phone, encrypted.
- **Your profile**, and for a merchant **your sales ledger**, are published to a
  distributed messaging network (Nostr), but **encrypted to your own key**, so a
  relay holds ciphertext it cannot read. A merchant's issuance history is written
  as one encrypted event per coupon; the stall's public details (its name, so
  customers can recognise it) are the *only* thing left readable, and deliberately
  so.

There is no single database that, once breached, yields a population's financial
lives. There are many small stores, most of them holding either your own device's
data or ciphertext only your key opens. The data that would make a breach
lucrative was never centralised to begin with.

## 3. Encryption instead of trust

The technical heart of the doctrine is the inversion: don't ask users to trust a
custodian to guard a plaintext store; give them cryptography so there is nothing
to guard.

Imani's key custody follows this to the letter:

- The private key is held in a **WebCrypto keystore, PBKDF2 + AES-GCM**, with a
  fresh salt and IV per write. Plaintext key material is never at rest, not even
  in local storage.
- Locking the wallet doesn't just flag a session as closed, it **zeroes the key
  bytes in memory**. The signer contract requires a lock to actually erase key
  material, not merely mark state. A locked wallet has, in the code's own words,
  "no key in memory to steal."
- A coupon is a signed token; spending it swaps it at the mint for a fresh one, so
  the same coupon cannot be spent twice. Authenticity comes from signatures that
  can be checked but not forged, the same primitive that lets a public,
  decentralised network stay secure: strong encryption and digital signatures as
  the thing that lets users secure themselves.

The wallet secures value the way a well-designed decentralised network secures
value, and for the same reason: it was designed for a hostile environment from the
start.

## 4. Designed as if everyone is an attacker

The most robust systems are designed as if every user were a potential criminal.

Imani inherits that adversarial default in the least glamorous, most telling
place: how it treats data it receives. A merchant's public profile, published to a
relay, is annotated in the source as **attacker-controllable**, because anyone can
publish a record claiming to be someone else. The wallet therefore verifies rather
than trusts. Coupon metadata is validated against the token's own signed contents
rather than believed from the envelope it arrived in. Incoming payment
notifications are validated field by field, with a named rejection reason for each
failure mode, precisely because the message is sender-authored and not covered by
any signature.

This is the discipline of assuming the environment is already compromised, applied
not to a threat model on a slide but to every input the code accepts. It is the
rule "verify absolutely everything sent to you," turned into software.

## 5. The trade-off is named, not hidden

The doctrine has a cost, and honesty requires naming it. A posture of total
suspicion is a limited and, frankly, regrettable place to have arrived. Imani is
equally candid about the cost of self-custody.

Because you hold your own key, **there is no password reset**. No support line can
recover your account. Logging out deliberately **wipes the key from the device**.
The wallet says this in plain terms at the moment it matters, and it ships an
encrypted backup precisely because the honest version of self-custody has to hand
you the responsibility along with the control.

This is the natural-rights framing made concrete: the wallet treats you as an
adult who owns your money and your risk. It does not hold your funds hostage for
your own safety, and it does not pretend the freedom is free.

## Why this matters

Mass breaches are not outliers; they are what the current paradigm must keep
producing. An institution that centralises ever more data to watch its users builds
ever more valuable honeypots, at a time when the cost of attacking them has
collapsed. It is only a matter of time before each one ends up in the wild.

Imani Wallet is a small, concrete rebuttal: a payments system that works, that
people can actually use at a market stall, and that offers attackers no central
prize to steal. It does not ask you to trust that a custodian will guard your money
well. It arranges things so there is no custodian, no central store, and nothing in
one place worth the raid.

That is the decentralised posture, and it is not a slogan. It is the design a
hostile network forces on anything that wants to survive it, applied to the coupon
in your pocket: minimise the data, distribute the stores, encrypt by default,
verify every input, and hand the user both the key and the responsibility that
comes with it.

---

*Architectural claims are drawn from the Imani Wallet source. The original design
record (`docs/superpowers/specs/2026-08-11-farmer-coupon-wallet-design.md`) was
retired once the code became the authority; it remains in git history if the
reasoning behind a decision is ever needed. For the plain-language version of how
the wallet works, see [how-it-works.md](how-it-works.md).*

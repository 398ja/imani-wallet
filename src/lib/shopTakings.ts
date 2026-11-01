import { allTerminals } from './terminalRoster'

/**
 * Takings handed in by an online shop (#402 §4 step 4, contract §5).
 *
 * After a checkout the shop re-locks every part to the STALL (P2PK, no locktime) and sends one
 * NIP-17 message per `voucher_id`. Each arrives through the ordinary DM receive path: the stall
 * signs the NUT-11 witness for its own lock (`witness.buildWitnesses`), files one claim row per
 * voucher against its issued row (`merchantClaim`), and publishes the kind-7377 attestation.
 * Nothing about a shop's hand-in is special except who brought it, which this answers.
 *
 * The sender is the DM's author as dm-poll reports it (the rumor's pubkey; nostr-tools' unwrap
 * does not check it against the seal's signer). So this is a label, never authority: it only names
 * a till on the stall's own row, it moves no money and no ceiling (the claim gates do that), and it
 * matches only a key the stall itself enrolled as a shop. A row whose shop was since revoked still
 * names it, as for any till.
 */
export function shopAttributionFor(
  sealerPubkey: unknown,
  stallPubkey: string | undefined,
): string | undefined {
  if (typeof sealerPubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(sealerPubkey) || !stallPubkey) return undefined
  const key = sealerPubkey.toLowerCase()
  try {
    const row = allTerminals(stallPubkey).find((t) => t.shop && t.terminalPubkey.toLowerCase() === key)
    return row ? row.terminalPubkey : undefined
  } catch {
    return undefined
  }
}

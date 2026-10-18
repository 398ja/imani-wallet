/**
 * Attach a stall's signed issuer delegation to its sealed credential.
 *
 *   PURCHASE_VAULT_KEY=... PURCHASE_CREDENTIALS_PATH=/var/lib/imani/purchase-credentials.json \
 *     npx tsx services/purchase-issuer/attachDelegation.ts <stall-pubkey> <delegation-event.json>
 *
 * The delegation is the kind-30078 event the STALL signed with its own key
 * (`src/lib/issuerDelegation.ts` `issuerDelegationTemplate`), naming this
 * service's lock key for that stall. It is public, so passing it on the
 * command line or in a file exposes nothing. Since imani-wallet#152 this
 * service mints nothing for a stall without one, because the till refuses
 * every coupon it cannot verify.
 *
 * Refuses, writing nothing, if the delegation would not be accepted for a
 * coupon minted today (`checkDelegation`).
 *
 * Then CONFIRMS the credential at the gateway (imani-wallet#296), when
 * `PURCHASE_GATEWAY_URL` is set. gateway-customer lapses a terminal credential
 * left unconfirmed for 24 hours, and a stall's first card sale may come much
 * later than that. Exits non-zero if the gateway answers 410 (expired: mint a
 * new credential and enrol again) or does not confirm. The service also
 * confirms every credential it holds at startup.
 */
import { readFile } from 'node:fs/promises'

import { confirmStanding, FileCredentialStore } from './adapters'
import { checkDelegation } from './delegatedWarrant'
import { DEFAULT_EXPIRES_IN_DAYS } from './issuer'
import { CredentialVault } from './vault'

async function main(): Promise<void> {
  const [stallPubkey, path] = process.argv.slice(2)
  if (!stallPubkey || !path) {
    throw new Error('usage: attachDelegation.ts <stall-pubkey> <delegation-event.json>')
  }
  const vaultKey = (process.env.PURCHASE_VAULT_KEY ?? '').trim()
  const credentialsPath = (
    process.env.PURCHASE_CREDENTIALS_PATH ?? '/var/lib/imani/purchase-credentials.json'
  ).trim()

  const delegation = (await readFile(path, 'utf8')).trim()
  const vault = new CredentialVault(vaultKey, new FileCredentialStore(credentialsPath))
  await vault.attachDelegation(
    stallPubkey.toLowerCase(),
    delegation,
    Date.now() + DEFAULT_EXPIRES_IN_DAYS * 86_400_000,
    checkDelegation,
  )
  console.log(`delegation attached for ${stallPubkey.slice(0, 12)}…`)

  const gatewayUrl = (process.env.PURCHASE_GATEWAY_URL ?? '').trim()
  if (gatewayUrl === '') {
    console.warn(
      'PURCHASE_GATEWAY_URL is not set: credential NOT confirmed. Restart purchase-issuer within ' +
        '24 h of minting it (it confirms at startup), or the gateway lapses it.',
    )
    return
  }
  const credential = await vault.get(stallPubkey.toLowerCase())
  const standing = credential ? await confirmStanding(gatewayUrl, credential) : 'unconfirmed'
  if (standing === 'expired') {
    throw new Error(
      'the gateway says this credential EXPIRED unconfirmed (410): mint a new one and enrol again',
    )
  }
  if (standing !== 'confirmed') {
    throw new Error('the gateway did not confirm this credential; run this again, or restart purchase-issuer')
  }
  console.log('confirmed: in service at the gateway')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

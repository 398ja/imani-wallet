/**
 * imani-mailer operator commands.
 *
 *   npx tsx services/imani-mailer/cli.ts token <client-id> [template,...|*] [--bounce] [--check]
 *       A new random bearer token for a client, and the MAILER_CLIENTS entry that names its HASH.
 *       Give the token to the caller (its own secret store); put only the entry in configuration.
 *
 *   npx tsx services/imani-mailer/cli.ts check
 *       Load the configuration from the environment exactly as the server does, and report.
 *
 *   npx tsx services/imani-mailer/cli.ts dkim-dns <selector> <domain> <private-key.pem>
 *       The TXT record to publish for a DKIM key.
 */
import { createHash, createPublicKey, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { ConfigError, describeConfig, loadConfig } from './config.ts'

const [command, ...args] = process.argv.slice(2)

if (command === 'token') {
  const id = args[0]
  if (!id || !/^[a-z][a-z0-9-]{1,63}$/.test(id)) {
    console.error('usage: token <client-id> [template,...|*] [--bounce] [--check]')
    process.exit(2)
  }
  const templates = (args[1] && !args[1].startsWith('--') ? args[1] : '').split(',').filter(Boolean)
  const token = randomBytes(32).toString('base64url')
  const entry = {
    id,
    tokenSha256: createHash('sha256').update(token).digest('hex'),
    templates,
    bounce: args.includes('--bounce'),
    check: args.includes('--check'),
  }
  console.log(`token (give to the caller, shown once):\n  ${token}\n\nMAILER_CLIENTS entry:\n  ${JSON.stringify(entry)}`)
} else if (command === 'check') {
  try {
    console.log(JSON.stringify(describeConfig(loadConfig()), null, 2))
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : (e as Error).message)
    process.exit(1)
  }
} else if (command === 'dkim-dns') {
  const [selector, domain, file] = args
  if (!selector || !domain || !file) {
    console.error('usage: dkim-dns <selector> <domain> <private-key.pem>')
    process.exit(2)
  }
  const der = createPublicKey(readFileSync(file, 'utf8')).export({ type: 'spki', format: 'der' })
  console.log(`${selector}._domainkey.${domain}. IN TXT "v=DKIM1; k=rsa; p=${der.toString('base64')}"`)
} else {
  console.error('commands: token, check, dkim-dns')
  process.exit(2)
}

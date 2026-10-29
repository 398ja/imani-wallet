import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ConfigError, describeConfig, loadConfig } from '../config'
import { CLIENTS, devEnv, ISSUER_TOKEN } from './fixtures'

const noFiles = () => {
  throw new Error('ENOENT')
}
const problems = (env: Record<string, string | undefined>, files: Record<string, string> = {}): string[] => {
  try {
    loadConfig(env, (p) => {
      if (p in files) return files[p]
      throw new Error('ENOENT')
    })
    return []
  } catch (e) {
    if (e instanceof ConfigError) return e.problems
    throw e
  }
}

const PROD = {
  MAILER_TRANSPORT: 'smtp',
  MAILER_SMTP_HOST: 'smtp.provider.test',
  MAILER_SMTP_USER: 'apikey',
  MAILER_SMTP_PASSWORD: 'secret-password',
  MAILER_FROM_ADDRESS: 'gifts@imani.casa',
  MAILER_LINK_HOSTS: 'imani.casa',
  MAILER_CLIENTS: JSON.stringify([{ ...CLIENTS[0] }]),
  MAILER_TAG_KEY: 'ab'.repeat(32),
  MAILER_STATE_FILE: '/var/lib/imani-mailer/state.json',
}

describe('loadConfig', () => {
  it('a development config loads', () => {
    expect(() => loadConfig(devEnv(), noFiles)).not.toThrow()
  })

  it('production is the default, and a production config with TLS, auth and state loads', () => {
    const c = loadConfig(PROD, noFiles)
    expect(c.env).toBe('production')
    expect(c.smtp).toMatchObject({ security: 'starttls', port: 587, rejectUnauthorized: true, minTlsVersion: 'TLSv1.2' })
  })

  it('production refuses every development shortcut, listing all of them at once', () => {
    const p = problems({
      ...PROD,
      MAILER_SMTP_SECURITY: 'none',
      MAILER_SMTP_TLS_VERIFY: 'false',
      MAILER_LINK_ALLOW_HTTP: 'true',
      MAILER_TAG_KEY: undefined,
      MAILER_STATE_FILE: undefined,
      MAILER_CLIENTS: JSON.stringify([{ ...CLIENTS[0], templates: ['*'] }]),
    })
    expect(p.join('\n')).toMatch(/SECURITY=none sends in clear text/)
    expect(p.join('\n')).toMatch(/TLS_VERIFY=false is for development/)
    expect(p.join('\n')).toMatch(/ALLOW_HTTP is for development/)
    expect(p.join('\n')).toMatch(/MAILER_TAG_KEY is required/)
    expect(p.join('\n')).toMatch(/MAILER_STATE_FILE is required/)
    expect(p.join('\n')).toMatch(/"\*" templates is for development/)
    expect(problems({ ...PROD, MAILER_TRANSPORT: 'log' }).join()).toMatch(/log is for development only/)
  })

  it('credentials over a clear-text connection need an explicit opt-in', () => {
    const env = devEnv({ MAILER_TRANSPORT: 'smtp', MAILER_SMTP_HOST: 'mailpit', MAILER_SMTP_SECURITY: 'none', MAILER_SMTP_USER: 'u', MAILER_SMTP_PASSWORD: 'p' })
    expect(problems(env).join()).toMatch(/unencrypted connection/)
    expect(problems({ ...env, MAILER_SMTP_ALLOW_PLAINTEXT_AUTH: 'true' })).toEqual([])
  })

  it('a secret comes from NAME or NAME_FILE, never both', () => {
    const files = { '/run/secrets/smtp': 'from-file\n' }
    const c = loadConfig({ ...PROD, MAILER_SMTP_PASSWORD: undefined, MAILER_SMTP_PASSWORD_FILE: '/run/secrets/smtp' }, (p) => files[p as keyof typeof files])
    expect(c.smtp?.password).toBe('from-file')
    expect(problems({ ...PROD, MAILER_SMTP_PASSWORD_FILE: '/run/secrets/smtp' }, files).join()).toMatch(/both set/)
    expect(problems({ ...PROD, MAILER_SMTP_PASSWORD: undefined, MAILER_SMTP_PASSWORD_FILE: '/nope' }).join()).toMatch(/cannot be read/)
  })

  it('clients: token hashes only, unique ids and tokens, known templates, something to do', () => {
    const bad = (c: unknown[]) => problems(devEnv({ MAILER_CLIENTS: JSON.stringify(c) })).join('\n')
    expect(bad([{ id: 'x1', token: ISSUER_TOKEN, templates: ['gift-claim'] }])).toMatch(/tokenSha256 must be 64 hex/)
    expect(bad([CLIENTS[0], { ...CLIENTS[1], id: CLIENTS[0].id }])).toMatch(/duplicate id/)
    expect(bad([CLIENTS[0], { ...CLIENTS[1], tokenSha256: CLIENTS[0].tokenSha256 }])).toMatch(/shares a token/)
    expect(bad([{ ...CLIENTS[0], templates: ['nope'] }])).toMatch(/unknown template nope/)
    expect(bad([{ ...CLIENTS[0], templates: [] }])).toMatch(/may do nothing/)
    expect(bad([])).toMatch(/non-empty array/)
    expect(problems(devEnv({ MAILER_CLIENTS: '{' })).join()).toMatch(/not JSON/)
  })

  it('DKIM: all three parts, a PEM key, and the From domain for DMARC alignment', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----'
    expect(problems(devEnv({ MAILER_DKIM_DOMAIN: 'imani.test' })).join()).toMatch(/together/)
    expect(problems(devEnv({ MAILER_DKIM_DOMAIN: 'imani.test', MAILER_DKIM_SELECTOR: 's1', MAILER_DKIM_PRIVATE_KEY: 'nope' })).join()).toMatch(/PEM/)
    expect(problems(devEnv({ MAILER_DKIM_DOMAIN: 'other.test', MAILER_DKIM_SELECTOR: 's1', MAILER_DKIM_PRIVATE_KEY: pem })).join()).toMatch(/DMARC/)
    expect(problems(devEnv({ MAILER_DKIM_DOMAIN: 'imani.test', MAILER_DKIM_SELECTOR: 's1', MAILER_DKIM_PRIVATE_KEY: pem }))).toEqual([])
  })

  it('templates from a file add to and override the built-ins, and a broken one refuses the boot', () => {
    const files = {
      '/t.json': JSON.stringify({
        welcome: { subject: 'Welcome {{name}}', text: 'Hi {{name}}', fields: { name: { type: 'line', required: true } } },
        'gift-receipt': { subject: 'Receipt', text: 'Paid', fields: {} },
      }),
    }
    const c = loadConfig(devEnv({ MAILER_TEMPLATES_FILE: '/t.json' }), (p) => files[p as keyof typeof files])
    expect([...c.templates.keys()]).toContain('welcome')
    expect(c.templates.get('gift-receipt')?.def.subject).toBe('Receipt')
    const broken = { '/b.json': JSON.stringify({ leaky: { subject: '{{u}}', text: '', fields: { u: { type: 'url' } } } }) }
    expect(problems(devEnv({ MAILER_TEMPLATES_FILE: '/b.json' }), broken).join()).toMatch(/subject may not use url/)
  })

  it('bad values are named', () => {
    const p = problems(devEnv({ MAILER_FROM_ADDRESS: 'nope', MAILER_PORT: '99999', MAILER_LINK_HOSTS: 'bad host', MAILER_SANDBOX_REDIRECT: 'x', MAILER_RECIPIENT_DENY_DOMAINS: 'not a domain' })).join('\n')
    expect(p).toMatch(/MAILER_FROM_ADDRESS/)
    expect(p).toMatch(/MAILER_PORT/)
    expect(p).toMatch(/MAILER_LINK_HOSTS/)
    expect(p).toMatch(/MAILER_SANDBOX_REDIRECT/)
    expect(p).toMatch(/recipient domain/)
  })

  it('describeConfig never carries a secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailer-'))
    writeFileSync(join(dir, 'k.pem'), '-----BEGIN PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END PRIVATE KEY-----')
    const c = loadConfig({ ...PROD, MAILER_FROM_ADDRESS: 'gifts@imani.casa', MAILER_DKIM_DOMAIN: 'imani.casa', MAILER_DKIM_SELECTOR: 's1', MAILER_DKIM_PRIVATE_KEY_FILE: join(dir, 'k.pem'), MAILER_METRICS_TOKEN: 'm'.repeat(30) }, (p) => readFileSync(p, 'utf8'))
    const shown = JSON.stringify(describeConfig(c))
    for (const s of ['secret-password', 'SECRETKEYMATERIAL', 'ab'.repeat(32), CLIENTS[0].tokenSha256, 'm'.repeat(30)]) expect(shown).not.toContain(s)
    expect(statSync(dir).isDirectory()).toBe(true)
  })
})

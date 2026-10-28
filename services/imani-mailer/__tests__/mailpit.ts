/**
 * Disposable Mailpit containers for imani-mailer's integration tests.
 *
 * Each suite gets its OWN Mailpit (random host ports, removed afterwards), so the tests never read
 * or wipe the shared local Mailpit a developer is looking at, and two runs cannot see each other's
 * mail. Three flavours:
 *
 * - `plain`    SMTP without TLS (the local stack's shape).
 * - `secure`   STARTTLS REQUIRED, AUTH REQUIRED from a password file, behind a certificate signed by
 *              a throwaway CA made for this run. The mailer must trust that CA explicitly.
 * - `chaos`    plain, with Mailpit's Chaos triggers on, so a test can make the server refuse a
 *              sender, a recipient or a login with a chosen SMTP code.
 *
 * Needs Docker and openssl. Skipped (with the reason) when either is missing.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const MAILPIT_IMAGE = process.env.MAILPIT_IMAGE ?? 'axllent/mailpit:v1.32.0'
export const SMTP_USER = 'imani-mailer'
export const SMTP_PASSWORD = 'mailpit-it-password-1234'

export function dockerAvailable(): string | null {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'pipe', timeout: 10_000 })
  } catch {
    return 'docker is not available'
  }
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' })
  } catch {
    return 'openssl is not available'
  }
  return null
}

export interface Pki {
  dir: string
  caPem: string
  caFile: string
  certFile: string
  keyFile: string
}

/** A throwaway CA and a server certificate for 127.0.0.1 / localhost, valid for one day. */
export function makePki(): Pki {
  const dir = mkdtempSync(join(tmpdir(), 'imani-mailer-pki-'))
  const run = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' })
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=imani-mailer test CA', '-keyout', 'ca.key', '-out', 'ca.pem')
  run('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'server.key', '-out', 'server.csr')
  writeFileSync(join(dir, 'san.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
  run('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'san.ext', '-out', 'server.pem')
  // Mailpit runs as a non-root user inside the container and must read the mounted key.
  for (const f of ['server.key', 'server.pem', 'ca.pem']) chmodSync(join(dir, f), 0o644)
  chmodSync(dir, 0o755)
  return {
    dir,
    caPem: execFileSync('cat', [join(dir, 'ca.pem')]).toString(),
    caFile: join(dir, 'ca.pem'),
    certFile: join(dir, 'server.pem'),
    keyFile: join(dir, 'server.key'),
  }
}

/** An RSA key for DKIM, and its public half as a DKIM TXT value. */
export function makeDkimKey(): { privateKey: string; dnsTxt: string } {
  const dir = mkdtempSync(join(tmpdir(), 'imani-mailer-dkim-'))
  execFileSync('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', 'dkim.key'], { cwd: dir, stdio: 'pipe' })
  const pub = execFileSync('openssl', ['pkey', '-in', 'dkim.key', '-pubout', '-outform', 'DER'], { cwd: dir }).toString('base64')
  return { privateKey: execFileSync('cat', [join(dir, 'dkim.key')]).toString(), dnsTxt: `v=DKIM1; k=rsa; p=${pub}` }
}

export interface MailpitSummary {
  ID: string
  MessageID: string
  From: { Name: string; Address: string }
  To: Array<{ Name: string; Address: string }>
  Cc: unknown[] | null
  Bcc: unknown[] | null
  Subject: string
  Snippet: string
}

export interface MailpitMessage extends MailpitSummary {
  Text: string
  HTML: string
  ReturnPath: string
}

export interface Mailpit {
  smtpPort: number
  apiUrl: string
  messages(): Promise<MailpitSummary[]>
  message(id: string): Promise<MailpitMessage>
  raw(id: string): Promise<string>
  headers(id: string): Promise<Record<string, string[]>>
  /** Wait until at least `n` messages are stored (Mailpit stores asynchronously after 250 OK). */
  waitFor(n: number, timeoutMs?: number): Promise<MailpitSummary[]>
  clear(): Promise<void>
  chaos(triggers: Partial<Record<'Sender' | 'Recipient' | 'Authentication', { ErrorCode: number; Probability: number }>>): Promise<void>
  stop(): void
}

function hostPort(container: string, port: number): number {
  const out = execFileSync('docker', ['port', container, `${port}/tcp`]).toString()
  const line = out.split('\n').find((l) => l.startsWith('0.0.0.0:')) ?? out.split('\n')[0]
  return Number(line.slice(line.lastIndexOf(':') + 1))
}

export async function startMailpit(kind: 'plain' | 'secure' | 'chaos', pki?: Pki): Promise<Mailpit> {
  const name = `imani-mailer-it-${kind}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const args = ['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::1025', '-p', '127.0.0.1::8025', '-e', 'MP_MAX_MESSAGES=500']
  if (kind === 'secure') {
    if (!pki) throw new Error('secure Mailpit needs a PKI')
    const authDir = mkdtempSync(join(tmpdir(), 'imani-mailer-auth-'))
    writeFileSync(join(authDir, 'auth'), `${SMTP_USER}:${SMTP_PASSWORD}\n`)
    chmodSync(join(authDir, 'auth'), 0o644)
    chmodSync(authDir, 0o755)
    args.push(
      '-v', `${pki.dir}:/pki:ro`,
      '-v', `${authDir}:/auth:ro`,
      '-e', 'MP_SMTP_TLS_CERT=/pki/server.pem',
      '-e', 'MP_SMTP_TLS_KEY=/pki/server.key',
      '-e', 'MP_SMTP_REQUIRE_STARTTLS=true',
      '-e', 'MP_SMTP_AUTH_FILE=/auth/auth',
    )
  } else {
    args.push('-e', 'MP_SMTP_AUTH_ACCEPT_ANY=true', '-e', 'MP_SMTP_AUTH_ALLOW_INSECURE=true')
  }
  if (kind === 'chaos') args.push('-e', 'MP_ENABLE_CHAOS=true')
  args.push(MAILPIT_IMAGE)
  execFileSync('docker', args, { stdio: 'pipe', timeout: 120_000 })

  const smtpPort = hostPort(name, 1025)
  const apiUrl = `http://127.0.0.1:${hostPort(name, 8025)}`
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const r = await fetch(`${apiUrl}/api/v1/info`)
      if (r.ok) break
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
      throw new Error(`Mailpit ${kind} did not start`)
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const r = await fetch(`${apiUrl}${path}`, init)
    if (!r.ok) throw new Error(`Mailpit ${path}: ${r.status} ${await r.text()}`)
    const type = r.headers.get('content-type') ?? ''
    return (type.includes('json') ? await r.json() : await r.text()) as T
  }
  const messages = async () => (await api<{ messages: MailpitSummary[] }>('/api/v1/messages?limit=500')).messages
  return {
    smtpPort,
    apiUrl,
    messages,
    message: (id) => api<MailpitMessage>(`/api/v1/message/${id}`),
    raw: (id) => api<string>(`/api/v1/message/${id}/raw`),
    headers: (id) => api<Record<string, string[]>>(`/api/v1/message/${id}/headers`),
    async waitFor(n, timeoutMs = 10_000) {
      const end = Date.now() + timeoutMs
      for (;;) {
        const list = await messages()
        if (list.length >= n || Date.now() > end) return list
        await new Promise((r) => setTimeout(r, 100))
      }
    },
    async clear() {
      await api('/api/v1/messages', { method: 'DELETE' })
    },
    async chaos(triggers) {
      await api('/api/v1/chaos', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(triggers) })
    },
    stop() {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 30_000 })
      } catch {
        // already gone
      }
    },
  }
}

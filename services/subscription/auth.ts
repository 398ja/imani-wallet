/**
 * Signing in to the subscription site: a NAP session, merchant role only (#411).
 *
 * The site never holds a key. Its page gets a short-lived signing grant from the WALLET's signer
 * page (NAP extension 0002, `connectCrossOrigin`), and uses it once to complete a NAP login here.
 * From then on the browser carries an HttpOnly session cookie and nothing is signed per request.
 *
 * Routes (under the mount path):
 *   POST /v1/auth/init       NAP §10.1: a challenge for an npub
 *   POST /v1/auth/complete   NAP §10.2: the NIP-98 proof; sets the session cookie
 *   GET  /v1/auth/session    the session view, or 401
 *   POST /v1/auth/logout     revokes the session and clears the cookie
 *
 * **Merchant only (owner, 2026-10-28).** The ACL is the stall's own signed public record: a key
 * with a live `imani:merchant` record gets role `merchant`, anything else is refused AT LOGIN, so
 * a customer never holds a session here at all. The role is re-read on every request (RFC §15
 * rule 1), so a stall that retires its record loses access within a minute (the reader's cache),
 * not when the session ends.
 */
import { nip19 } from 'nostr-tools'
import {
  InMemoryChallengeStore,
  InMemorySessionStore,
  issueChallenge,
  resolveEffectiveAcl,
  toPublicAuthFailure,
  toPublicAuthSuccess,
  toPublicSessionView,
  verifyCompletion,
  type NapServerOptions,
} from '@imani/nap-server'
import type { AclDecision, SessionRecord } from '@imani/nap-core'

import { ROLE_MERCHANT, type MerchantReader } from './merchantRole.ts'

export const SESSION_COOKIE = 'imani_subscription_session'
/** A session long enough to choose a plan and come back from Stripe, short enough to lapse. */
export const SESSION_TTL_SECONDS = 30 * 60

export interface AuthRequest {
  method: string
  /** Path relative to the mount, e.g. `/v1/auth/init`. */
  path: string
  headers: Record<string, string | undefined>
  body: string
}

export interface AuthResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export interface Principal {
  pubkey: string
  roles: string[]
}

export interface AuthDeps {
  /** Public URL of a path on this site (origin + mount path + path), the NIP-98 audience. */
  site: (path: string) => string
  merchantStanding: MerchantReader
  /** Whether the session cookie gets `Secure`. Off only for plain-http local runs. */
  secureCookie: boolean
  /** Cookie `Path`: the mount path, so the cookie never reaches the wallet's own routes. */
  cookiePath: string
  /** For tests: the server's clock and response padding. */
  serverOptions?: Partial<NapServerOptions>
}

export class SubscriptionAuth {
  private readonly options: NapServerOptions
  private readonly deps: AuthDeps

  constructor(deps: AuthDeps) {
    this.deps = deps
    const sessionStore = new InMemorySessionStore()
    this.options = {
      challengeStore: new InMemoryChallengeStore(),
      sessionStore,
      aclResolver: {
        resolve: async (_npub: string, pubkey: string): Promise<AclDecision> => {
          const standing = await deps.merchantStanding(pubkey)
          if (standing === 'merchant') return { allowed: true, roles: [ROLE_MERCHANT], permissions: [] }
          // `customer` is a fact about this key: end any session it holds. `unknown` (the gateway
          // could not be asked) refuses this one request and leaves sessions alone.
          return { allowed: false, roles: [], permissions: [], ...(standing === 'customer' ? { revoke_sessions: true } : {}) }
        },
      },
      sessionTtlSeconds: SESSION_TTL_SECONDS,
      ...deps.serverOptions,
    }
  }

  /** Handles `/v1/auth/*`. Returns null for any other path. */
  async handle(req: AuthRequest): Promise<AuthResponse | null> {
    const route = `${req.method} ${req.path.split('?')[0]}`
    switch (route) {
      case 'POST /v1/auth/init':
        return this.init(req)
      case 'POST /v1/auth/complete':
        return this.complete(req)
      case 'GET /v1/auth/session':
        return this.sessionView(req)
      case 'POST /v1/auth/logout':
        return this.logout(req)
      default:
        return null
    }
  }

  /**
   * The merchant behind this request's session cookie, or the response that refuses it. Every
   * API route except the public ones goes through here.
   */
  async require(req: AuthRequest): Promise<Principal | AuthResponse> {
    const session = await this.sessionFrom(req)
    if (!session) return { status: 401, body: { error: 'Open this page from your Imani wallet to sign in.' } }
    const acl = await resolveEffectiveAcl(session, { aclResolver: this.options.aclResolver, sessionStore: this.options.sessionStore })
    if (!acl || !acl.roles.includes(ROLE_MERCHANT)) {
      return { status: 403, body: { error: 'Plans are for stalls. This account does not have a stall.' } }
    }
    return { pubkey: session.principal_pubkey, roles: acl.roles }
  }

  private async init(req: AuthRequest): Promise<AuthResponse> {
    let npub: unknown
    try {
      npub = (JSON.parse(req.body || '{}') as { npub?: unknown }).npub
    } catch {
      return toPublicAuthFailure()
    }
    if (typeof npub !== 'string') return toPublicAuthFailure()
    const result = await issueChallenge(
      { npub, authUrl: this.deps.site('/v1/auth/complete'), clientIp: clientIp(req) },
      this.options,
    )
    return result.ok ? { status: 200, body: result.value } : toPublicAuthFailure()
  }

  private async complete(req: AuthRequest): Promise<AuthResponse> {
    const outcome = await verifyCompletion(
      {
        authorization: req.headers.authorization,
        method: 'POST',
        url: this.deps.site('/v1/auth/complete'),
        rawBody: new TextEncoder().encode(req.body),
        clientIp: clientIp(req),
      },
      this.options,
    )
    if ('malformed' in outcome) return outcome.publicResponse
    if (!outcome.ok) {
      // A completion refused by the ACL is the customer case. Say so plainly: it is the one
      // refusal the person can act on (open their stall's wallet instead), and the npub was the
      // caller's own, so nothing about anyone else is revealed.
      if (outcome.code === 'NAP_COMPLETE_ACL_DENIED') {
        return { status: 403, body: { error: 'Plans are for stalls. This account does not have a stall.' } }
      }
      return toPublicAuthFailure()
    }
    const body = toPublicAuthSuccess(outcome.session)
    // Cookie mode: the access token goes in an HttpOnly cookie and never into the body.
    const { access_token: _token, token_type: _type, refresh_token: _refresh, status: _status, ...view } = body as typeof body & {
      refresh_token?: string
    }
    return {
      status: 200,
      body: { status: 'ok', ...view },
      headers: { 'Set-Cookie': this.cookie(outcome.session.access_token, SESSION_TTL_SECONDS) },
    }
  }

  private async sessionView(req: AuthRequest): Promise<AuthResponse> {
    const session = await this.sessionFrom(req)
    if (!session) return toPublicAuthFailure()
    const acl = await resolveEffectiveAcl(session, { aclResolver: this.options.aclResolver, sessionStore: this.options.sessionStore })
    if (!acl) return toPublicAuthFailure()
    return { status: 200, body: { ...toPublicSessionView(session), roles: acl.roles, permissions: acl.permissions } }
  }

  private async logout(req: AuthRequest): Promise<AuthResponse> {
    const session = await this.sessionFrom(req)
    if (session) await this.options.sessionStore.revokeBySessionId(session.session_id, now())
    return { status: 200, body: { status: 'ok' }, headers: { 'Set-Cookie': this.cookie('', 0) } }
  }

  private async sessionFrom(req: AuthRequest): Promise<SessionRecord | null> {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE)
    if (!token) return null
    const session = await this.options.sessionStore.getByAccessToken(token)
    if (!session || session.revoked_at || session.expires_at <= now()) return null
    return session
  }

  private cookie(value: string, maxAge: number): string {
    return [
      `${SESSION_COOKIE}=${value}`,
      `Path=${this.deps.cookiePath || '/'}`,
      'HttpOnly',
      'SameSite=Lax',
      ...(this.deps.secureCookie ? ['Secure'] : []),
      `Max-Age=${maxAge}`,
    ].join('; ')
  }
}

const now = () => Math.floor(Date.now() / 1000)

function clientIp(req: AuthRequest): string | undefined {
  // Set by the edge only (X-Real-IP); never a client-supplied X-Forwarded-For chain.
  return req.headers['x-real-ip']?.trim() || undefined
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=') || null
  }
  return null
}

/** For tests and the admin screen: hex pubkey of an npub, or null. */
export function pubkeyOfNpub(npub: string): string | null {
  try {
    const d = nip19.decode(npub)
    return d.type === 'npub' ? (d.data as string) : null
  } catch {
    return null
  }
}

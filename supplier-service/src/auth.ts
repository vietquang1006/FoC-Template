import { createHash } from 'node:crypto'
import { TtlCache } from './cache.ts'
import { HttpError } from './errors.ts'

// What the caller is trying to do. The User Service maps each operation to the
// roles that may perform it, so the role rules live there and not here.
export type Operation =
  | 'supplier.read'
  | 'supplier.create'
  | 'supplier.update'
  | 'supplier.deactivate'

export type AuthDecision =
  | { kind: 'authorized'; accountId: string }
  | { kind: 'unauthenticated' }
  | { kind: 'denied' }

export interface Authorizer {
  authorize(authorization: string | undefined, operation: Operation): Promise<AuthDecision>
}

// Loose enough that a slow User Service is noticed, tight enough that requests
// do not pile up behind it.
const TIMEOUT_MS = 1000

// Asks the User Service whether the session may perform the operation:
//   POST {USER_SERVICE_URL}/authorize
//   Authorization: <the caller's own header, passed on unchanged>
//   {"operation": "supplier.create"}
//   200 {"accountId": "..."}  authorized
//   401                       no valid session
//   403                       valid session, not permitted
export class UserServiceAuthorizer implements Authorizer {
  private endpoint: URL

  constructor(baseUrl: string) {
    this.endpoint = new URL('/authorize', baseUrl)
  }

  async authorize(authorization: string | undefined, operation: Operation): Promise<AuthDecision> {
    if (!authorization) return { kind: 'unauthenticated' }

    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ operation }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw unavailable()
    }

    if (response.status === 401) return { kind: 'unauthenticated' }
    if (response.status === 403) return { kind: 'denied' }
    if (response.status === 200) {
      const body: unknown = await response.json().catch(() => null)
      const accountId = (body as { accountId?: unknown } | null)?.accountId
      if (typeof accountId === 'string' && accountId !== '') return { kind: 'authorized', accountId }
    }
    throw unavailable()
  }
}

// Remembers that a session was authorized to read, for a few seconds, so that a
// busy read does not wait on the User Service. Only the approval of a read is
// remembered. A refusal, an error, and every operation that changes a supplier
// go to the User Service each time. The cost is that an account suspended in
// the last few seconds can still read until the answer expires.
export class CachingAuthorizer implements Authorizer {
  private inner: Authorizer
  private cache: TtlCache<AuthDecision>

  constructor(inner: Authorizer, ttlMs: number, clock?: () => number) {
    this.inner = inner
    this.cache = new TtlCache(ttlMs, 10_000, clock)
  }

  authorize(authorization: string | undefined, operation: Operation): Promise<AuthDecision> {
    if (!authorization || operation !== 'supplier.read') {
      return this.inner.authorize(authorization, operation)
    }
    // Hashed so that the session credential itself is not kept as a key.
    const key = createHash('sha256').update(authorization).digest('base64')
    return this.cache.get(
      key,
      () => this.inner.authorize(authorization, operation),
      (decision) => decision.kind === 'authorized',
    )
  }
}

// Fail closed: when the User Service cannot answer, nobody is let in.
function unavailable() {
  return new HttpError(503, 'AUTH_UNAVAILABLE', 'Cannot verify the session right now, try again shortly')
}

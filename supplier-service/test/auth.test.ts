import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { createServer } from 'node:http'
import { UserServiceAuthorizer } from '../src/auth.ts'
import { HttpError } from '../src/errors.ts'
import { createFakeUserService } from '../dev/fake-user-service.ts'

const bearer = (token: string) => `Bearer ${token}`

describe('UserServiceAuthorizer against the fake User Service', () => {
  const server = createFakeUserService()
  let authorizer: UserServiceAuthorizer

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, resolve))
    authorizer = new UserServiceAuthorizer(`http://localhost:${(server.address() as AddressInfo).port}`)
  })
  after(() => server.close())

  it('treats a request without a session as unauthenticated', async () => {
    assert.deepEqual(await authorizer.authorize(undefined, 'supplier.read'), { kind: 'unauthenticated' })
  })

  it('treats an unknown session as unauthenticated', async () => {
    assert.deepEqual(await authorizer.authorize(bearer('nobody'), 'supplier.read'), {
      kind: 'unauthenticated',
    })
  })

  it('lets a member read and returns who they are', async () => {
    assert.deepEqual(await authorizer.authorize(bearer('member-token'), 'supplier.read'), {
      kind: 'authorized',
      accountId: 'member-account-1',
    })
  })

  it('denies a member every operation that changes a supplier', async () => {
    for (const operation of ['supplier.create', 'supplier.update', 'supplier.deactivate'] as const) {
      assert.deepEqual(await authorizer.authorize(bearer('member-token'), operation), {
        kind: 'denied',
      })
    }
  })

  it('lets an administrator do all of them', async () => {
    for (const operation of [
      'supplier.read',
      'supplier.create',
      'supplier.update',
      'supplier.deactivate',
    ] as const) {
      assert.equal((await authorizer.authorize(bearer('admin-token'), operation)).kind, 'authorized')
    }
  })

  it('denies an account that is not active, even for reads', async () => {
    assert.deepEqual(await authorizer.authorize(bearer('suspended-token'), 'supplier.read'), {
      kind: 'denied',
    })
  })
})

describe('the fake User Service login', () => {
  const lines: string[] = []
  const server = createFakeUserService((line) => lines.push(line))
  let base: string
  let authorizer: UserServiceAuthorizer

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, resolve))
    base = `http://localhost:${(server.address() as AddressInfo).port}`
    authorizer = new UserServiceAuthorizer(base)
  })
  after(() => server.close())

  const login = async (username: string, password: string) => {
    const response = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  it('gives a student a session that may read but not change suppliers', async () => {
    const { status, body } = await login('student', 'student-pass')
    assert.equal(status, 200)
    assert.deepEqual(body.roles, ['member'])
    const token = String(body.token)
    assert.match(token, /^session-[0-9a-f]{18}$/)
    assert.equal((await authorizer.authorize(bearer(token), 'supplier.read')).kind, 'authorized')
    assert.equal((await authorizer.authorize(bearer(token), 'supplier.create')).kind, 'denied')
  })

  it('gives an administrator a session that may do everything', async () => {
    const { status, body } = await login('admin', 'admin-pass')
    assert.equal(status, 200)
    assert.deepEqual(body.roles, ['member', 'administrator'])
    assert.deepEqual(await authorizer.authorize(bearer(String(body.token)), 'supplier.deactivate'), {
      kind: 'authorized',
      accountId: 'admin-account-1',
    })
  })

  it('issues a different session on every login', async () => {
    const first = await login('student', 'student-pass')
    const second = await login('student', 'student-pass')
    assert.notEqual(first.body.token, second.body.token)
  })

  it('gives an unknown user and a wrong password the identical refusal', async () => {
    const wrong = await login('student', 'nope')
    const unknown = await login('nobody', 'student-pass')
    assert.equal(wrong.status, 401)
    assert.deepEqual(wrong, unknown)
  })

  it('gives a suspended account no session at all', async () => {
    const { status, body } = await login('suspended', 'suspended-pass')
    assert.equal(status, 403)
    assert.equal('token' in body, false)
  })

  it('does not know a name that only exists on every object', async () => {
    assert.equal((await login('constructor', 'x')).status, 401)
    assert.equal((await authorizer.authorize(bearer('constructor'), 'supplier.read')).kind, 'unauthenticated')
  })

  it('logs who logged in, and never the password', async () => {
    await login('admin', 'admin-pass')
    assert.ok(lines.some((line) => line === 'login admin -> 200'))
    assert.ok(lines.every((line) => !line.includes('admin-pass') && !line.includes('student-pass')))
  })

  it('names a logged-in session in the log, and shortens its token', async () => {
    const { body } = await login('admin', 'admin-pass')
    await authorizer.authorize(bearer(String(body.token)), 'supplier.create')
    const line = lines.filter((l) => l.startsWith('authorize supplier.create')).pop()!
    assert.match(line, /^authorize supplier\.create for admin \([0-9a-f]{6}\) -> 200$/)
    assert.ok(!line.includes(String(body.token)))
  })
})

describe('UserServiceAuthorizer when the User Service misbehaves', () => {
  const expectUnavailable = async (authorizer: UserServiceAuthorizer) => {
    await assert.rejects(authorizer.authorize(bearer('member-token'), 'supplier.read'), (error) => {
      assert.ok(error instanceof HttpError)
      assert.equal(error.status, 503)
      assert.equal(error.code, 'AUTH_UNAVAILABLE')
      return true
    })
  }

  it('fails closed when nothing is listening', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise((resolve) => closed.close(resolve))
    await expectUnavailable(new UserServiceAuthorizer(`http://localhost:${port}`))
  })

  it('fails closed on an error response', async () => {
    const broken = createServer((_request, response) => response.writeHead(500).end())
    await new Promise<void>((resolve) => broken.listen(0, resolve))
    try {
      await expectUnavailable(
        new UserServiceAuthorizer(`http://localhost:${(broken.address() as AddressInfo).port}`),
      )
    } finally {
      broken.close()
    }
  })

  it('fails closed on an approval it cannot read', async () => {
    const vague = createServer((_request, response) => response.writeHead(200).end('{}'))
    await new Promise<void>((resolve) => vague.listen(0, resolve))
    try {
      await expectUnavailable(
        new UserServiceAuthorizer(`http://localhost:${(vague.address() as AddressInfo).port}`),
      )
    } finally {
      vague.close()
    }
  })
})

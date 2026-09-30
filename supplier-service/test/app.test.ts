import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { createFakeUserService } from '../dev/fake-user-service.ts'
import { buildApp } from '../src/app.ts'
import { UserServiceAuthorizer, type Authorizer } from '../src/auth.ts'
import type { Pool } from '../src/db.ts'
import { HttpError } from '../src/errors.ts'

// The database stub records every query and refuses to answer. Everything in
// this file has to be settled before the database is needed, so it must never
// be called.
const queries: string[] = []
const refusingDb = {
  query: async (text: string) => {
    queries.push(text)
    throw new Error('the database must not be reached')
  },
} as unknown as Pool

const ID = '00000000-0000-4000-8000-000000000000'
const VALID_SUPPLIER = {
  name: 'Test Cafe',
  type: 'Food',
  zone: 'Central',
  building: 'Central Library',
  address: 'Central Library, Level 1',
  hours: [{ day: 'monday', opens: '09:00', closes: '18:00' }],
}

describe('requests that are settled before the database', () => {
  const userService = createFakeUserService()
  let app: FastifyInstance

  before(async () => {
    await new Promise<void>((resolve) => userService.listen(0, resolve))
    const port = (userService.address() as AddressInfo).port
    app = buildApp({
      db: refusingDb,
      authorizer: new UserServiceAuthorizer(`http://localhost:${port}`),
      timeZone: 'Asia/Singapore',
    })
    await app.ready()
  })
  after(async () => {
    await app.close()
    userService.close()
    assert.deepEqual(queries, [], 'no request in this file may have reached the database')
  })

  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token?: string, payload?: object | string) => {
    const response = await app.inject({
      method,
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(typeof payload === 'string' ? { 'content-type': 'application/json' } : {}),
      },
      payload,
    })
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null }
  }

  const ROUTES = [
    ['GET', '/suppliers'],
    ['GET', `/suppliers/${ID}`],
    ['GET', `/suppliers/${ID}/availability`],
    ['POST', '/suppliers'],
    ['PATCH', `/suppliers/${ID}`],
    ['DELETE', `/suppliers/${ID}`],
  ] as const

  it('answers 401 on every route without a session', async () => {
    for (const [method, url] of ROUTES) {
      const response = await call(method, url, undefined, method === 'POST' || method === 'PATCH' ? VALID_SUPPLIER : undefined)
      assert.equal(response.status, 401, `${method} ${url}`)
      assert.equal(response.body.error.code, 'UNAUTHENTICATED')
    }
  })

  it('answers 401 on every route with a session nobody issued', async () => {
    for (const [method, url] of ROUTES) {
      assert.equal((await call(method, url, 'forged-token')).status, 401, `${method} ${url}`)
    }
  })

  it('answers 403 on every route to a Suspended account', async () => {
    for (const [method, url] of ROUTES) {
      assert.equal((await call(method, url, 'suspended-token')).status, 403, `${method} ${url}`)
    }
  })

  it('answers 403 to a member on every route that changes a supplier', async () => {
    for (const [method, url] of ROUTES.slice(3)) {
      const response = await call(method, url, 'member-token', method === 'DELETE' ? undefined : VALID_SUPPLIER)
      assert.equal(response.status, 403, `${method} ${url}`)
      assert.equal(response.body.error.code, 'FORBIDDEN')
    }
  })

  it('answers a member the same way whatever the id, so it says nothing about what exists', async () => {
    const answers = new Set<string>()
    for (const id of [ID, 'not-a-uuid', '1'.repeat(40)]) {
      const response = await call('PATCH', `/suppliers/${id}`, 'member-token', { name: 'x' })
      answers.add(JSON.stringify(response))
    }
    assert.equal(answers.size, 1)
  })

  it('checks the session before it parses the body', async () => {
    assert.equal((await call('POST', '/suppliers', undefined, '{oops')).status, 401)
    assert.equal((await call('POST', '/suppliers', 'member-token', '{oops')).status, 403)
    assert.equal((await call('POST', '/suppliers', 'admin-token', '{oops')).status, 400)
  })

  it('names every invalid field in a create', async () => {
    const response = await call('POST', '/suppliers', 'admin-token', { category: 'Food' })
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'VALIDATION_FAILED')
    assert.deepEqual(
      response.body.error.fields.map((f: { field: string }) => f.field).sort(),
      ['address', 'building', 'category', 'hours', 'name', 'type', 'zone'],
    )
  })

  it('refuses an update that names the identifier or creation time', async () => {
    const response = await call('PATCH', `/suppliers/${ID}`, 'admin-token', { id: ID, createdAt: 'x' })
    assert.equal(response.status, 400)
    assert.deepEqual(response.body.error.fields, [
      { field: 'id', message: 'cannot be set' },
      { field: 'createdAt', message: 'cannot be set' },
    ])
  })

  it('refuses an empty update', async () => {
    assert.equal((await call('PATCH', `/suppliers/${ID}`, 'admin-token', {})).status, 400)
  })

  it('names every invalid query parameter', async () => {
    const response = await call('GET', '/suppliers?pageSize=99&status=gone&type=a&type=b', 'member-token')
    assert.equal(response.status, 400)
    assert.deepEqual(
      response.body.error.fields.map((f: { field: string }) => f.field).sort(),
      ['pageSize', 'status', 'type'],
    )
  })

  it('refuses an availability time without an offset', async () => {
    const response = await call('GET', `/suppliers/${ID}/availability?at=2026-10-01T12:00:00`, 'member-token')
    assert.equal(response.status, 400)
    assert.equal(response.body.error.fields[0].field, 'at')
  })

  it('answers 404 to an id that cannot be a supplier, without asking the database', async () => {
    assert.equal((await call('GET', '/suppliers/not-a-uuid', 'member-token')).status, 404)
    assert.equal((await call('DELETE', '/suppliers/not-a-uuid', 'admin-token')).status, 404)
    assert.equal((await call('PATCH', '/suppliers/not-a-uuid', 'admin-token', { name: 'x' })).status, 404)
  })

  it('answers 404 in the same JSON shape for a route that does not exist', async () => {
    const response = await call('GET', '/nowhere', 'member-token')
    assert.equal(response.status, 404)
    assert.equal(response.body.error.code, 'NOT_FOUND')
  })

  it('answers 503 for health when the database is down', async () => {
    const response = await call('GET', '/health')
    assert.equal(response.status, 503)
    queries.length = 0
  })
})

describe('when the User Service cannot be asked', () => {
  it('answers 503 on every route and never reaches the database', async () => {
    const down: Authorizer = {
      authorize: async () => {
        throw new HttpError(503, 'AUTH_UNAVAILABLE', 'down')
      },
    }
    const app = buildApp({ db: refusingDb, authorizer: down, timeZone: 'Asia/Singapore' })
    for (const [method, url] of [
      ['GET', '/suppliers'],
      ['POST', '/suppliers'],
      ['DELETE', `/suppliers/${ID}`],
    ] as const) {
      const response = await app.inject({ method, url, headers: { authorization: 'Bearer admin-token' } })
      assert.equal(response.statusCode, 503, `${method} ${url}`)
      assert.equal(JSON.parse(response.body).error.code, 'AUTH_UNAVAILABLE')
    }
    await app.close()
  })
})

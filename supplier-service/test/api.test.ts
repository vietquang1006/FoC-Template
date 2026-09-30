import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { createFakeUserService } from '../dev/fake-user-service.ts'
import { buildApp } from '../src/app.ts'
import { UserServiceAuthorizer, type Authorizer } from '../src/auth.ts'
import { createPool, migrate, type Pool } from '../src/db.ts'
import { HttpError } from '../src/errors.ts'
import { seedIfEmpty } from '../src/seed/seed.ts'

// These tests empty the suppliers table, so they only run against a database
// whose name ends in _test.
const databaseUrl = process.env.SUPPLIER_TEST_DATABASE_URL
const skip = databaseUrl ? false : 'set SUPPLIER_TEST_DATABASE_URL to run the API tests'
if (databaseUrl && !new URL(databaseUrl).pathname.endsWith('_test')) {
  throw new Error('SUPPLIER_TEST_DATABASE_URL must point at a database whose name ends in _test')
}

const SEED_FILE = path.join(import.meta.dirname, '../../data/csv/supplier-seed-data.csv')
const MIGRATIONS = path.join(import.meta.dirname, '../src/migrations')
const TIME_ZONE = 'Asia/Singapore'
// Thursday 12:00 in Singapore.
const NOW = new Date('2026-10-01T04:00:00Z')

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const DAILY = DAYS.map((day) => ({ day, opens: '09:00', closes: '18:00' }))

const cafe = (overrides: object = {}) => ({
  name: 'Test Cafe',
  type: 'Food',
  zone: 'Central',
  building: 'Central Library',
  address: 'Central Library, Level 1',
  latitude: 1.2964,
  longitude: 103.773,
  contact: { phone: '6516 1234', email: 'cafe@example.com' },
  hours: DAILY,
  ...overrides,
})

const silent = { info() {}, warn() {} }

describe('supplier API', { skip }, () => {
  let pool: Pool
  let app: FastifyInstance
  let authorizer: Authorizer
  let userService: ReturnType<typeof createFakeUserService>

  before(async () => {
    pool = createPool(databaseUrl!, () => {})
    await migrate(pool, MIGRATIONS)
    userService = createFakeUserService()
    await new Promise<void>((resolve) => userService.listen(0, resolve))
    const port = (userService.address() as AddressInfo).port
    authorizer = new UserServiceAuthorizer(`http://localhost:${port}`)
    app = buildApp({ db: pool, authorizer, timeZone: TIME_ZONE, now: () => NOW })
    await app.ready()
  })

  after(async () => {
    await app.close()
    userService.close()
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE suppliers CASCADE')
  })

  async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token?: string, payload?: object) {
    const response = await app.inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload,
    })
    return {
      status: response.statusCode,
      headers: response.headers,
      body: response.body ? JSON.parse(response.body) : null,
    }
  }

  const create = async (overrides: object = {}) => {
    const response = await call('POST', '/suppliers', 'admin-token', cafe(overrides))
    assert.equal(response.status, 201, JSON.stringify(response.body))
    return response.body
  }

  const snapshot = async () =>
    (await pool.query('SELECT id, updated_at, status FROM suppliers ORDER BY id')).rows

  describe('access control', () => {
    it('answers 401 to every route when there is no session', async () => {
      const { id } = await create()
      for (const [method, url] of [
        ['GET', '/suppliers'],
        ['GET', `/suppliers/${id}`],
        ['GET', `/suppliers/${id}/availability`],
        ['POST', '/suppliers'],
        ['PATCH', `/suppliers/${id}`],
        ['DELETE', `/suppliers/${id}`],
      ] as const) {
        const response = await call(method, url, undefined, method === 'GET' ? undefined : {})
        assert.equal(response.status, 401, `${method} ${url}`)
        assert.equal(response.body.error.code, 'UNAUTHENTICATED')
      }
    })

    it('answers 401 to a session the User Service does not know', async () => {
      assert.equal((await call('GET', '/suppliers', 'forged-token')).status, 401)
    })

    it('answers 403 to an account that is not active, even for reads', async () => {
      const response = await call('GET', '/suppliers', 'suspended-token')
      assert.equal(response.status, 403)
      assert.equal(response.body.error.code, 'FORBIDDEN')
    })

    it('lets a member read but not change suppliers, and changes nothing', async () => {
      const { id } = await create()
      const before = await snapshot()

      assert.equal((await call('GET', '/suppliers', 'member-token')).status, 200)
      assert.equal((await call('GET', `/suppliers/${id}`, 'member-token')).status, 200)
      assert.equal((await call('POST', '/suppliers', 'member-token', cafe())).status, 403)
      assert.equal((await call('PATCH', `/suppliers/${id}`, 'member-token', { name: 'Hacked' })).status, 403)
      assert.equal((await call('DELETE', `/suppliers/${id}`, 'member-token')).status, 403)

      assert.deepEqual(await snapshot(), before)
    })

    it('does not reveal whether a supplier exists to a caller who may not touch it', async () => {
      const { id } = await create()
      const missing = '00000000-0000-4000-8000-000000000000'
      for (const target of [id, missing, 'not-a-uuid']) {
        const patch = await call('PATCH', `/suppliers/${target}`, 'member-token', { name: 'x' })
        const remove = await call('DELETE', `/suppliers/${target}`, 'member-token')
        assert.equal(patch.status, 403)
        assert.equal(remove.status, 403)
      }
    })

    it('answers 503 and changes nothing when the User Service cannot be asked', async () => {
      const down: Authorizer = {
        authorize: async () => {
          throw new HttpError(503, 'AUTH_UNAVAILABLE', 'down')
        },
      }
      const downApp = buildApp({ db: pool, authorizer: down, timeZone: TIME_ZONE, now: () => NOW })
      const response = await downApp.inject({ method: 'POST', url: '/suppliers', payload: cafe() })
      assert.equal(response.statusCode, 503)
      assert.equal((await snapshot()).length, 0)
    })
  })

  describe('create', () => {
    it('stores a supplier and returns it with an id and timestamps assigned by the service', async () => {
      const response = await call('POST', '/suppliers', 'admin-token', cafe())
      assert.equal(response.status, 201)
      assert.match(response.body.id, /^[0-9a-f-]{36}$/)
      assert.equal(response.headers.location, `/suppliers/${response.body.id}`)
      assert.equal(response.body.status, 'Active')
      assert.equal(response.body.createdAt, response.body.updatedAt)
      assert.deepEqual(response.body.contact, { phone: '6516 1234', email: 'cafe@example.com' })
      assert.equal(response.body.hours.length, 7)
      assert.equal('createdBy' in response.body, false)

      const stored = await call('GET', `/suppliers/${response.body.id}`, 'member-token')
      assert.equal(stored.status, 200)
      assert.equal(stored.body.name, 'Test Cafe')
    })

    it('records which administrator created it', async () => {
      const { id } = await create()
      const row = (await pool.query('SELECT created_by, updated_by FROM suppliers WHERE id = $1', [id])).rows[0]
      assert.deepEqual(row, { created_by: 'admin-account-1', updated_by: 'admin-account-1' })
    })

    it('names every invalid field and stores nothing', async () => {
      const response = await call('POST', '/suppliers', 'admin-token', {
        hours: [{ day: 'monday', opens: '25:00', closes: '18:00' }],
      })
      assert.equal(response.status, 400)
      assert.equal(response.body.error.code, 'VALIDATION_FAILED')
      const fields = response.body.error.fields.map((f: { field: string }) => f.field).sort()
      assert.deepEqual(fields, [
        'address',
        'building',
        'hours[0].opens',
        'name',
        'type',
        'zone',
      ])
      assert.equal((await snapshot()).length, 0)
    })

    it('answers 400 to a body that is not JSON', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/suppliers',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        payload: '{oops',
      })
      assert.equal(response.statusCode, 400)
    })
  })

  describe('update', () => {
    it('changes the fields it is given, replaces the hours and sets the last-updated time', async () => {
      const created = await create()
      const response = await call('PATCH', `/suppliers/${created.id}`, 'admin-token', {
        name: 'Renamed Cafe',
        hours: [{ day: 'saturday', opens: '10:00', closes: '14:00' }],
      })
      assert.equal(response.status, 200)
      assert.equal(response.body.name, 'Renamed Cafe')
      assert.equal(response.body.type, 'Food')
      assert.deepEqual(response.body.hours, [{ day: 'saturday', opens: '10:00', closes: '14:00' }])
      assert.equal(response.body.createdAt, created.createdAt)
      assert.ok(response.body.updatedAt >= created.updatedAt)
    })

    it('clears an optional field', async () => {
      const created = await create()
      const response = await call('PATCH', `/suppliers/${created.id}`, 'admin-token', {
        contact: { phone: null },
      })
      assert.deepEqual(response.body.contact, { phone: null, email: 'cafe@example.com' })
    })

    it('refuses to change the identifier or creation time, naming both', async () => {
      const created = await create()
      const response = await call('PATCH', `/suppliers/${created.id}`, 'admin-token', {
        id: '00000000-0000-4000-8000-000000000000',
        createdAt: '2020-01-01T00:00:00Z',
      })
      assert.equal(response.status, 400)
      assert.deepEqual(
        response.body.error.fields.map((f: { field: string }) => f.field),
        ['id', 'createdAt'],
      )
    })

    it('answers 404 for a supplier that does not exist', async () => {
      const missing = '00000000-0000-4000-8000-000000000000'
      assert.equal((await call('PATCH', `/suppliers/${missing}`, 'admin-token', { name: 'x' })).status, 404)
    })

    it('applies two simultaneous updates one after the other', async () => {
      const { id } = await create()
      const [a, b] = await Promise.all([
        call('PATCH', `/suppliers/${id}`, 'admin-token', { name: 'First' }),
        call('PATCH', `/suppliers/${id}`, 'admin-token', { zone: 'Computing' }),
      ])
      assert.equal(a.status, 200)
      assert.equal(b.status, 200)
      const final = (await call('GET', `/suppliers/${id}`, 'member-token')).body
      assert.equal(final.name, 'First')
      assert.equal(final.zone, 'Computing')
    })
  })

  describe('deactivate', () => {
    it('sets the supplier Inactive and keeps the record retrievable', async () => {
      const { id } = await create()
      const response = await call('DELETE', `/suppliers/${id}`, 'admin-token')
      assert.equal(response.status, 200)
      assert.equal(response.body.status, 'Inactive')

      const stored = await call('GET', `/suppliers/${id}`, 'member-token')
      assert.equal(stored.status, 200)
      assert.equal(stored.body.status, 'Inactive')
    })

    it('leaves it out of listings unless asked, so no new errand is offered it', async () => {
      const { id } = await create()
      await call('DELETE', `/suppliers/${id}`, 'admin-token')

      assert.equal((await call('GET', '/suppliers', 'member-token')).body.total, 0)
      assert.equal((await call('GET', '/suppliers?status=Inactive', 'member-token')).body.total, 1)
      assert.equal((await call('GET', '/suppliers?status=all', 'member-token')).body.total, 1)
    })

    it('does nothing the second time', async () => {
      const { id } = await create()
      const first = await call('DELETE', `/suppliers/${id}`, 'admin-token')
      const second = await call('DELETE', `/suppliers/${id}`, 'admin-token')
      assert.equal(second.status, 200)
      assert.equal(second.body.updatedAt, first.body.updatedAt)
    })

    it('can be reversed by setting the status back to Active', async () => {
      const { id } = await create()
      await call('DELETE', `/suppliers/${id}`, 'admin-token')
      const response = await call('PATCH', `/suppliers/${id}`, 'admin-token', { status: 'Active' })
      assert.equal(response.body.status, 'Active')
      assert.equal((await call('GET', '/suppliers', 'member-token')).body.total, 1)
    })

    it('never removes the row', async () => {
      const { id } = await create()
      await call('DELETE', `/suppliers/${id}`, 'admin-token')
      assert.equal((await snapshot()).length, 1)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM supplier_hours WHERE supplier_id = $1', [id])).rows[0].n, 7)
    })

    it('answers 404 for a supplier that does not exist, and for an id that is not a UUID', async () => {
      assert.equal((await call('DELETE', '/suppliers/00000000-0000-4000-8000-000000000000', 'admin-token')).status, 404)
      assert.equal((await call('DELETE', '/suppliers/not-a-uuid', 'admin-token')).status, 404)
    })
  })

  describe('read', () => {
    it('answers 404 for a supplier that does not exist', async () => {
      const response = await call('GET', '/suppliers/00000000-0000-4000-8000-000000000000', 'member-token')
      assert.equal(response.status, 404)
      assert.equal(response.body.error.code, 'NOT_FOUND')
    })

    it('sorts by name regardless of case', async () => {
      await create({ name: 'bravo' })
      await create({ name: 'Alpha' })
      await create({ name: 'charlie' })
      const response = await call('GET', '/suppliers', 'member-token')
      assert.deepEqual(response.body.items.map((s: { name: string }) => s.name), ['Alpha', 'bravo', 'charlie'])
    })

    it('answers 400 to a bad query, naming each parameter', async () => {
      const response = await call('GET', '/suppliers?pageSize=21&status=gone', 'member-token')
      assert.equal(response.status, 400)
      assert.deepEqual(
        response.body.error.fields.map((f: { field: string }) => f.field).sort(),
        ['pageSize', 'status'],
      )
    })
  })

  describe('availability', () => {
    it('says open, and until when, during opening hours', async () => {
      const { id } = await create()
      const response = await call('GET', `/suppliers/${id}`, 'member-token')
      assert.deepEqual(response.body.availability, { open: true, closesAt: '18:00', nextOpensAt: null })
    })

    it('evaluates any moment the Order Service asks about', async () => {
      const { id } = await create()
      const evening = await call('GET', `/suppliers/${id}/availability?at=2026-10-01T19:00:00%2B08:00`, 'member-token')
      assert.equal(evening.status, 200)
      assert.equal(evening.body.open, false)
      assert.equal(evening.body.orderable, false)
      assert.deepEqual(evening.body.nextOpensAt, { day: 'friday', time: '09:00' })

      const morning = await call('GET', `/suppliers/${id}/availability?at=2026-10-02T10:00:00%2B08:00`, 'member-token')
      assert.equal(morning.body.open, true)
      assert.equal(morning.body.orderable, true)
      assert.equal(morning.body.timezone, TIME_ZONE)
    })

    it('uses the current time when none is given', async () => {
      const { id } = await create()
      const response = await call('GET', `/suppliers/${id}/availability`, 'member-token')
      assert.equal(response.body.at, NOW.toISOString())
      assert.equal(response.body.open, true)
    })

    it('does not offer an Inactive supplier for new errands even while it is open', async () => {
      const { id } = await create()
      await call('DELETE', `/suppliers/${id}`, 'admin-token')
      const response = await call('GET', `/suppliers/${id}/availability`, 'member-token')
      assert.equal(response.body.open, true)
      assert.equal(response.body.status, 'Inactive')
      assert.equal(response.body.orderable, false)
    })

    it('refuses a time without an offset', async () => {
      const { id } = await create()
      const response = await call('GET', `/suppliers/${id}/availability?at=2026-10-01T12:00:00`, 'member-token')
      assert.equal(response.status, 400)
    })

    it('answers 404 for a supplier that does not exist', async () => {
      const response = await call('GET', '/suppliers/00000000-0000-4000-8000-000000000000/availability', 'member-token')
      assert.equal(response.status, 404)
    })
  })

  describe('when the database drops its connections', () => {
    it('recovers without a restart', async () => {
      await create()
      assert.equal((await call('GET', '/suppliers', 'member-token')).status, 200)

      // What a database restart does to the connections the pool holds.
      await pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()`,
      )
      await new Promise((resolve) => setTimeout(resolve, 200))

      assert.equal((await call('GET', '/suppliers', 'member-token')).status, 200)
      const health = await app.inject({ method: 'GET', url: '/health' })
      assert.equal(health.statusCode, 200)
    })
  })

  describe('supplier types', () => {
    it('lets an administrator introduce a type nobody has used before', async () => {
      await create({ name: 'Spin Cycle', type: 'Laundry' })
      const found = await call('GET', '/suppliers?type=laundry', 'member-token')
      assert.equal(found.body.total, 1)
      assert.equal(found.body.items[0].type, 'Laundry')
    })

    it('has no separate category any more', async () => {
      const response = await call('POST', '/suppliers', 'admin-token', cafe({ category: 'Food' }))
      assert.equal(response.status, 400)
      assert.deepEqual(response.body.error.fields, [{ field: 'category', message: 'is not a known field' }])
    })
  })

  describe('read cache', () => {
    let cached: FastifyInstance

    before(() => {
      cached = buildApp({
        db: pool,
        authorizer,
        timeZone: TIME_ZONE,
        now: () => NOW,
        readCacheSeconds: 60,
      })
    })
    after(() => cached.close())

    const total = async () =>
      (
        await cached.inject({ method: 'GET', url: '/suppliers', headers: { authorization: 'Bearer member-token' } })
      ).json().total

    it('answers a repeated search from memory', async () => {
      await create()
      assert.equal(await total(), 1)
      await pool.query(
        `INSERT INTO suppliers (name, type, zone, building, address)
         VALUES ('Added behind its back', 'Food', 'Central', 'B', 'A')`,
      )
      assert.equal(await total(), 1, 'still the remembered answer')
      assert.equal((await call('GET', '/suppliers', 'member-token')).body.total, 2, 'the database has it')
    })

    it('shows a change made through the API at once', async () => {
      await create()
      assert.equal(await total(), 1)
      const response = await cached.inject({
        method: 'POST',
        url: '/suppliers',
        headers: { authorization: 'Bearer admin-token' },
        payload: cafe({ name: 'Second Cafe' }),
      })
      assert.equal(response.statusCode, 201)
      assert.equal(await total(), 2)

      const { id } = response.json()
      await cached.inject({
        method: 'DELETE',
        url: `/suppliers/${id}`,
        headers: { authorization: 'Bearer admin-token' },
      })
      assert.equal(await total(), 1, 'a deactivated supplier disappears from the listing at once')
    })

    it('never answers a caller who has no right to the memory', async () => {
      await create()
      await total()
      const anonymous = await cached.inject({ method: 'GET', url: '/suppliers' })
      assert.equal(anonymous.statusCode, 401)
    })

    it('never serves the availability of a supplier from memory', async () => {
      const { id } = await create()
      const ask = () =>
        cached.inject({
          method: 'GET',
          url: `/suppliers/${id}/availability`,
          headers: { authorization: 'Bearer member-token' },
        })
      assert.equal((await ask()).json().orderable, true)
      await pool.query(`UPDATE suppliers SET status = 'Inactive' WHERE id = $1`, [id])
      assert.equal((await ask()).json().orderable, false)
    })
  })

  describe('with the seed data', () => {
    beforeEach(async () => {
      assert.equal(await seedIfEmpty(pool, SEED_FILE, silent), 21)
    })

    const search = async (query: string) => {
      const response = await call('GET', `/suppliers${query}`, 'member-token')
      assert.equal(response.status, 200, JSON.stringify(response.body))
      return response.body
    }
    const names = (body: { items: { name: string }[] }) => body.items.map((s) => s.name).sort()

    it('seeds once and leaves later changes alone', async () => {
      assert.equal(await seedIfEmpty(pool, SEED_FILE, silent), 0)
      const { items } = await search('?q=Anna')
      await call('DELETE', `/suppliers/${items[0].id}`, 'admin-token')
      assert.equal(await seedIfEmpty(pool, SEED_FILE, silent), 0)
      assert.equal((await search('?status=Inactive')).total, 1)
      assert.equal((await search('')).total, 20)
    })

    it('seeds once when several instances start together', async () => {
      await pool.query('TRUNCATE suppliers CASCADE')
      const results = await Promise.all([1, 2, 3, 4].map(() => seedIfEmpty(pool, SEED_FILE, silent)))
      assert.deepEqual(results.sort((a, b) => b - a), [21, 0, 0, 0])
      assert.equal((await search('')).total, 21)
    })

    it('does not run the migrations twice', async () => {
      assert.deepEqual(await migrate(pool, MIGRATIONS), [])
    })

    it('searches by keyword across name and type', async () => {
      assert.deepEqual(names(await search('?q=coffee')), [
        'Cafe+ Robot Cafe',
        'Good Day Cafe',
        'The Coffee Roaster',
        'TOMORO COFFEE',
        'he by He Brews',
      ].sort())
    })

    it('needs every word to match, in any order and any case', async () => {
      assert.equal((await search('?q=prince%20george')).total, 3)
      assert.equal((await search('?q=GEORGE%20PRINCE')).total, 3)
      assert.equal((await search('?q=george%20printer')).total, 0)
    })

    it('treats % and _ as plain characters', async () => {
      assert.equal((await search('?q=%25')).total, 0)
      assert.equal((await search('?q=_')).total, 0)
    })

    it('filters by type, zone and building, ignoring case', async () => {
      assert.deepEqual(names(await search('?type=Printing')), ['Goh Bros E-Print Pte Ltd', 'Printer @ Com 2'])
      assert.equal((await search('?type=food/coffee')).total, 5)
      assert.equal((await search('?type=Food')).total, 11, 'Food does not include Food/Coffee')
      assert.equal((await search('?type=Shopping')).total, 3)
      assert.equal((await search('?zone=central')).total, 6)
      assert.equal((await search('?building=com2')).total, 2)
    })

    it('combines filters and keywords', async () => {
      assert.equal((await search('?zone=Central&type=Food')).total, 2)
      assert.equal((await search('?zone=Central&q=coffee')).total, 2)
    })

    it('pages in 20s with the total count', async () => {
      const first = await search('')
      assert.equal(first.items.length, 20)
      assert.equal(first.total, 21)
      assert.equal(first.totalPages, 2)

      const second = await search('?page=2')
      assert.equal(second.items.length, 1)
      const ids = new Set([...first.items, ...second.items].map((s: { id: string }) => s.id))
      assert.equal(ids.size, 21)

      assert.equal((await search('?page=3')).items.length, 0)
      assert.equal((await search('?pageSize=5&page=5')).items.length, 1)
    })

    it('exposes whether each supplier is open now', async () => {
      const [coop] = (await search('?q=Co-op')).items
      assert.deepEqual(coop.availability, { open: true, closesAt: '16:00', nextOpensAt: null })
      const [octobox] = (await search('?q=Octobox')).items
      assert.deepEqual(octobox.availability, { open: true, closesAt: null, nextOpensAt: null })
    })

    it('knows a supplier that closes after midnight is still open at 01:00', async () => {
      const [supersnacks] = (await search('?q=Supersnacks')).items
      const response = await call(
        'GET',
        `/suppliers/${supersnacks.id}/availability?at=2026-10-02T01:00:00%2B08:00`,
        'member-token',
      )
      assert.equal(response.body.open, true)
      assert.equal(response.body.closesAt, '02:00')
    })
  })
})

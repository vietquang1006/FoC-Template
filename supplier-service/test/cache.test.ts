import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CachingAuthorizer, type AuthDecision, type Authorizer, type Operation } from '../src/auth.ts'
import { TtlCache } from '../src/cache.ts'
import { HttpError } from '../src/errors.ts'

describe('TtlCache', () => {
  it('answers from memory until the time is up', async () => {
    let now = 0
    let loads = 0
    const cache = new TtlCache<number>(1000, 10, () => now)
    const load = async () => ++loads

    assert.equal(await cache.get('a', load), 1)
    now = 999
    assert.equal(await cache.get('a', load), 1)
    now = 1000
    assert.equal(await cache.get('a', load), 2)
  })

  it('keeps different keys apart', async () => {
    const cache = new TtlCache<string>(1000)
    assert.equal(await cache.get('a', async () => 'A'), 'A')
    assert.equal(await cache.get('b', async () => 'B'), 'B')
    assert.equal(await cache.get('a', async () => 'not asked'), 'A')
  })

  it('shares one load between callers that ask while it is running', async () => {
    let loads = 0
    const cache = new TtlCache<number>(1000)
    const answers = await Promise.all(
      Array.from({ length: 50 }, () =>
        cache.get('a', async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return ++loads
        }),
      ),
    )
    assert.equal(loads, 1)
    assert.ok(answers.every((a) => a === 1))
  })

  it('does not remember anything when the time is zero', async () => {
    let loads = 0
    const cache = new TtlCache<number>(0)
    await cache.get('a', async () => ++loads)
    await cache.get('a', async () => ++loads)
    assert.equal(loads, 2)
  })

  it('forgets a failure at once', async () => {
    const cache = new TtlCache<number>(1000)
    await assert.rejects(cache.get('a', async () => Promise.reject(new Error('boom'))))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(await cache.get('a', async () => 7), 7)
  })

  it('forgets an answer that keep() refuses', async () => {
    let loads = 0
    const cache = new TtlCache<number>(1000)
    const load = async () => ++loads
    await cache.get('a', load, (v) => v > 1)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(await cache.get('a', load, (v) => v > 1), 2)
    assert.equal(await cache.get('a', load, (v) => v > 1), 2)
  })

  it('forgets everything when cleared', async () => {
    let loads = 0
    const cache = new TtlCache<number>(1000)
    await cache.get('a', async () => ++loads)
    cache.clear()
    assert.equal(await cache.get('a', async () => ++loads), 2)
  })

  it('drops the oldest entry when it is full', async () => {
    let loads = 0
    const cache = new TtlCache<number>(1000, 2)
    await cache.get('a', async () => ++loads)
    await cache.get('b', async () => ++loads)
    await cache.get('c', async () => ++loads)
    assert.equal(loads, 3)
    await cache.get('b', async () => ++loads)
    await cache.get('c', async () => ++loads)
    assert.equal(loads, 3, 'b and c are still remembered')
    await cache.get('a', async () => ++loads)
    assert.equal(loads, 4, 'a was dropped')
  })
})

describe('CachingAuthorizer', () => {
  const setup = (answer: () => Promise<AuthDecision>) => {
    const calls: Operation[] = []
    const inner: Authorizer = {
      authorize: async (_authorization, operation) => {
        calls.push(operation)
        return answer()
      },
    }
    let now = 0
    const authorizer = new CachingAuthorizer(inner, 5000, () => now)
    return { authorizer, calls, advance: (ms: number) => (now += ms) }
  }
  const authorized = async (): Promise<AuthDecision> => ({ kind: 'authorized', accountId: 'a1' })

  it('asks the User Service once for a session that keeps reading', async () => {
    const { authorizer, calls } = setup(authorized)
    for (let i = 0; i < 20; i++) {
      assert.deepEqual(await authorizer.authorize('Bearer x', 'supplier.read'), {
        kind: 'authorized',
        accountId: 'a1',
      })
    }
    assert.equal(calls.length, 1)
  })

  it('asks again once the answer is a few seconds old', async () => {
    const { authorizer, calls, advance } = setup(authorized)
    await authorizer.authorize('Bearer x', 'supplier.read')
    advance(4999)
    await authorizer.authorize('Bearer x', 'supplier.read')
    assert.equal(calls.length, 1)
    advance(1)
    await authorizer.authorize('Bearer x', 'supplier.read')
    assert.equal(calls.length, 2)
  })

  it('keeps sessions apart', async () => {
    const { authorizer, calls } = setup(authorized)
    await authorizer.authorize('Bearer one', 'supplier.read')
    await authorizer.authorize('Bearer two', 'supplier.read')
    assert.equal(calls.length, 2)
  })

  it('asks every time for an operation that changes a supplier', async () => {
    const { authorizer, calls } = setup(authorized)
    for (const operation of ['supplier.create', 'supplier.update', 'supplier.deactivate'] as const) {
      await authorizer.authorize('Bearer x', operation)
      await authorizer.authorize('Bearer x', operation)
    }
    assert.equal(calls.length, 6)
  })

  it('never remembers a refusal', async () => {
    for (const kind of ['denied', 'unauthenticated'] as const) {
      const { authorizer, calls } = setup(async () => ({ kind }))
      await authorizer.authorize('Bearer x', 'supplier.read')
      await authorizer.authorize('Bearer x', 'supplier.read')
      assert.equal(calls.length, 2, kind)
    }
  })

  it('never remembers that the User Service was unreachable', async () => {
    let fail = true
    const { authorizer, calls } = setup(async () => {
      if (fail) throw new HttpError(503, 'AUTH_UNAVAILABLE', 'down')
      return { kind: 'authorized', accountId: 'a1' }
    })
    await assert.rejects(authorizer.authorize('Bearer x', 'supplier.read'))
    fail = false
    assert.equal((await authorizer.authorize('Bearer x', 'supplier.read')).kind, 'authorized')
    assert.equal(calls.length, 2)
  })

  it('passes a missing session straight through', async () => {
    const { authorizer, calls } = setup(async () => ({ kind: 'unauthenticated' }))
    await authorizer.authorize(undefined, 'supplier.read')
    await authorizer.authorize(undefined, 'supplier.read')
    assert.equal(calls.length, 2)
  })

  it('shares one question between reads that arrive together', async () => {
    const { authorizer, calls } = setup(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { kind: 'authorized', accountId: 'a1' }
    })
    await Promise.all(Array.from({ length: 100 }, () => authorizer.authorize('Bearer x', 'supplier.read')))
    assert.equal(calls.length, 1)
  })
})

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { type Authorizer, type Operation } from './auth.ts'
import { HttpError, notFound, validationFailed } from './errors.ts'
import { evaluateAvailability, toLocalMoment, type LocalMoment } from './domain/availability.ts'
import { parseAt, parseListQuery } from './domain/query.ts'
import { WEEKDAYS, type Supplier } from './domain/supplier.ts'
import { formatClock } from './domain/time.ts'
import { validateCreate, validatePatch } from './domain/validation.ts'
import type { TtlCache } from './cache.ts'
import type { Pool } from './db.ts'
import * as repository from './repository.ts'

export interface RouteDeps {
  db: Pool
  authorizer: Authorizer
  timeZone: string
  now: () => Date
  listCache: TtlCache<{ items: Supplier[]; total: number }>
}

interface Params {
  id: string
}

declare module 'fastify' {
  interface FastifyRequest {
    // The account the User Service approved. Set by the onRequest check.
    actorId: string
  }
}

function present(supplier: Supplier, moment: LocalMoment) {
  return {
    id: supplier.id,
    name: supplier.name,
    type: supplier.type,
    zone: supplier.zone,
    building: supplier.building,
    address: supplier.address,
    description: supplier.description,
    latitude: supplier.latitude,
    longitude: supplier.longitude,
    contact: { phone: supplier.phone, email: supplier.email },
    hours: supplier.hours.map((h) => ({
      day: WEEKDAYS[h.day],
      opens: formatClock(h.opens),
      closes: formatClock(h.closes),
    })),
    status: supplier.status,
    availability: evaluateAvailability(supplier.hours, moment),
    createdAt: supplier.createdAt.toISOString(),
    updatedAt: supplier.updatedAt.toISOString(),
  }
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.decorateRequest('actorId', '')

  // Every route asks the User Service in an onRequest hook, which runs before
  // the body is parsed or validated and before the database is touched. A
  // refused caller learns nothing about which suppliers exist, and nothing is
  // changed.
  const requires = (operation: Operation) => async (request: FastifyRequest) => {
    const decision = await deps.authorizer.authorize(request.headers.authorization, operation)
    if (decision.kind === 'unauthenticated') {
      throw new HttpError(401, 'UNAUTHENTICATED', 'A valid session is required')
    }
    if (decision.kind === 'denied') {
      throw new HttpError(403, 'FORBIDDEN', 'You are not allowed to do this')
    }
    request.actorId = decision.accountId
  }

  app.get('/health', async (_request, reply) => {
    try {
      await deps.db.query('SELECT 1')
      return { status: 'ok' }
    } catch {
      return reply.status(503).send({ status: 'unavailable' })
    }
  })

  app.get('/suppliers', { onRequest: requires('supplier.read') }, async (request) => {
    const parsed = parseListQuery(request.query as Record<string, unknown>)
    if ('errors' in parsed) throw validationFailed(parsed.errors)

    // Suppliers change rarely and are read constantly, so the same search is
    // answered from memory for a couple of seconds. The opening hours are
    // evaluated below on every request, never cached.
    const { items, total } = await deps.listCache.get(JSON.stringify(parsed.value), () =>
      repository.listSuppliers(deps.db, parsed.value),
    )
    const moment = toLocalMoment(deps.now(), deps.timeZone)
    return {
      items: items.map((s) => present(s, moment)),
      page: parsed.value.page,
      pageSize: parsed.value.pageSize,
      total,
      totalPages: Math.ceil(total / parsed.value.pageSize),
    }
  })

  // Inactive suppliers stay retrievable here, for errands that already use them.
  app.get<{ Params: Params }>('/suppliers/:id', { onRequest: requires('supplier.read') }, async (request) => {
    const supplier = await repository.getSupplier(deps.db, request.params.id)
    if (!supplier) throw notFound()
    return present(supplier, toLocalMoment(deps.now(), deps.timeZone))
  })

  // For the Order Service, which has to know whether a supplier will be open at
  // the time an errand is needed by.
  app.get<{ Params: Params }>('/suppliers/:id/availability', { onRequest: requires('supplier.read') }, async (request) => {
    const parsed = parseAt(request.query as Record<string, unknown>)
    if ('errors' in parsed) throw validationFailed(parsed.errors)
    const supplier = await repository.getSupplier(deps.db, request.params.id)
    if (!supplier) throw notFound()

    const at = parsed.value ?? deps.now()
    const availability = evaluateAvailability(supplier.hours, toLocalMoment(at, deps.timeZone))
    return {
      supplierId: supplier.id,
      at: at.toISOString(),
      timezone: deps.timeZone,
      status: supplier.status,
      ...availability,
      // What a new errand may use: not deactivated, and open at that time.
      orderable: supplier.status === 'Active' && availability.open,
    }
  })

  app.post('/suppliers', { onRequest: requires('supplier.create') }, async (request, reply) => {
    const parsed = validateCreate(request.body)
    if ('errors' in parsed) throw validationFailed(parsed.errors)

    const supplier = await repository.createSupplier(deps.db, parsed.value, request.actorId)
    deps.listCache.clear()
    return reply
      .status(201)
      .header('location', `/suppliers/${supplier.id}`)
      .send(present(supplier, toLocalMoment(deps.now(), deps.timeZone)))
  })

  app.patch<{ Params: Params }>('/suppliers/:id', { onRequest: requires('supplier.update') }, async (request) => {
    const parsed = validatePatch(request.body)
    if ('errors' in parsed) throw validationFailed(parsed.errors)

    const supplier = await repository.updateSupplier(deps.db, request.params.id, parsed.value, request.actorId)
    deps.listCache.clear()
    if (!supplier) throw notFound()
    return present(supplier, toLocalMoment(deps.now(), deps.timeZone))
  })

  // Deleting a supplier means deactivating it. The record stays.
  app.delete<{ Params: Params }>('/suppliers/:id', { onRequest: requires('supplier.deactivate') }, async (request) => {
    const supplier = await repository.deactivateSupplier(deps.db, request.params.id, request.actorId)
    deps.listCache.clear()
    if (!supplier) throw notFound()
    return present(supplier, toLocalMoment(deps.now(), deps.timeZone))
  })
}

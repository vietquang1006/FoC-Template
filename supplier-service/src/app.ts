import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { TtlCache } from './cache.ts'
import { HttpError } from './errors.ts'
import { registerRoutes, type RouteDeps } from './routes.ts'

export interface AppOptions extends Omit<RouteDeps, 'now' | 'listCache'> {
  now?: () => Date
  // How long a search or listing may be served from memory. Off by default.
  readCacheSeconds?: number
  logger?: FastifyServerOptions['logger']
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 64 * 1024 })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send({
        error: { code: error.code, message: error.message, fields: error.fields },
      })
    }
    // Malformed JSON, wrong content type and the like are the caller's mistake.
    const status = (error as { statusCode?: number }).statusCode
    if (status !== undefined && status >= 400 && status < 500) {
      return reply
        .status(status)
        .send({ error: { code: 'BAD_REQUEST', message: (error as Error).message } })
    }
    request.log.error(error)
    return reply
      .status(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } })
  })

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No such route' } }),
  )

  registerRoutes(app, {
    ...options,
    now: options.now ?? (() => new Date()),
    listCache: new TtlCache((options.readCacheSeconds ?? 0) * 1000),
  })
  return app
}

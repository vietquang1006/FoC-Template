import path from 'node:path'
import { CachingAuthorizer, UserServiceAuthorizer } from './auth.ts'
import { buildApp } from './app.ts'
import { loadConfig } from './config.ts'
import { createPool, migrate } from './db.ts'
import { seedIfEmpty } from './seed/seed.ts'

const config = loadConfig()
const pool = createPool(config.databaseUrl, (error) =>
  app.log.error({ err: error }, 'An idle database connection failed'),
)

const app = buildApp({
  db: pool,
  authorizer: new CachingAuthorizer(
    new UserServiceAuthorizer(config.userServiceUrl),
    config.authCacheSeconds * 1000,
  ),
  timeZone: config.timeZone,
  readCacheSeconds: config.readCacheSeconds,
  logger: { level: config.logLevel },
})

const applied = await migrate(pool, path.join(import.meta.dirname, 'migrations'))
for (const file of applied) app.log.info(`Applied migration ${file}`)

if (config.seedOnStartup) await seedIfEmpty(pool, config.seedCsvPath, app.log)

await app.listen({ port: config.port, host: '0.0.0.0' })

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close()
    await pool.end()
    process.exit(0)
  })
}

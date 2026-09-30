export interface Config {
  port: number
  logLevel: string
  databaseUrl: string
  userServiceUrl: string
  timeZone: string
  seedOnStartup: boolean
  seedCsvPath: string
  authCacheSeconds: number
  readCacheSeconds: number
}

function seconds(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a number of seconds, 0 or more: ${raw}`)
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ['SUPPLIER_DATABASE_URL', 'USER_SERVICE_URL'].filter((name) => !env[name])
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}. See .env.example.`)
  }

  const timeZone = env.SUPPLIER_TIMEZONE || 'Asia/Singapore'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
  } catch {
    throw new Error(`SUPPLIER_TIMEZONE is not a valid time zone: ${timeZone}`)
  }

  return {
    port: Number(env.SUPPLIER_SERVICE_PORT || 3002),
    logLevel: env.LOG_LEVEL || 'info',
    databaseUrl: env.SUPPLIER_DATABASE_URL!,
    userServiceUrl: env.USER_SERVICE_URL!,
    timeZone,
    seedOnStartup: (env.SUPPLIER_SEED_ON_STARTUP || 'true') === 'true',
    seedCsvPath: env.SUPPLIER_SEED_CSV_PATH || '../data/csv/supplier-seed-data.csv',
    authCacheSeconds: seconds(env, 'SUPPLIER_AUTH_CACHE_SECONDS', 5),
    readCacheSeconds: seconds(env, 'SUPPLIER_READ_CACHE_SECONDS', 2),
  }
}

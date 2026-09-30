import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'

// Enough for the repository code, and satisfied by both a pool and a client in
// the middle of a transaction.
export interface Db {
  query(text: string, values?: unknown[]): Promise<pg.QueryResult>
}

export type Pool = pg.Pool

// The pool reports a connection that dies while idle, for example when the
// database restarts, as an 'error' event. Without a listener Node treats that as
// fatal and the whole service exits. The pool drops the dead connection itself
// and opens a new one for the next request.
export function createPool(
  connectionString: string,
  onError: (error: Error) => void = (error) => console.error('Idle database connection failed:', error.message),
): Pool {
  const pool = new pg.Pool({ connectionString })
  pool.on('error', onError)
  return pool
}

// Application-wide locks so that several instances starting at once do not
// migrate or seed at the same time.
const MIGRATE_LOCK = 3219001
const SEED_LOCK = 3219002

export async function withTransaction<T>(pool: Pool, work: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function seedLock(db: Db): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock($1)', [SEED_LOCK])
}

// Applies the numbered .sql files that have not run yet, in order.
export async function migrate(pool: Pool, directory: string): Promise<string[]> {
  const files = (await readdir(directory)).filter((f) => f.endsWith('.sql')).sort()
  const client = await pool.connect()
  const applied: string[] = []
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK])
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    )
    const done = await client.query('SELECT name FROM schema_migrations')
    const already = new Set(done.rows.map((row) => row.name as string))
    for (const file of files) {
      if (already.has(file)) continue
      const sql = await readFile(path.join(directory, file), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`)
      }
      applied.push(file)
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATE_LOCK])
    client.release()
  }
  return applied
}

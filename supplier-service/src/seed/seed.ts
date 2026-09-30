import { readFile } from 'node:fs/promises'
import { seedLock, withTransaction, type Pool } from '../db.ts'
import { countSuppliers, insertSupplier } from '../repository.ts'
import { decodeSeedFile, parseCsv } from './csv.ts'
import { rowsToSuppliers } from './suppliers.ts'

interface Log {
  info(message: string): void
  warn(message: string): void
}

// Seeds only an empty table, so that restarting the service never brings back
// a supplier an administrator has deactivated or changed. Returns how many
// suppliers were added.
export async function seedIfEmpty(pool: Pool, csvPath: string, log: Log): Promise<number> {
  const bytes = await readFile(csvPath)
  const { suppliers, warnings } = rowsToSuppliers(parseCsv(decodeSeedFile(bytes)))
  for (const warning of warnings) log.warn(warning)

  return withTransaction(pool, async (db) => {
    await seedLock(db)
    if ((await countSuppliers(db)) > 0) return 0
    for (const supplier of suppliers) await insertSupplier(db, supplier, null)
    log.info(`Seeded ${suppliers.length} suppliers from ${csvPath}`)
    return suppliers.length
  })
}

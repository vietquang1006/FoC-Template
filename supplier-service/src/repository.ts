import { withTransaction, type Db, type Pool } from './db.ts'
import type { ListFilters } from './domain/query.ts'
import type { DayHours, Supplier, SupplierInput } from './domain/supplier.ts'

// One query per read: the weekday rows are folded into a JSON array on each
// supplier so that a page of results never needs a second round trip.
const HOURS_JOIN = `
  LEFT JOIN LATERAL (
    SELECT json_agg(
      json_build_object('day', sh.weekday, 'opens', sh.opens_minute, 'closes', sh.closes_minute)
      ORDER BY sh.weekday
    ) AS hours
    FROM supplier_hours sh
    WHERE sh.supplier_id = s.id
  ) h ON true`

const SELECT_SUPPLIERS = `
  SELECT s.*, COALESCE(h.hours, '[]'::json) AS hours
  FROM suppliers s
  ${HOURS_JOIN}`

interface SupplierRow {
  id: string
  name: string
  type: string
  zone: string
  building: string
  address: string
  description: string | null
  latitude: number | null
  longitude: number | null
  phone: string | null
  email: string | null
  status: Supplier['status']
  created_at: Date
  updated_at: Date
  hours: DayHours[]
}

function toSupplier(row: SupplierRow): Supplier {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    zone: row.zone,
    building: row.building,
    address: row.address,
    description: row.description,
    latitude: row.latitude,
    longitude: row.longitude,
    phone: row.phone,
    email: row.email,
    status: row.status,
    hours: row.hours,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function getSupplier(db: Db, id: string): Promise<Supplier | null> {
  // An id that is not a UUID cannot exist, and would make the database error.
  if (!UUID.test(id)) return null
  const result = await db.query(`${SELECT_SUPPLIERS} WHERE s.id = $1`, [id])
  return result.rows[0] ? toSupplier(result.rows[0] as SupplierRow) : null
}

// A search term matches when it appears in any of these columns, and every term
// has to match.
const SEARCH_COLUMNS = ['name', 'type', 'building', 'zone', 'address']

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function buildWhere(filters: ListFilters) {
  const clauses: string[] = []
  const params: unknown[] = []
  const bind = (value: unknown) => {
    params.push(value)
    return `$${params.length}`
  }

  if (filters.status !== 'all') clauses.push(`s.status = ${bind(filters.status)}`)
  if (filters.type) clauses.push(`lower(s.type) = lower(${bind(filters.type)})`)
  if (filters.zone) clauses.push(`lower(s.zone) = lower(${bind(filters.zone)})`)
  if (filters.building) clauses.push(`lower(s.building) = lower(${bind(filters.building)})`)
  for (const term of filters.terms) {
    const like = bind(`%${escapeLike(term)}%`)
    clauses.push(`(${SEARCH_COLUMNS.map((c) => `s.${c} ILIKE ${like}`).join(' OR ')})`)
  }

  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

export async function listSuppliers(
  db: Db,
  filters: ListFilters,
): Promise<{ items: Supplier[]; total: number }> {
  const where = buildWhere(filters)
  const limit = `$${where.params.length + 1}`
  const offset = `$${where.params.length + 2}`
  const skipped = (filters.page - 1) * filters.pageSize

  // The page is cut first and only then joined to its opening hours. The total
  // is counted over every match in the same pass.
  const rows = await db.query(
    `WITH page AS (
       SELECT s.*, count(*) OVER () AS total_count
       FROM suppliers s
       ${where.sql}
       ORDER BY lower(s.name), s.id
       LIMIT ${limit} OFFSET ${offset}
     )
     SELECT s.*, COALESCE(h.hours, '[]'::json) AS hours
     FROM page s
     ${HOURS_JOIN}
     ORDER BY lower(s.name), s.id`,
    [...where.params, filters.pageSize, skipped],
  )

  const items = (rows.rows as SupplierRow[]).map(toSupplier)
  if (rows.rows.length > 0) return { items, total: Number(rows.rows[0].total_count) }
  // A page past the end has no rows to carry the total, so count separately.
  if (skipped === 0) return { items, total: 0 }
  const count = await db.query(`SELECT count(*)::int AS total FROM suppliers s ${where.sql}`, where.params)
  return { items, total: count.rows[0].total as number }
}

async function insertHours(db: Db, supplierId: string, hours: DayHours[]): Promise<void> {
  await db.query(
    `INSERT INTO supplier_hours (supplier_id, weekday, opens_minute, closes_minute)
     SELECT $1::uuid, * FROM unnest($2::smallint[], $3::smallint[], $4::smallint[])`,
    [supplierId, hours.map((h) => h.day), hours.map((h) => h.opens), hours.map((h) => h.closes)],
  )
}

// Inserts without opening a transaction, so that the seed can add all of its
// suppliers in one.
export async function insertSupplier(
  db: Db,
  input: SupplierInput,
  actor: string | null,
): Promise<string> {
  const result = await db.query(
    `INSERT INTO suppliers
       (name, type, zone, building, address, description, latitude, longitude,
        phone, email, status, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
     RETURNING id`,
    [
      input.name,
      input.type,
      input.zone,
      input.building,
      input.address,
      input.description,
      input.latitude,
      input.longitude,
      input.phone,
      input.email,
      input.status,
      actor,
    ],
  )
  const id = result.rows[0].id as string
  await insertHours(db, id, input.hours)
  return id
}

export async function createSupplier(pool: Pool, input: SupplierInput, actor: string): Promise<Supplier> {
  return withTransaction(pool, async (db) => {
    const id = await insertSupplier(db, input, actor)
    return (await getSupplier(db, id))!
  })
}

const PATCH_COLUMNS = [
  'name',
  'type',
  'zone',
  'building',
  'address',
  'description',
  'latitude',
  'longitude',
  'phone',
  'email',
  'status',
] as const

export async function updateSupplier(
  pool: Pool,
  id: string,
  patch: Partial<SupplierInput>,
  actor: string,
): Promise<Supplier | null> {
  if (!UUID.test(id)) return null
  return withTransaction(pool, async (db) => {
    // The row lock makes two updates to one supplier run one after the other.
    const locked = await db.query('SELECT id FROM suppliers WHERE id = $1 FOR UPDATE', [id])
    if (locked.rowCount === 0) return null

    const params: unknown[] = [id]
    const assignments: string[] = []
    for (const column of PATCH_COLUMNS) {
      if (!Object.hasOwn(patch, column)) continue
      params.push(patch[column])
      assignments.push(`${column} = $${params.length}`)
    }
    params.push(actor)
    assignments.push(`updated_by = $${params.length}`, 'updated_at = now()')
    await db.query(`UPDATE suppliers SET ${assignments.join(', ')} WHERE id = $1`, params)

    if (patch.hours) {
      await db.query('DELETE FROM supplier_hours WHERE supplier_id = $1', [id])
      await insertHours(db, id, patch.hours)
    }
    return getSupplier(db, id)
  })
}

// Suppliers are never removed. Deactivating one that is already Inactive leaves
// it untouched, so repeating the request changes nothing.
export async function deactivateSupplier(db: Db, id: string, actor: string): Promise<Supplier | null> {
  if (!UUID.test(id)) return null
  await db.query(
    `UPDATE suppliers SET status = 'Inactive', updated_at = now(), updated_by = $2
     WHERE id = $1 AND status <> 'Inactive'`,
    [id, actor],
  )
  return getSupplier(db, id)
}

export async function countSuppliers(db: Db): Promise<number> {
  const result = await db.query('SELECT count(*)::int AS total FROM suppliers')
  return result.rows[0].total as number
}

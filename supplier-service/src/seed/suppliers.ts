import type { DayHours, SupplierInput } from '../domain/supplier.ts'
import { MINUTES_PER_DAY } from '../domain/time.ts'

// The seed file has no campus zone, per-day hours or contact details, so those
// are worked out here. The type is taken from the file exactly as written.

// The same building is spelled more than one way in the seed file.
const BUILDING_ALIASES: Record<string, string> = {
  'Com 2': 'COM2',
  Com2: 'COM2',
  'innovation4.0': 'Innovation 4.0',
}

// Campus zone of each building. A building that is not listed gets the zone
// "Other" and a warning, so that a new row in the file never stops the service
// from starting.
const ZONE_BY_BUILDING: Record<string, string> = {
  'Central Library': 'Central',
  'Yusof Ishak House': 'Central',
  'Blk AS8': 'Central',
  COM2: 'Computing',
  COM3: 'Computing',
  Terrace: 'Computing',
  Frontier: 'Science',
  'The Ridge': 'Science',
  'Innovation 4.0': 'Science',
  'Engineering Block E3': 'Engineering',
  'Engineering Block E4': 'Engineering',
  'Engineering Block EA': 'Engineering',
  'Medicine+Science Library': 'Medicine',
  'Hon Sui Sen Memorial Library': 'Business',
  "Prince George's Park": 'Residences',
}

const REQUIRED_COLUMNS = [
  'Name',
  'Type',
  'Building',
  'Floor',
  'Location Description',
  'Latitude',
  'Longitude',
  'StartingTime',
  'ClosingTime',
]

function normalizeBuilding(raw: string): string {
  const building = raw.trim().replace(/[‘’]/g, "'")
  return BUILDING_ALIASES[building] ?? building
}

// "0900hrs" as minutes after midnight.
function parseHrs(text: string): number | null {
  const match = /^(\d{2})(\d{2})hrs$/.exec(text.trim())
  if (!match) return null
  const minutes = Number(match[1]) * 60 + Number(match[2])
  return minutes < MINUTES_PER_DAY ? minutes : null
}

// The file gives one opening and one closing time for every day of the week.
// 0000hrs to 2359hrs means open around the clock.
function weeklyHours(opens: number, closes: number): DayHours[] {
  const end = opens === 0 && closes === 23 * 60 + 59 ? MINUTES_PER_DAY : closes
  return Array.from({ length: 7 }, (_, day) => ({ day, opens, closes: end }))
}

export function rowsToSuppliers(rows: string[][]): { suppliers: SupplierInput[]; warnings: string[] } {
  const [header, ...body] = rows
  if (!header) throw new Error('The seed file is empty')
  const column = new Map(header.map((name, index) => [name.trim(), index]))
  const missing = REQUIRED_COLUMNS.filter((name) => !column.has(name))
  if (missing.length > 0) {
    throw new Error(`The seed file is missing columns: ${missing.join(', ')}`)
  }

  const warnings: string[] = []
  const suppliers: SupplierInput[] = []

  body.forEach((cells, index) => {
    const line = index + 2
    const cell = (name: string) => (cells[column.get(name)!] ?? '').trim()

    const name = cell('Name')
    const type = cell('Type')
    const building = normalizeBuilding(cell('Building'))
    const floor = cell('Floor')
    const latitude = Number(cell('Latitude'))
    const longitude = Number(cell('Longitude'))
    const opens = parseHrs(cell('StartingTime'))
    const closes = parseHrs(cell('ClosingTime'))

    if (!name || !type || !building) {
      throw new Error(`Seed file line ${line}: name, type and building are required`)
    }
    if (opens === null || closes === null || opens === closes) {
      throw new Error(`Seed file line ${line}: ${name} has invalid opening times`)
    }
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error(`Seed file line ${line}: ${name} has invalid coordinates`)
    }

    let zone = ZONE_BY_BUILDING[building]
    if (!zone) {
      zone = 'Other'
      warnings.push(`Seed file line ${line}: no zone known for building "${building}"`)
    }

    suppliers.push({
      name,
      type,
      zone,
      building,
      address: floor ? `${building}, Level ${floor}` : building,
      description: cell('Location Description') || null,
      latitude,
      longitude,
      phone: null,
      email: null,
      status: 'Active',
      hours: weeklyHours(opens, closes),
    })
  })

  return { suppliers, warnings }
}

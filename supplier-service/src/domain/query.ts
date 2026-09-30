import type { FieldError, Validated } from './validation.ts'

export const MAX_PAGE_SIZE = 20

export interface ListFilters {
  terms: string[]
  type: string | null
  zone: string | null
  building: string | null
  status: 'Active' | 'Inactive' | 'all'
  page: number
  pageSize: number
}

type Query = Record<string, unknown>

// A query string value is a string, or an array when the parameter is repeated.
function single(query: Query, key: string, errors: FieldError[]): string | null {
  const raw = query[key]
  if (raw === undefined) return null
  if (typeof raw !== 'string') {
    errors.push({ field: key, message: 'must be given once' })
    return null
  }
  return raw.trim() === '' ? null : raw.trim()
}

function whole(
  query: Query,
  key: string,
  min: number,
  max: number,
  fallback: number,
  errors: FieldError[],
): number {
  const raw = single(query, key, errors)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push({ field: key, message: `must be a whole number from ${min} to ${max}` })
    return fallback
  }
  return value
}

export function parseListQuery(query: Query): Validated<ListFilters> {
  const errors: FieldError[] = []

  const q = single(query, 'q', errors)
  if (q !== null && q.length > 100) {
    errors.push({ field: 'q', message: 'must be at most 100 characters' })
  }

  const text = (key: string, max: number) => {
    const value = single(query, key, errors)
    if (value !== null && value.length > max) {
      errors.push({ field: key, message: `must be at most ${max} characters` })
    }
    return value
  }

  const statusText = single(query, 'status', errors)
  const status = statusText === null ? 'Active' : statusText
  if (status !== 'Active' && status !== 'Inactive' && status !== 'all') {
    errors.push({ field: 'status', message: 'must be one of Active, Inactive, all' })
  }

  const filters: ListFilters = {
    terms: q === null ? [] : q.split(/\s+/).slice(0, 5),
    type: text('type', 60),
    zone: text('zone', 60),
    building: text('building', 120),
    status: status === 'Inactive' || status === 'all' ? status : 'Active',
    page: whole(query, 'page', 1, 100000, 1, errors),
    pageSize: whole(query, 'pageSize', 1, MAX_PAGE_SIZE, MAX_PAGE_SIZE, errors),
  }
  return errors.length > 0 ? { errors } : { value: filters }
}

// The moment to evaluate opening hours at. It must carry a UTC offset, because
// a bare "2026-10-01T12:00" would silently be read in the server's time zone.
export function parseAt(query: Query): Validated<Date | null> {
  const errors: FieldError[] = []
  const raw = single(query, 'at', errors)
  if (errors.length > 0) return { errors }
  if (raw === null) return { value: null }
  const date = new Date(raw)
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(raw) || Number.isNaN(date.getTime())) {
    return {
      errors: [{ field: 'at', message: 'must be an ISO 8601 time with an offset, such as 2026-10-01T12:00:00+08:00' }],
    }
  }
  return { value: date }
}

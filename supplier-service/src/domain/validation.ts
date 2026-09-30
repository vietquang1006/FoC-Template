import {
  SUPPLIER_STATUSES,
  WEEKDAYS,
  type DayHours,
  type SupplierInput,
} from './supplier.ts'
import { MINUTES_PER_DAY, parseClock } from './time.ts'

export interface FieldError {
  field: string
  message: string
}

export type Validated<T> = { value: T } | { errors: FieldError[] }

type Body = Record<string, unknown>

const WRITABLE = new Set([
  'name',
  'type',
  'zone',
  'building',
  'address',
  'description',
  'latitude',
  'longitude',
  'contact',
  'hours',
  'status',
])
const READ_ONLY = new Set(['id', 'createdAt', 'updatedAt', 'availability'])

const PHONE = /^[+()\d][\d\s()+-]{5,19}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isObject(value: unknown): value is Body {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function has(body: Body, key: string): boolean {
  return Object.hasOwn(body, key)
}

// The whole supplier record, for creating one. Every field except the
// optional ones must be present.
export function validateCreate(body: unknown): Validated<SupplierInput> {
  if (!isObject(body)) return { errors: [{ field: 'body', message: 'must be a JSON object' }] }
  const { errors, value } = readFields(body, true)
  if (errors.length > 0) return { errors }
  return {
    value: {
      name: value.name!,
      type: value.type!,
      zone: value.zone!,
      building: value.building!,
      address: value.address!,
      description: value.description ?? null,
      latitude: value.latitude ?? null,
      longitude: value.longitude ?? null,
      phone: value.phone ?? null,
      email: value.email ?? null,
      status: value.status ?? 'Active',
      hours: value.hours!,
    },
  }
}

// Any subset of the writable fields. Only the fields present are returned.
export function validatePatch(body: unknown): Validated<Partial<SupplierInput>> {
  if (!isObject(body)) return { errors: [{ field: 'body', message: 'must be a JSON object' }] }
  if (Object.keys(body).length === 0) {
    return { errors: [{ field: 'body', message: 'must contain at least one field to update' }] }
  }
  const { errors, value } = readFields(body, false)
  if (errors.length > 0) return { errors }
  return { value }
}

function readFields(body: Body, isCreate: boolean) {
  const errors: FieldError[] = []
  const value: Partial<SupplierInput> = {}

  for (const key of Object.keys(body)) {
    if (WRITABLE.has(key)) continue
    errors.push({
      field: key,
      message: READ_ONLY.has(key) ? 'cannot be set' : 'is not a known field',
    })
  }

  const text = (key: 'name' | 'type' | 'zone' | 'building' | 'address', max: number) => {
    if (!has(body, key)) {
      if (isCreate) errors.push({ field: key, message: 'is required' })
      return
    }
    const raw = body[key]
    const trimmed = typeof raw === 'string' ? raw.trim() : ''
    if (trimmed.length === 0 || trimmed.length > max) {
      errors.push({ field: key, message: `must be text of 1 to ${max} characters` })
      return
    }
    value[key] = trimmed
  }
  text('name', 120)
  text('type', 60)
  text('zone', 60)
  text('building', 120)
  text('address', 200)

  if (has(body, 'status')) {
    const raw = body.status
    const found = SUPPLIER_STATUSES.find((s) => s === raw)
    if (found) value.status = found
    else errors.push({ field: 'status', message: `must be one of ${SUPPLIER_STATUSES.join(', ')}` })
  }

  // Forms send an empty string for an optional field left blank.
  const optionalText = (
    field: string,
    raw: unknown,
    accept: (text: string) => boolean,
    message: string,
  ): string | null | undefined => {
    if (raw === null || raw === '') return null
    if (typeof raw === 'string' && accept(raw.trim())) return raw.trim()
    errors.push({ field, message })
    return undefined
  }

  if (has(body, 'description')) {
    const description = optionalText(
      'description',
      body.description,
      (t) => t.length <= 500,
      'must be text of at most 500 characters or null',
    )
    if (description !== undefined) value.description = description
  }

  // Latitude and longitude only make sense as a pair.
  if (has(body, 'latitude') !== has(body, 'longitude')) {
    errors.push({
      field: has(body, 'latitude') ? 'longitude' : 'latitude',
      message: 'must be provided together with the other coordinate',
    })
  } else if (has(body, 'latitude')) {
    const { latitude, longitude } = body
    if (latitude === null && longitude === null) {
      value.latitude = null
      value.longitude = null
    } else {
      const validLatitude = typeof latitude === 'number' && latitude >= -90 && latitude <= 90
      const validLongitude = typeof longitude === 'number' && longitude >= -180 && longitude <= 180
      if (!validLatitude) errors.push({ field: 'latitude', message: 'must be a number from -90 to 90' })
      if (!validLongitude) {
        errors.push({ field: 'longitude', message: 'must be a number from -180 to 180' })
      }
      if (validLatitude && validLongitude) {
        value.latitude = latitude
        value.longitude = longitude
      }
    }
  }

  if (has(body, 'contact')) {
    const contact = body.contact
    if (!isObject(contact)) {
      errors.push({ field: 'contact', message: 'must be an object with phone and email' })
    } else {
      for (const key of Object.keys(contact)) {
        if (key !== 'phone' && key !== 'email') {
          errors.push({ field: `contact.${key}`, message: 'is not a known field' })
        }
      }
      if (has(contact, 'phone')) {
        const phone = optionalText(
          'contact.phone',
          contact.phone,
          (t) => PHONE.test(t),
          'must be a phone number of 6 to 20 digits, spaces, +, - or brackets',
        )
        if (phone !== undefined) value.phone = phone
      }
      if (has(contact, 'email')) {
        const email = optionalText(
          'contact.email',
          contact.email,
          (t) => t.length <= 254 && EMAIL.test(t),
          'must be a valid email address',
        )
        if (email !== undefined) value.email = email
      }
    }
  }

  if (has(body, 'hours')) {
    const hours = readHours(body.hours, errors)
    if (hours) value.hours = hours
  } else if (isCreate) {
    errors.push({ field: 'hours', message: 'is required' })
  }

  return { errors, value }
}

function readHours(raw: unknown, errors: FieldError[]): DayHours[] | undefined {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 7) {
    errors.push({
      field: 'hours',
      message: 'must list 1 to 7 weekdays, and a weekday left out is closed all day',
    })
    return undefined
  }

  const before = errors.length
  const seen = new Set<number>()
  const hours: DayHours[] = []
  raw.forEach((entry: unknown, index) => {
    const at = `hours[${index}]`
    if (!isObject(entry)) {
      errors.push({ field: at, message: 'must be an object with day, opens and closes' })
      return
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'day' && key !== 'opens' && key !== 'closes') {
        errors.push({ field: `${at}.${key}`, message: 'is not a known field' })
      }
    }

    const day = WEEKDAYS.findIndex((d) => d === entry.day)
    if (day === -1) {
      errors.push({ field: `${at}.day`, message: `must be one of ${WEEKDAYS.join(', ')}` })
    } else if (seen.has(day)) {
      errors.push({ field: `${at}.day`, message: 'is listed more than once' })
    } else {
      seen.add(day)
    }

    const opens = typeof entry.opens === 'string' ? parseClock(entry.opens) : null
    const closes = typeof entry.closes === 'string' ? parseClock(entry.closes) : null
    if (opens === null || opens >= MINUTES_PER_DAY) {
      errors.push({ field: `${at}.opens`, message: 'must be a time from 00:00 to 23:59 as HH:MM' })
    }
    if (closes === null || closes === 0) {
      errors.push({ field: `${at}.closes`, message: 'must be a time from 00:01 to 24:00 as HH:MM' })
    }
    if (opens !== null && closes !== null && opens === closes) {
      errors.push({ field: `${at}.closes`, message: 'must differ from opens' })
    }
    if (day !== -1 && opens !== null && closes !== null) hours.push({ day, opens, closes })
  })

  if (errors.length > before) return undefined
  return hours.sort((a, b) => a.day - b.day)
}

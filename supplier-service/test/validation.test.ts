import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseAt, parseListQuery } from '../src/domain/query.ts'
import { validateCreate, validatePatch, type FieldError } from '../src/domain/validation.ts'

const valid = () => ({
  name: '  Test Cafe ',
  type: 'Food',
  zone: 'Central',
  building: 'Central Library',
  address: 'Central Library, Level 1',
  hours: [{ day: 'monday', opens: '09:00', closes: '18:00' }],
})

const errorsOf = (result: { errors: FieldError[] } | { value: unknown }) => {
  assert.ok('errors' in result, 'expected validation errors')
  return result.errors
}
const fieldsOf = (result: { errors: FieldError[] } | { value: unknown }) =>
  errorsOf(result).map((e) => e.field)

describe('validateCreate', () => {
  it('accepts the required fields and fills in the optional ones', () => {
    const result = validateCreate(valid())
    assert.ok('value' in result)
    assert.deepEqual(result.value, {
      name: 'Test Cafe',
      type: 'Food',
      zone: 'Central',
      building: 'Central Library',
      address: 'Central Library, Level 1',
      description: null,
      latitude: null,
      longitude: null,
      phone: null,
      email: null,
      status: 'Active',
      hours: [{ day: 0, opens: 540, closes: 1080 }],
    })
  })

  it('names every field that is missing', () => {
    assert.deepEqual(fieldsOf(validateCreate({})).sort(), [
      'address',
      'building',
      'hours',
      'name',
      'type',
      'zone',
    ])
  })

  it('rejects a body that is not an object', () => {
    assert.deepEqual(fieldsOf(validateCreate('nope')), ['body'])
    assert.deepEqual(fieldsOf(validateCreate([valid()])), ['body'])
  })

  it('names every invalid field at once', () => {
    const result = validateCreate({
      ...valid(),
      name: '',
      type: '',
      status: 'Closed',
      contact: { phone: 'abc', email: 'nope' },
      latitude: 100,
      longitude: 103.7,
    })
    assert.deepEqual(fieldsOf(result).sort(), [
      'contact.email',
      'contact.phone',
      'latitude',
      'name',
      'status',
      'type',
    ])
  })

  it('refuses the fields the service assigns itself', () => {
    const errors = errorsOf(validateCreate({ ...valid(), id: 'x', createdAt: 'y', colour: 'z' }))
    assert.deepEqual(errors, [
      { field: 'id', message: 'cannot be set' },
      { field: 'createdAt', message: 'cannot be set' },
      { field: 'colour', message: 'is not a known field' },
    ])
  })

  it('needs both coordinates or neither', () => {
    assert.deepEqual(errorsOf(validateCreate({ ...valid(), latitude: 1.29 })), [
      { field: 'longitude', message: 'must be provided together with the other coordinate' },
    ])
    const both = validateCreate({ ...valid(), latitude: 1.29, longitude: 103.77 })
    assert.ok('value' in both)
  })

  it('takes any type, written as it is in the seed file', () => {
    for (const type of ['Food', 'Food/Coffee', 'Shopping', 'Printing', 'Laundry']) {
      const result = validateCreate({ ...valid(), type })
      assert.ok('value' in result, type)
      assert.equal(result.value.type, type)
    }
  })

  it('refuses a type that is blank or too long', () => {
    assert.deepEqual(fieldsOf(validateCreate({ ...valid(), type: '   ' })), ['type'])
    assert.deepEqual(fieldsOf(validateCreate({ ...valid(), type: 'x'.repeat(61) })), ['type'])
  })

  it('no longer has a separate category, so the old field is refused', () => {
    assert.deepEqual(errorsOf(validateCreate({ ...valid(), category: 'Food' })), [
      { field: 'category', message: 'is not a known field' },
    ])
  })

  it('turns a blank optional field into null', () => {
    const result = validateCreate({
      ...valid(),
      description: '',
      contact: { phone: '', email: '' },
    })
    assert.ok('value' in result)
    assert.equal(result.value.description, null)
    assert.equal(result.value.phone, null)
    assert.equal(result.value.email, null)
  })

  it('accepts a real phone number and email address', () => {
    const result = validateCreate({
      ...valid(),
      contact: { phone: '+65 6516 1234', email: 'help@example.com' },
    })
    assert.ok('value' in result)
    assert.equal(result.value.phone, '+65 6516 1234')
    assert.equal(result.value.email, 'help@example.com')
  })
})

describe('opening hours', () => {
  const withHours = (hours: unknown) => validateCreate({ ...valid(), hours })

  it('points at the exact entry and field that is wrong', () => {
    assert.deepEqual(
      errorsOf(
        withHours([
          { day: 'monday', opens: '09:00', closes: '18:00' },
          { day: 'funday', opens: '9am', closes: '24:01' },
        ]),
      ),
      [
        { field: 'hours[1].day', message: 'must be one of monday, tuesday, wednesday, thursday, friday, saturday, sunday' },
        { field: 'hours[1].opens', message: 'must be a time from 00:00 to 23:59 as HH:MM' },
        { field: 'hours[1].closes', message: 'must be a time from 00:01 to 24:00 as HH:MM' },
      ],
    )
  })

  it('rejects a weekday listed twice', () => {
    assert.deepEqual(
      errorsOf(
        withHours([
          { day: 'monday', opens: '09:00', closes: '12:00' },
          { day: 'monday', opens: '13:00', closes: '18:00' },
        ]),
      ),
      [{ field: 'hours[1].day', message: 'is listed more than once' }],
    )
  })

  it('rejects opening and closing at the same time', () => {
    assert.deepEqual(fieldsOf(withHours([{ day: 'monday', opens: '09:00', closes: '09:00' }])), [
      'hours[0].closes',
    ])
  })

  it('accepts closing at 24:00 and closing after midnight', () => {
    const result = withHours([
      { day: 'sunday', opens: '00:00', closes: '24:00' },
      { day: 'monday', opens: '11:00', closes: '02:00' },
    ])
    assert.ok('value' in result)
    assert.deepEqual(result.value.hours, [
      { day: 0, opens: 660, closes: 120 },
      { day: 6, opens: 0, closes: 1440 },
    ])
  })

  it('needs between 1 and 7 entries', () => {
    assert.deepEqual(fieldsOf(withHours([])), ['hours'])
    assert.deepEqual(fieldsOf(withHours('always')), ['hours'])
  })
})

describe('validatePatch', () => {
  it('returns only the fields that were sent', () => {
    const result = validatePatch({ name: 'New name', contact: { phone: '6516 1234' } })
    assert.deepEqual(result, { value: { name: 'New name', phone: '6516 1234' } })
  })

  it('clears an optional field when it is set to null', () => {
    assert.deepEqual(validatePatch({ description: null }), { value: { description: null } })
  })

  it('refuses an empty update', () => {
    assert.deepEqual(errorsOf(validatePatch({})), [
      { field: 'body', message: 'must contain at least one field to update' },
    ])
  })

  it('refuses to change the identifier or the creation time', () => {
    assert.deepEqual(fieldsOf(validatePatch({ id: 'x', createdAt: 'y' })), ['id', 'createdAt'])
  })

  it('validates the fields it is given', () => {
    assert.deepEqual(fieldsOf(validatePatch({ type: '', name: ' ' })).sort(), ['name', 'type'])
  })

  it('does not require the fields it leaves out', () => {
    assert.ok('value' in validatePatch({ status: 'Inactive' }))
  })
})

describe('parseListQuery', () => {
  it('defaults to active suppliers, page 1, 20 per page', () => {
    const result = parseListQuery({})
    assert.ok('value' in result)
    assert.deepEqual(result.value, {
      terms: [],
      type: null,
      zone: null,
      building: null,
      status: 'Active',
      page: 1,
      pageSize: 20,
    })
  })

  it('splits the keyword into terms', () => {
    const result = parseListQuery({ q: '  prince   george ' })
    assert.ok('value' in result)
    assert.deepEqual(result.value.terms, ['prince', 'george'])
  })

  it('never allows more than 20 per page', () => {
    assert.deepEqual(fieldsOf(parseListQuery({ pageSize: '21' })), ['pageSize'])
    assert.deepEqual(fieldsOf(parseListQuery({ pageSize: '0' })), ['pageSize'])
  })

  it('names every invalid parameter', () => {
    assert.deepEqual(
      fieldsOf(parseListQuery({ type: ['a', 'b'], status: 'gone', page: '0', zone: ['a', 'b'] })).sort(),
      ['page', 'status', 'type', 'zone'],
    )
  })

  it('accepts each status', () => {
    for (const status of ['Active', 'Inactive', 'all']) {
      const result = parseListQuery({ status })
      assert.ok('value' in result)
      assert.equal(result.value.status, status)
    }
  })
})

describe('parseAt', () => {
  it('is null when no time is given', () => {
    assert.deepEqual(parseAt({}), { value: null })
  })

  it('accepts a time with an offset', () => {
    const result = parseAt({ at: '2026-10-01T12:00:00+08:00' })
    assert.ok('value' in result)
    assert.equal(result.value?.toISOString(), '2026-10-01T04:00:00.000Z')
  })

  it('refuses a time without an offset, which would be read in the server zone', () => {
    assert.deepEqual(fieldsOf(parseAt({ at: '2026-10-01T12:00:00' })), ['at'])
    assert.deepEqual(fieldsOf(parseAt({ at: 'tomorrow' })), ['at'])
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluateAvailability, toLocalMoment } from '../src/domain/availability.ts'
import type { DayHours } from '../src/domain/supplier.ts'

const MON = 0
const TUE = 1
const THU = 3
const FRI = 4
const SAT = 5
const SUN = 6

const at = (day: number, clock: string) => {
  const [h, m] = clock.split(':').map(Number)
  return { day, minute: h! * 60 + m! }
}

const every = (opens: number, closes: number, days = [0, 1, 2, 3, 4, 5, 6]): DayHours[] =>
  days.map((day) => ({ day, opens, closes }))

const h = (clock: string) => {
  const [hours, minutes] = clock.split(':').map(Number)
  return hours! * 60 + minutes!
}

describe('evaluateAvailability', () => {
  const daytime = every(h('09:00'), h('18:00'))

  it('is closed before opening and reports the opening time', () => {
    assert.deepEqual(evaluateAvailability(daytime, at(THU, '08:59')), {
      open: false,
      closesAt: null,
      nextOpensAt: { day: 'thursday', time: '09:00' },
    })
  })

  it('is open from the opening minute and reports when it closes', () => {
    assert.deepEqual(evaluateAvailability(daytime, at(THU, '09:00')), {
      open: true,
      closesAt: '18:00',
      nextOpensAt: null,
    })
    assert.equal(evaluateAvailability(daytime, at(THU, '17:59')).open, true)
  })

  it('is closed from the closing minute and points at the next day', () => {
    assert.deepEqual(evaluateAvailability(daytime, at(THU, '18:00')), {
      open: false,
      closesAt: null,
      nextOpensAt: { day: 'friday', time: '09:00' },
    })
  })

  it('skips a weekday with no hours', () => {
    const weekdays = every(h('09:00'), h('18:00'), [MON, TUE, 2, THU, FRI])
    assert.deepEqual(evaluateAvailability(weekdays, at(SAT, '12:00')), {
      open: false,
      closesAt: null,
      nextOpensAt: { day: 'monday', time: '09:00' },
    })
    assert.equal(evaluateAvailability(weekdays, at(SUN, '23:59')).nextOpensAt?.day, 'monday')
  })

  it('handles hours that run past midnight', () => {
    const late = every(h('11:00'), h('02:00'))
    assert.deepEqual(evaluateAvailability(late, at(TUE, '01:00')), {
      open: true,
      closesAt: '02:00',
      nextOpensAt: null,
    })
    assert.equal(evaluateAvailability(late, at(TUE, '23:00')).open, true)
    assert.deepEqual(evaluateAvailability(late, at(TUE, '02:00')), {
      open: false,
      closesAt: null,
      nextOpensAt: { day: 'tuesday', time: '11:00' },
    })
  })

  it('carries hours that run past midnight on Sunday into Monday', () => {
    const sundayNight = every(h('22:00'), h('02:00'), [SUN])
    assert.deepEqual(evaluateAvailability(sundayNight, at(MON, '01:00')), {
      open: true,
      closesAt: '02:00',
      nextOpensAt: null,
    })
  })

  it('has no closing time when open around the clock', () => {
    const allDay = every(0, 1440)
    assert.deepEqual(evaluateAvailability(allDay, at(SAT, '03:33')), {
      open: true,
      closesAt: null,
      nextOpensAt: null,
    })
  })

  it('joins back to back days into one stretch', () => {
    const hours: DayHours[] = [
      { day: MON, opens: 0, closes: 1440 },
      { day: TUE, opens: 0, closes: h('06:00') },
    ]
    assert.equal(evaluateAvailability(hours, at(MON, '12:00')).closesAt, '06:00')
  })

  it('reports 24:00 for a supplier that closes at midnight', () => {
    const evening = every(h('18:00'), 1440)
    assert.equal(evaluateAvailability(evening, at(FRI, '20:00')).closesAt, '24:00')
  })

  it('is closed with no next opening when there are no hours', () => {
    assert.deepEqual(evaluateAvailability([], at(MON, '12:00')), {
      open: false,
      closesAt: null,
      nextOpensAt: null,
    })
  })
})

describe('toLocalMoment', () => {
  it('reads the campus clock, not the server clock', () => {
    // 04:00 UTC is noon in Singapore.
    assert.deepEqual(toLocalMoment(new Date('2026-10-01T04:00:00Z'), 'Asia/Singapore'), {
      day: THU,
      minute: 720,
    })
  })

  it('moves to the next weekday when the offset crosses midnight', () => {
    assert.deepEqual(toLocalMoment(new Date('2026-10-01T17:00:00Z'), 'Asia/Singapore'), {
      day: FRI,
      minute: 60,
    })
  })

  it('reports midnight as minute 0', () => {
    assert.deepEqual(toLocalMoment(new Date('2026-10-01T16:00:00Z'), 'Asia/Singapore'), {
      day: FRI,
      minute: 0,
    })
  })
})

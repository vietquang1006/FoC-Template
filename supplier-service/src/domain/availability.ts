import { WEEKDAYS, type DayHours, type Weekday } from './supplier.ts'
import { MINUTES_PER_DAY, formatClock } from './time.ts'

const WEEK = 7 * MINUTES_PER_DAY
const SHORT_WEEKDAYS: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
}

// A point in time as seen on the campus clock. `day` 0 is Monday.
export interface LocalMoment {
  day: number
  minute: number
}

export interface Availability {
  open: boolean
  // Local closing time when open. Null when open with no closing time, which
  // is the case for a supplier that is open around the clock.
  closesAt: string | null
  // Next opening when closed, null when the supplier has no opening hours.
  nextOpensAt: { day: Weekday; time: string } | null
}

const formatters = new Map<string, Intl.DateTimeFormat>()

export function toLocalMoment(at: Date, timeZone: string): LocalMoment {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    })
    formatters.set(timeZone, formatter)
  }
  let day = 0
  let hour = 0
  let minute = 0
  for (const part of formatter.formatToParts(at)) {
    if (part.type === 'weekday') day = SHORT_WEEKDAYS[part.value] ?? 0
    else if (part.type === 'hour') hour = Number(part.value)
    else if (part.type === 'minute') minute = Number(part.value)
  }
  return { day, minute: hour * 60 + minute }
}

// Works on a timeline of minutes since Monday 00:00, using the week before and
// the week after as well so that windows running past midnight, past Sunday
// night, or back to back across days join up into one stretch of opening time.
function openStretches(hours: DayHours[]): [number, number][] {
  const windows: [number, number][] = []
  for (const week of [-1, 0, 1]) {
    for (const h of hours) {
      const start = week * WEEK + h.day * MINUTES_PER_DAY + h.opens
      const length =
        h.closes > h.opens ? h.closes - h.opens : h.closes + MINUTES_PER_DAY - h.opens
      windows.push([start, start + length])
    }
  }
  windows.sort((a, b) => a[0] - b[0])
  const stretches: [number, number][] = []
  for (const [start, end] of windows) {
    const last = stretches[stretches.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else stretches.push([start, end])
  }
  return stretches
}

// A supplier is open from its opening time up to, but not including, its
// closing time.
export function evaluateAvailability(hours: DayHours[], now: LocalMoment): Availability {
  const stretches = openStretches(hours)
  const t = now.day * MINUTES_PER_DAY + now.minute

  const current = stretches.find(([start, end]) => start <= t && t < end)
  if (current) {
    const end = current[1]
    if (end - t >= WEEK) return { open: true, closesAt: null, nextOpensAt: null }
    const clock = ((end % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
    return {
      open: true,
      closesAt: formatClock(clock === 0 ? MINUTES_PER_DAY : clock),
      nextOpensAt: null,
    }
  }

  const next = stretches.find(([start]) => start > t)
  if (!next) return { open: false, closesAt: null, nextOpensAt: null }
  const day = Math.floor(next[0] / MINUTES_PER_DAY)
  return {
    open: false,
    closesAt: null,
    nextOpensAt: {
      day: WEEKDAYS[((day % 7) + 7) % 7]!,
      time: formatClock(((next[0] % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY),
    },
  }
}

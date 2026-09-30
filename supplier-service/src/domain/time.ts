const CLOCK = /^(?:([01]\d|2[0-3]):([0-5]\d)|(24):(00))$/

export const MINUTES_PER_DAY = 1440

// "HH:MM" from 00:00 to 24:00, or null when the text is not a valid clock time.
export function parseClock(text: string): number | null {
  const match = CLOCK.exec(text)
  if (!match) return null
  const hours = Number(match[1] ?? match[3])
  const minutes = Number(match[2] ?? match[4])
  return hours * 60 + minutes
}

export function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

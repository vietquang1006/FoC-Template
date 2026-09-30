export const SUPPLIER_STATUSES = ['Active', 'Inactive'] as const
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number]

// The position in this list is the day number stored in the database.
export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const
export type Weekday = (typeof WEEKDAYS)[number]

// Times are minutes after local midnight. `closes` may be 1440 for midnight at
// the end of the day, and a `closes` before `opens` means the window runs past
// midnight into the next day. A weekday with no entry is closed all day.
export interface DayHours {
  day: number
  opens: number
  closes: number
}

export interface SupplierInput {
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
  status: SupplierStatus
  hours: DayHours[]
}

export interface Supplier extends SupplierInput {
  id: string
  createdAt: Date
  updatedAt: Date
}

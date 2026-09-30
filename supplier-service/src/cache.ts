interface Entry<V> {
  value: Promise<V>
  expires: number
}

// Remembers the answer to a question for a short time. Callers that ask the same
// question while it is being answered share that one answer, so a burst of
// identical requests costs a single trip to the database.
export class TtlCache<V> {
  private entries = new Map<string, Entry<V>>()
  private ttlMs: number
  private maxEntries: number
  private clock: () => number

  // A ttl of zero turns the cache off.
  constructor(ttlMs: number, maxEntries = 1000, clock: () => number = Date.now) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.clock = clock
  }

  // `keep` decides whether an answer is worth remembering. An answer that is
  // refused by it, and any failure, is forgotten straight away.
  get(key: string, load: () => Promise<V>, keep: (value: V) => boolean = () => true): Promise<V> {
    if (this.ttlMs <= 0) return load()

    const now = this.clock()
    const hit = this.entries.get(key)
    if (hit && hit.expires > now) return hit.value

    const value = load()
    const entry = { value, expires: now + this.ttlMs }
    this.entries.set(key, entry)
    if (this.entries.size > this.maxEntries) {
      // A Map iterates oldest first.
      this.entries.delete(this.entries.keys().next().value!)
    }

    const forget = () => {
      if (this.entries.get(key) === entry) this.entries.delete(key)
    }
    value.then((v) => keep(v) || forget(), forget)
    return value
  }

  // Called after a change, so that nothing older than the change is served.
  clear(): void {
    this.entries.clear()
  }
}

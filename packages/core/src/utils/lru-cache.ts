export class LruCache<V> {
  private readonly map = new Map<string, { value: V; at: number }>()
  private readonly maxEntries: number
  private readonly ttlMs: number

  constructor(opts: { maxEntries: number; ttlMs?: number }) {
    this.maxEntries = opts.maxEntries
    this.ttlMs = opts.ttlMs ?? Infinity
  }

  get(key: string): V | null {
    const entry = this.map.get(key)
    if (!entry) return null
    if (Date.now() - entry.at > this.ttlMs) {
      this.map.delete(key)
      return null
    }
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  set(key: string, value: V): void {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, { value, at: Date.now() })
  }

  has(key: string): boolean {
    return this.get(key) !== null
  }

  get size(): number {
    return this.map.size
  }
}

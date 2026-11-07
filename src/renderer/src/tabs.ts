/** Ordered document identities; the editor state itself stays with each item. */
export class Tabs<T extends { path: string | null }> {
  readonly items: T[] = []
  active: T | null = null

  constructor(private readonly platform = 'darwin') {}

  find(path: string): T | undefined {
    const key = (p: string): string => this.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p
    return this.items.find(tab => tab.path !== null && key(tab.path) === key(path))
  }

  relative(delta: number): T | undefined {
    if (!this.items.length) return undefined
    const index = this.active ? this.items.indexOf(this.active) : 0
    return this.items[(index + delta + this.items.length) % this.items.length]
  }

  /** Index eight is the conventional last-tab shortcut. */
  at(index: number): T | undefined {
    return index === 8 ? this.items.at(-1) : this.items[index]
  }

  add(item: T): void {
    this.items.push(item)
    this.active = item
  }

  open(item: T, replaceable: (item: T) => boolean): T {
    const existing = item.path && this.find(item.path)
    if (existing) {
      this.active = existing
      return existing
    }
    const index = this.active === null ? -1 : this.items.indexOf(this.active)
    if (index >= 0 && replaceable(this.items[index])) {
      this.items[index] = item
      this.active = item
    } else this.add(item)
    return item
  }

  move(item: T, index: number): void {
    const old = this.items.indexOf(item)
    if (old < 0) return
    this.items.splice(old, 1)
    this.items.splice(Math.max(0, Math.min(index, this.items.length)), 0, item)
  }

  close(item: T): void {
    const index = this.items.indexOf(item)
    if (index < 0) return
    this.items.splice(index, 1)
    if (this.active === item) this.active = this.items[Math.min(index, this.items.length - 1)] ?? null
  }
}

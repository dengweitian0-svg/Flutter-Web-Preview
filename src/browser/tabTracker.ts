// Unknown-input tabs have no stable public identity. Never transfer ownership by timing alone.
export class TabTracker<T extends object> {
  private known = new Set<T>();
  private candidates = new Map<T, number>();
  private uncertain = false;
  current?: T;
  bind(tab: T, tabs: readonly T[]): void {
    this.current = tab; this.known = new Set(tabs); this.candidates.clear(); this.uncertain = false;
  }
  observe(tabs: readonly T[], isCandidate: (tab: T) => boolean, now: number): void {
    if (!this.current) return;
    const present = new Set(tabs);
    for (const tab of tabs) if (!this.known.has(tab) && tab !== this.current && isCandidate(tab)) this.candidates.set(tab, now);
    for (const [tab, time] of this.candidates) if (!present.has(tab) || !this.uncertain && now - time > 250) this.candidates.delete(tab);
    this.known = present;
  }
  reconcile(tabs: readonly T[]): 'present' | 'closed' | 'ambiguous' {
    if (!this.current || tabs.includes(this.current)) return 'present';
    const replacements = [...this.candidates.keys()].filter(tab => tabs.includes(tab));
    if (replacements.length > 0) { this.uncertain = true; return 'ambiguous'; }
    return 'closed';
  }
  clear(): void { this.current = undefined; this.known.clear(); this.candidates.clear(); this.uncertain = false; }
}

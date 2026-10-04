import type { EventSource, Disposable } from './types';
export class Signal<T> implements EventSource<T> {
  private readonly listeners = new Set<(event: T) => void>();
  subscribe(listener: (event: T) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }
  emit(event: T): void { for (const listener of [...this.listeners]) listener(event); }
  clear(): void { this.listeners.clear(); }
}

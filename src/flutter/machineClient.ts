import { Signal } from '../core/signal';

export interface MachineEvent { event: string; params: Record<string, unknown> }
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export class MachineClient {
  readonly events = new Signal<MachineEvent>();
  private buffer = '';
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  constructor(private readonly write: (text: string) => void, private readonly log: (text: string) => void) {}
  feed(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    if (this.buffer.length > 4 * 1024 * 1024) { this.close(new Error('Flutter emitted an oversized protocol line.')); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let messages: unknown;
      try { messages = JSON.parse(line); } catch { this.log(`${line}\n`); continue; }
      if (!Array.isArray(messages)) { this.log(`${line}\n`); continue; }
      for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        const item = message as Record<string, unknown>;
        if (typeof item.id === 'number') {
          const pending = this.pending.get(item.id);
          if (!pending) continue;
          clearTimeout(pending.timer); this.pending.delete(item.id);
          if (item.error !== undefined) pending.reject(new Error(`Flutter protocol error: ${JSON.stringify(item.error)}`));
          else pending.resolve(item.result);
        } else if (typeof item.event === 'string') {
          this.events.emit({ event: item.event, params: item.params && typeof item.params === 'object' ? item.params as Record<string, unknown> : {} });
        }
      }
    }
  }
  request(method: string, params: Record<string, unknown>, timeout: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Flutter protocol is closed.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeout} ms.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write(`${JSON.stringify([{ id, method, params }])}\n`); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  close(error = new Error('Flutter process ended.')): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.events.clear(); this.buffer = '';
  }
}

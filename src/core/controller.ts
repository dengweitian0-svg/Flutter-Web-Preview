import { Signal } from './signal';
import { transition } from './transition';
import { initialSnapshot, sessionId, type Disposable, type Effect, type FlutterRuntime, type PreviewBrowser, type SessionEvent, type Snapshot } from './types';

export class PreviewSessionController {
  private snapshot: Snapshot = initialSnapshot();
  private readonly events: SessionEvent[] = [];
  private processing = false;
  private readonly subscriptions: Disposable[];
  private debounce?: ReturnType<typeof setTimeout>;
  private startup?: ReturnType<typeof setTimeout>;
  private stopTask?: Promise<void>;
  private disposed = false;
  readonly changes = new Signal<Snapshot>();
  constructor(private readonly runtime: FlutterRuntime, private readonly browser: PreviewBrowser, private readonly report: (message: string) => void, private readonly log: (message: string) => void = () => {}) {
    this.subscriptions = [runtime.events.subscribe(e => this.dispatch(e)), browser.events.subscribe(e => this.dispatch(e))];
  }
  get current(): Snapshot { return this.snapshot; }
  dispatch(event: SessionEvent): void {
    if (this.disposed) return;
    this.events.push(event);
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.events.length) {
        const next = this.events.shift()!;
        const previous = this.snapshot.state.kind;
        const result = transition(this.snapshot, next);
        this.snapshot = { state: result.state, context: result.context };
        this.log(`${previous} --${next.type}--> ${result.state.kind}`);
        this.changes.emit(this.snapshot);
        for (const effect of result.effects) this.execute(effect);
      }
    } finally { this.processing = false; }
  }
  save(delay: number): void {
    const state = this.snapshot.state;
    if (!['starting', 'running', 'updating'].includes(state.kind)) return;
    this.dispatch({ type: 'SAVE' });
    if (state.kind !== 'running') return;
    if (this.debounce) clearTimeout(this.debounce);
    const id = sessionId(state);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      if (id === sessionId(this.snapshot.state)) this.dispatch({ type: 'UPDATE', reason: 'save' });
    }, delay);
  }
  private clearTimers(): void {
    clearTimeout(this.debounce); clearTimeout(this.startup);
    this.debounce = undefined; this.startup = undefined;
  }
  private execute(effect: Effect): void {
    switch (effect.type) {
      case 'CLEAR_TIMERS': this.clearTimers(); break;
      case 'DISPATCH': this.dispatch(effect.event); break;
      case 'REPORT': this.report(effect.message); break;
      case 'START': {
        this.startup = setTimeout(() => this.dispatch({ type: 'FATAL', sessionId: effect.sessionId, message: 'Flutter startup timed out. Check the output and run again.' }), effect.spec.startupTimeout);
        void this.runtime.start(effect.sessionId, effect.spec).catch(error => this.dispatch({ type: 'FATAL', sessionId: effect.sessionId, message: String(error) }));
        break;
      }
      case 'STOP': this.stopTask = this.cleanup(effect.sessionId); break;
      case 'COMPILE':
        void this.runtime.recompile(effect.session.sessionId, effect.reason, effect.session.spec.reloadTimeout).then(result => this.dispatch({ type: 'COMPILED', sessionId: effect.session.sessionId, operationId: effect.operationId, ...result }), error => this.dispatch({ type: 'FATAL', sessionId: effect.session.sessionId, message: String(error) }));
        break;
      case 'OPEN':
        void this.browser.open(effect.sessionId, effect.url).catch(error => this.dispatch({ type: 'BROWSER_ERROR', sessionId: effect.sessionId, message: String(error) }));
        break;
      case 'REFRESH':
        void this.browser.refresh(effect.sessionId).catch(error => this.dispatch({ type: 'BROWSER_ERROR', sessionId: effect.sessionId, message: String(error) }));
        break;
    }
  }
  private async cleanup(id: string): Promise<void> {
    try {
      await this.runtime.stop(id);
      await this.browser.release(id);
      this.dispatch({ type: 'CLEANED', sessionId: id });
    } catch (error) { this.dispatch({ type: 'CLEANUP_FAILED', sessionId: id, message: String(error) }); }
  }
  async stop(): Promise<void> {
    const retry = this.snapshot.state.kind === 'stopping';
    this.dispatch({ type: 'STOP' });
    if (retry) this.stopTask = this.cleanup(sessionId(this.snapshot.state)!);
    await this.stopTask;
  }
  async dispose(): Promise<void> {
    await this.stop();
    this.clearTimers();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.disposed = true;
    this.changes.clear();
  }
}

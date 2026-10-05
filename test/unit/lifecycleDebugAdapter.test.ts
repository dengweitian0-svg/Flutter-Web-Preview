import { describe, expect, it, vi } from 'vitest';
import { Signal } from '../../src/core/signal';
import type { DebugProtocolMessage } from 'vscode';
import { LifecycleDebugAdapter } from '../../src/browser/lifecycleDebugAdapter';

vi.mock('vscode', () => ({ EventEmitter: class {
  private readonly signal = new Signal<DebugProtocolMessage>();
  readonly event = (listener: (message: DebugProtocolMessage) => void) => this.signal.subscribe(listener);
  fire(message: DebugProtocolMessage) { this.signal.emit(message); }
  dispose() { this.signal.clear(); }
} }));
function setup(launch = true) {
  const stop = vi.fn(); const adapter = new LifecycleDebugAdapter('preview-1', stop);
  const messages: Record<string, unknown>[] = []; adapter.onDidSendMessage(message => messages.push(message as unknown as Record<string, unknown>));
  let sequence = 0;
  const request = (command: string) => adapter.handleMessage({ type: 'request', seq: ++sequence, command } as DebugProtocolMessage);
  request('initialize'); if (launch) request('launch');
  const outputs = () => messages.filter(message => message.event === 'output').map(message => String((message.body as { output: string }).output));
  return { adapter, stop, messages, request, outputs };
}
describe('preview lifecycle console protocol', () => {
  it('publishes exactly one confirmed exit before terminating its own console', () => {
    const app = setup(); app.adapter.report({ cleaned: true }); app.adapter.report({ cleaned: true });
    expect(app.outputs().filter(text => text.includes('exit:'))).toEqual(['[Flutter Web Preview] exit: preview-1 ended; Flutter stopped.\n']);
    const exit = app.messages.findIndex(message => message.event === 'output' && JSON.stringify(message.body).includes('exit:'));
    expect(app.messages.findIndex(message => message.event === 'terminated')).toBeGreaterThan(exit);
    expect(app.stop).not.toHaveBeenCalled(); app.adapter.dispose(); expect(app.stop).not.toHaveBeenCalled();
  });
  it('defers stop acknowledgement until cleanup, keeping failure visible without a false exit', () => {
    const app = setup(); app.request('disconnect'); app.request('terminate'); expect(app.stop).toHaveBeenCalledTimes(1);
    app.adapter.report({ cleaned: false, failure: 'Process still alive' });
    expect(app.outputs().some(text => text.includes('stop failed: Process still alive'))).toBe(true);
    expect(app.outputs().some(text => text.includes('exit:'))).toBe(false);
    expect(app.messages.some(message => message.event === 'terminated')).toBe(false);
    expect(app.messages.some(message => message.type === 'response' && message.command === 'disconnect')).toBe(false);
    app.adapter.report({ cleaned: true });
    for (const command of ['disconnect', 'terminate']) expect(app.messages.filter(message => message.type === 'response' && message.command === command)).toHaveLength(1);
    expect(app.outputs().filter(text => text.includes('exit:'))).toHaveLength(1);
  });
  it('retains completion arriving during startup until the console is launched', () => {
    const app = setup(false); app.adapter.report({ cleaned: true }); expect(app.outputs()).toEqual([]);
    app.request('launch'); expect(app.outputs()).toHaveLength(2);
    expect(app.outputs()[0]).toContain('start: preview-1'); expect(app.outputs()[1]).toContain('exit: preview-1');
  });
  it('preserves an abnormal exit reason without inventing an exit code', () => {
    const app = setup(); app.adapter.report({ cleaned: true, failure: 'Flutter exited unexpectedly (code 1)' });
    expect(app.outputs().at(-1)).toContain('Reason: Flutter exited unexpectedly (code 1)');
    expect(app.outputs().at(-1)).not.toContain('code 0');
  });
  it('forced disposal requests cleanup without claiming completion', () => {
    const app = setup(); app.adapter.dispose(); app.adapter.dispose();
    expect(app.stop).toHaveBeenCalledTimes(1); expect(app.outputs().some(text => text.includes('exit:'))).toBe(false);
  });
});

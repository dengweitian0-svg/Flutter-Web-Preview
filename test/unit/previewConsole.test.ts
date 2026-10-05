import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DebugAdapter, DebugAdapterDescriptorFactory, DebugProtocolMessage, DebugSession } from 'vscode';
import { Signal } from '../../src/core/signal';
import { PreviewConsole } from '../../src/browser/previewConsole';

const broker = vi.hoisted(() => ({
  factory: undefined as DebugAdapterDescriptorFactory | undefined,
  ends: new Set<(session: DebugSession) => void>(), start: vi.fn(),
}));
vi.mock('vscode', () => ({
  EventEmitter: class {
    private readonly signal = new Signal<DebugProtocolMessage>();
    readonly event = (listener: (message: DebugProtocolMessage) => void) => this.signal.subscribe(listener);
    fire(message: DebugProtocolMessage) { this.signal.emit(message); }
    dispose() { this.signal.clear(); }
  },
  DebugAdapterInlineImplementation: class { constructor(readonly implementation: DebugAdapter) {} },
  DebugConsoleMode: { Separate: 0 },
  debug: {
    registerDebugAdapterDescriptorFactory: (_type: string, factory: DebugAdapterDescriptorFactory) => { broker.factory = factory; return { dispose: () => { broker.factory = undefined; } }; },
    onDidTerminateDebugSession: (listener: (session: DebugSession) => void) => { broker.ends.add(listener); return { dispose: () => broker.ends.delete(listener) }; },
    startDebugging: broker.start,
  },
}));
const consoles: PreviewConsole[] = [];
const messages = new Map<string, Record<string, unknown>[]>();
const adapters = new Map<string, DebugAdapter>();
let sequence = 0;
beforeEach(() => {
  vi.clearAllMocks(); messages.clear(); adapters.clear();
  broker.start.mockImplementation(async (_folder, configuration) => {
    const session = { id: `console-${++sequence}`, configuration } as DebugSession;
    const descriptor = await broker.factory!.createDebugAdapterDescriptor(session, undefined) as unknown as { implementation: DebugAdapter };
    const adapter = descriptor.implementation;
    messages.set(session.id, []); adapters.set(session.id, adapter);
    adapter.onDidSendMessage(value => {
      const message = value as unknown as Record<string, unknown>; messages.get(session.id)!.push(message);
      if (message.event === 'terminated') for (const listener of broker.ends) listener(session);
    });
    adapter.handleMessage({ seq: 1, type: 'request', command: 'initialize' } as DebugProtocolMessage);
    adapter.handleMessage({ seq: 2, type: 'request', command: 'launch' } as DebugProtocolMessage);
    return true;
  });
});
afterEach(() => { for (const console of consoles.splice(0)) console.dispose(); });
function setup() { const console = new PreviewConsole(vi.fn()); consoles.push(console); const stops = vi.fn(); console.events.subscribe(stops); return { console, stops }; }
function output(id: string) { return messages.get(id)!.filter(message => message.event === 'output').map(message => String((message.body as { output: string }).output)).join(''); }

describe('owned persistent preview consoles', () => {
  it('ignores termination of a child even if it carries copied parent metadata', async () => {
    const { console, stops } = setup(); const session = (await console.ensure('preview-1'))!;
    const child = { id: 'child', parentSession: session, configuration: { ...session.configuration, type: 'pwa-editor-browser' } } as DebugSession;
    for (const listener of broker.ends) listener(child);
    expect(stops).not.toHaveBeenCalled(); expect(await console.ensure('preview-1')).toBe(session);
    console.reportLifecycle('preview-1', { cleaned: true }); expect(output(session.id)).toContain('exit:');
  });
  it('reuses a console per preview and routes late completion only to its original session', async () => {
    const { console } = setup(); const first = (await console.ensure('preview-1'))!;
    expect(await console.ensure('preview-1')).toBe(first);
    console.reportLifecycle('preview-1', { cleaned: true });
    const second = (await console.ensure('preview-2'))!;
    console.reportLifecycle('preview-1', { cleaned: true });
    expect(output(first.id).match(/exit:/g)).toHaveLength(1);
    expect(output(second.id)).not.toContain('exit:'); expect(output(second.id)).not.toContain('preview-1');
    expect(broker.start).toHaveBeenCalledTimes(2);
  });
  it('keeps failed cleanup visible in a live console until a successful retry', async () => {
    const { console, stops } = setup(); const session = (await console.ensure('preview-1'))!;
    adapters.get(session.id)!.handleMessage({ seq: 3, type: 'request', command: 'terminate' } as DebugProtocolMessage);
    console.reportLifecycle('preview-1', { cleaned: false, failure: 'Cannot stop process' });
    expect(output(session.id)).toContain('stop failed:'); expect(output(session.id)).not.toContain('exit:');
    expect(await console.ensure('preview-1')).toBe(session);
    console.reportLifecycle('preview-1', { cleaned: true }); expect(output(session.id)).toContain('exit:');
    expect(stops).toHaveBeenCalledExactlyOnceWith({ type: 'LOG_CONSOLE_STOP_REQUEST', sessionId: 'preview-1' });
  });
  it('does not turn a console startup failure into a request to stop the preview', async () => {
    const { console, stops } = setup(); broker.start.mockRejectedValueOnce(new Error('Debugger disabled'));
    await expect(console.ensure('preview-1')).rejects.toThrow('Debugger disabled');
    expect(stops).not.toHaveBeenCalled(); expect(await console.ensure('preview-1')).toBeDefined();
  });
});

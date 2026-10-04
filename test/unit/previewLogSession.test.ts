import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DebugSession } from 'vscode';
import { PreviewLogSession } from '../../src/browser/previewLogSession';

const debug = vi.hoisted(() => ({
  starts: new Set<(session: DebugSession) => void>(),
  ends: new Set<(session: DebugSession) => void>(),
  startDebugging: vi.fn(), stopDebugging: vi.fn(), getExtension: vi.fn(),
}));
vi.mock('vscode', () => ({
  debug: {
    startDebugging: debug.startDebugging, stopDebugging: debug.stopDebugging,
    onDidStartDebugSession: (listener: (session: DebugSession) => void) => { debug.starts.add(listener); return { dispose: () => debug.starts.delete(listener) }; },
    onDidTerminateDebugSession: (listener: (session: DebugSession) => void) => { debug.ends.add(listener); return { dispose: () => debug.ends.delete(listener) }; },
  },
  extensions: { getExtension: debug.getExtension }, DebugConsoleMode: { Separate: 0 },
}));
let sequence = 0;
const started: DebugSession[] = [];
function start(configuration: DebugSession['configuration'], parentSession?: DebugSession): DebugSession {
  const session = { id: `debug-${++sequence}`, configuration, parentSession } as DebugSession;
  started.push(session); for (const listener of debug.starts) listener(session); return session;
}
function end(session: DebugSession) { for (const listener of debug.ends) listener(session); }
const adapters: PreviewLogSession[] = [];
function setup() {
  const adapter = new PreviewLogSession(vi.fn()); adapters.push(adapter);
  const events = vi.fn(); adapter.events.subscribe(events); return { adapter, events };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); started.length = 0;
  debug.getExtension.mockReturnValue({});
  debug.startDebugging.mockImplementation(async (_folder, configuration) => { start(configuration); return true; });
  debug.stopDebugging.mockImplementation(async session => end(session));
});
afterEach(async () => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
  await vi.advanceTimersByTimeAsync(0); vi.useRealTimers();
});

describe('owned browser log sessions', () => {
  it('attaches once to the preview URL without breakpoints, saving files, or opening the debug view', async () => {
    const { adapter, events } = setup();
    await adapter.attach('preview-1', 'tab-1', 'http://127.0.0.1:7357/');
    await adapter.attach('preview-1', 'tab-1', 'http://127.0.0.1:7357/');
    expect(debug.startDebugging).toHaveBeenCalledTimes(1);
    expect(debug.startDebugging).toHaveBeenCalledWith(undefined, expect.objectContaining({
      type: 'editor-browser', request: 'attach', urlFilter: 'http://127.0.0.1:7357/*', noDebug: true, outputCapture: 'console', internalConsoleOptions: 'openOnSessionStart',
    }), expect.objectContaining({ suppressSaveBeforeStart: true, suppressDebugToolbar: true, suppressDebugStatusbar: true, suppressDebugView: true }));
    expect(events).toHaveBeenCalledWith({ type: 'LOG_SESSION_STARTED', sessionId: 'preview-1', bindingId: 'tab-1' });
  });
  it('reports user termination only for its root session, ignoring children and other debuggers', async () => {
    const { adapter, events } = setup(); await adapter.attach('preview-1', 'tab-1', 'http://127.0.0.1:7357/');
    const root = started[0]!; const child = start(root.configuration, root);
    end(child); end({ id: 'unrelated', configuration: {} } as DebugSession);
    expect(events).toHaveBeenCalledTimes(1);
    end(root);
    expect(events).toHaveBeenLastCalledWith({ type: 'LOG_SESSION_ENDED', sessionId: 'preview-1', bindingId: 'tab-1' });
  });
  it('does not report termination on release, and cannot release another preview', async () => {
    const { adapter, events } = setup(); await adapter.attach('preview-1', 'tab-1', 'http://127.0.0.1:7357/');
    await adapter.release('other'); expect(debug.stopDebugging).not.toHaveBeenCalled();
    await adapter.release('preview-1'); await adapter.release('preview-1');
    expect(debug.stopDebugging).toHaveBeenCalledExactlyOnceWith(started[0]);
    expect(events).toHaveBeenCalledTimes(1);
  });
  it('cancels an in-flight launch and releases its session when it arrives', async () => {
    let finish!: () => void;
    debug.startDebugging.mockImplementation((_folder, configuration) => new Promise<boolean>(resolve => { finish = () => { start(configuration); resolve(true); }; }));
    const { adapter, events } = setup(); const pending = adapter.attach('preview-1', 'tab-1', 'http://127.0.0.1:7357/');
    await adapter.release('preview-1'); finish(); await pending;
    expect(debug.stopDebugging).toHaveBeenCalledExactlyOnceWith(started[0]); expect(events).not.toHaveBeenCalled();
  });
  it('retains a failed cleanup so Stop can retry releasing the owned session', async () => {
    const { adapter, events } = setup(); await adapter.attach('preview-1', 'tab-1', 'http://127.0.0.1:7357/');
    debug.stopDebugging.mockRejectedValueOnce(new Error('Transport failed'));
    await expect(adapter.release('preview-1')).rejects.toThrow('Transport failed');
    await adapter.release('preview-1');
    expect(debug.stopDebugging).toHaveBeenCalledTimes(2); expect(events).toHaveBeenCalledTimes(1);
  });
  it('rebinds to a new tab and ignores a late old termination', async () => {
    const { adapter, events } = setup(); await adapter.attach('preview-1', 'tab-1', 'http://127.0.0.1:7357/');
    const old = started[0]!;
    await adapter.attach('preview-1', 'tab-2', 'http://127.0.0.1:7357/'); end(old);
    expect(debug.startDebugging).toHaveBeenCalledTimes(2);
    expect(events.mock.calls.map(([event]) => event.type)).toEqual(['LOG_SESSION_STARTED', 'LOG_SESSION_STARTED']);
    end(started[1]!); expect(events).toHaveBeenLastCalledWith({ type: 'LOG_SESSION_ENDED', sessionId: 'preview-1', bindingId: 'tab-2' });
  });
  it.each([false, 'throw', 'disabled'])('keeps failed attachment %s recoverable', async failure => {
    if (failure === 'disabled') debug.getExtension.mockReturnValue(undefined);
    else debug.startDebugging.mockImplementation(async () => { if (failure === 'throw') throw new Error('disabled'); return false; });
    const { adapter, events } = setup(); await adapter.attach('preview-1', 'tab-1', 'http://127.0.0.1:7357/');
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'LOG_SESSION_ERROR', sessionId: 'preview-1', bindingId: 'tab-1' }));
    debug.getExtension.mockReturnValue({}); debug.startDebugging.mockImplementation(async (_folder, config) => { start(config); return true; });
    await adapter.attach('preview-1', 'tab-1', 'http://127.0.0.1:7357/');
    expect(events).toHaveBeenLastCalledWith({ type: 'LOG_SESSION_STARTED', sessionId: 'preview-1', bindingId: 'tab-1' });
  });
  it('times out without stopping the preview and still releases a late session', async () => {
    let finish!: () => void;
    debug.startDebugging.mockImplementation((_folder, config) => new Promise<boolean>(resolve => { finish = () => { start(config); resolve(true); }; }));
    const { adapter, events } = setup(); const pending = adapter.attach('preview-1', 'tab-1', 'http://127.0.0.1:7357/');
    await vi.advanceTimersByTimeAsync(15000); await pending;
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'LOG_SESSION_ERROR', message: expect.stringContaining('timed out') }));
    adapter.dispose(); await vi.advanceTimersByTimeAsync(0); finish(); await vi.advanceTimersByTimeAsync(0);
    expect(debug.stopDebugging).toHaveBeenCalledExactlyOnceWith(started[0]);
  });
});

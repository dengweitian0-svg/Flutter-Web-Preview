import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewSessionController } from '../../src/core/controller';
import { Signal } from '../../src/core/signal';
import type { BrowserEvent, CompileResult, FlutterRuntime, LaunchSpec, PreviewBrowser, RuntimeEvent } from '../../src/core/types';

const spec: LaunchSpec = { projectRoot: 'D:/app', entrypoint: 'lib/main.dart', sdkPath: 'D:/flutter', port: 7357, startupTimeout: 10000, reloadTimeout: 3000 };
function setup() {
  let finishCompile: (result: CompileResult) => void = () => {};
  let finishStop: () => void = () => {};
  const runtime = { events: new Signal<RuntimeEvent>(), start: vi.fn(async () => {}), recompile: vi.fn(() => new Promise<CompileResult>(resolve => { finishCompile = resolve; })), stop: vi.fn(() => new Promise<void>(resolve => { finishStop = resolve; })) } satisfies FlutterRuntime;
  const browser = { events: new Signal<BrowserEvent>(), open: vi.fn(async () => { browser.events.emit({ type: 'BROWSER_OPENED', sessionId: 'preview-1', bindingId: 'tab' }); }), refresh: vi.fn(async () => {}), release: vi.fn(async () => {}), reportLifecycle: vi.fn() } satisfies PreviewBrowser;
  const report = vi.fn();
  const controller = new PreviewSessionController(runtime, browser, report);
  controller.dispatch({ type: 'RUN', spec });
  runtime.events.emit({ type: 'APP_ID', sessionId: 'preview-1', appId: 'app' });
  runtime.events.emit({ type: 'URL', sessionId: 'preview-1', url: 'http://127.0.0.1:7357' });
  runtime.events.emit({ type: 'STARTED', sessionId: 'preview-1' });
  return { controller, runtime, browser, report, compile: (result: CompileResult) => finishCompile(result), finishStop: () => finishStop() };
}
afterEach(() => vi.useRealTimers());
describe('update scheduling and cleanup', () => {
  it('a manual update consumes a pending save without a redundant compilation', async () => {
    vi.useFakeTimers(); const app = setup();
    app.controller.save(300);
    await vi.advanceTimersByTimeAsync(100);
    app.controller.dispatch({ type: 'UPDATE', reason: 'manual' });
    app.compile({ code: 0 }); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(app.runtime.recompile).toHaveBeenCalledTimes(1);
    const cleanup = app.controller.dispose(); app.finishStop(); await cleanup;
  });
  it('reports exit only after both process and browser cleanup have completed', async () => {
    const app = setup(); let finishBrowser!: () => void;
    app.browser.release.mockImplementation(() => new Promise<void>(resolve => { finishBrowser = resolve; }));
    const stopped = app.controller.stop();
    expect(app.browser.reportLifecycle).not.toHaveBeenCalled();
    app.finishStop(); await Promise.resolve(); await Promise.resolve();
    expect(app.browser.release).toHaveBeenCalled(); expect(app.browser.reportLifecycle).not.toHaveBeenCalled();
    finishBrowser(); await stopped;
    expect(app.browser.reportLifecycle).toHaveBeenCalledExactlyOnceWith('preview-1', { cleaned: true, failure: undefined });
    await app.controller.stop(); expect(app.browser.reportLifecycle).toHaveBeenCalledTimes(1);
  });
  it('does not let a console output failure undo confirmed process cleanup', async () => {
    const app = setup(); app.browser.reportLifecycle.mockImplementation(() => { throw new Error('Console disconnected'); });
    const stopped = app.controller.stop(); app.finishStop(); await stopped;
    expect(app.controller.current.state.kind).toBe('stopped'); await app.controller.dispose();
  });
  it('reports browser cleanup failure without exit and completes only after a successful retry', async () => {
    const app = setup(); app.runtime.stop.mockImplementation(async () => {});
    app.browser.release.mockRejectedValueOnce(new Error('Debugger still attached'));
    await expect(app.controller.stop()).rejects.toThrow('cleanup did not complete');
    expect(app.browser.reportLifecycle).toHaveBeenCalledExactlyOnceWith('preview-1', { cleaned: false, failure: 'Error: Debugger still attached' });
    await app.controller.stop();
    expect(app.browser.reportLifecycle).toHaveBeenLastCalledWith('preview-1', { cleaned: true, failure: undefined });
    expect(app.controller.current.state.kind).toBe('stopped'); await app.controller.dispose();
  });
  it('debounces saves and performs one extra compile for saves during compilation', async () => {
    vi.useFakeTimers();
    const app = setup();
    app.controller.save(300); await vi.advanceTimersByTimeAsync(200); app.controller.save(300);
    await vi.advanceTimersByTimeAsync(299); expect(app.runtime.recompile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(app.runtime.recompile).toHaveBeenCalledTimes(1);
    app.controller.save(300); app.controller.save(300);
    app.compile({ code: 0 }); await Promise.resolve();
    expect(app.runtime.recompile).toHaveBeenCalledTimes(2);
    app.compile({ code: 0 }); await Promise.resolve();
    expect(app.runtime.recompile).toHaveBeenCalledTimes(2);
    const cleanup = app.controller.dispose(); app.finishStop(); await cleanup;
  });
  it('browser close immediately cancels debounce and late compiler results', async () => {
    vi.useFakeTimers(); const app = setup();
    app.controller.save(300); await vi.advanceTimersByTimeAsync(300);
    app.browser.events.emit({ type: 'BROWSER_CLOSED', sessionId: 'preview-1', bindingId: 'tab' });
    expect(app.controller.current.state.kind).toBe('stopping');
    app.compile({ code: 0 }); await Promise.resolve();
    expect(app.browser.refresh).not.toHaveBeenCalled();
    app.finishStop(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(app.controller.current.state.kind).toBe('stopped');
    app.controller.save(300); await vi.advanceTimersByTimeAsync(1000);
    expect(app.runtime.recompile).toHaveBeenCalledTimes(1);
    await app.controller.dispose();
  });
  it('startup timeout initiates cleanup instead of claiming a successful stop', async () => {
    vi.useFakeTimers();
    const runtime = { events: new Signal<RuntimeEvent>(), start: vi.fn(async () => {}), recompile: vi.fn(async () => ({ code: 0 })), stop: vi.fn(async () => {}) };
    const browser = { events: new Signal<BrowserEvent>(), open: vi.fn(async () => {}), refresh: vi.fn(async () => {}), release: vi.fn(async () => {}), reportLifecycle: vi.fn() };
    const controller = new PreviewSessionController(runtime, browser, vi.fn());
    controller.dispatch({ type: 'RUN', spec }); await vi.advanceTimersByTimeAsync(10000);
    expect(runtime.stop).toHaveBeenCalledTimes(1); expect(controller.current.state.kind).toBe('failed');
    await controller.dispose();
  });
  it('invalid runtime configuration returns to running without losing the update queue', async () => {
    const runtime = { events: new Signal<RuntimeEvent>(), start: vi.fn(async () => {}), recompile: vi.fn(async () => ({ code: 0 })), stop: vi.fn(async () => {}) };
    const browser = { events: new Signal<BrowserEvent>(), open: vi.fn(async () => {}), refresh: vi.fn(async () => {}), release: vi.fn(async () => {}), reportLifecycle: vi.fn() };
    const controller = new PreviewSessionController(runtime, browser, vi.fn(), vi.fn(), () => { throw new Error('Invalid reloadTimeout'); });
    controller.dispatch({ type: 'RUN', spec });
    runtime.events.emit({ type: 'APP_ID', sessionId: 'preview-1', appId: 'app' });
    runtime.events.emit({ type: 'URL', sessionId: 'preview-1', url: 'http://127.0.0.1:7357' });
    runtime.events.emit({ type: 'STARTED', sessionId: 'preview-1' });
    controller.dispatch({ type: 'UPDATE', reason: 'manual' });
    expect(controller.current.state).toMatchObject({ kind: 'running', lastError: 'Error: Invalid reloadTimeout' });
    expect(runtime.recompile).not.toHaveBeenCalled();
    await controller.dispose();
  });
  it('does not resolve Stop or dispose successfully when cleanup failed', async () => {
    const runtime = { events: new Signal<RuntimeEvent>(), start: vi.fn(async () => {}), recompile: vi.fn(async () => ({ code: 0 })), stop: vi.fn(async (): Promise<void> => { throw new Error('Access denied'); }) };
    const browser = { events: new Signal<BrowserEvent>(), open: vi.fn(async () => {}), refresh: vi.fn(async () => {}), release: vi.fn(async () => {}), reportLifecycle: vi.fn() };
    const controller = new PreviewSessionController(runtime, browser, vi.fn());
    controller.dispatch({ type: 'RUN', spec });
    await expect(controller.stop()).rejects.toThrow('cleanup did not complete');
    expect(controller.current.state.kind).toBe('stopping');
    expect(browser.release).not.toHaveBeenCalled();
    expect(browser.reportLifecycle).toHaveBeenCalledWith('preview-1', { cleaned: false, failure: 'Error: Access denied' });
    runtime.stop.mockImplementation(async () => {});
    await controller.dispose();
    expect(controller.current.state.kind).toBe('stopped');
    expect(browser.reportLifecycle).toHaveBeenLastCalledWith('preview-1', { cleaned: true, failure: undefined });
  });
  it('does not accept another launch while deactivation cleanup is pending', async () => {
    const app = setup();
    const disposed = app.controller.dispose();
    app.controller.dispatch({ type: 'RUN', spec: { ...spec, entrypoint: 'lib/other.dart' } });
    expect(app.controller.current.context.nextSpec).toBeUndefined();
    app.finishStop(); await disposed;
    expect(app.controller.current.state.kind).toBe('stopped');
    expect(app.runtime.start).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it } from 'vitest';
import { transition } from '../../src/core/transition';
import { initialSnapshot, type LaunchSpec, type SessionEvent, type Snapshot } from '../../src/core/types';

const spec: LaunchSpec = { projectRoot: 'D:/app', entrypoint: 'lib/main.dart', sdkPath: 'D:/flutter', port: 7357, startupTimeout: 180000, reloadTimeout: 30000 };
function step(snapshot: Snapshot, event: SessionEvent) { return transition(snapshot, event); }
function ready(): Snapshot {
  let value: Snapshot = step(initialSnapshot(), { type: 'RUN', spec });
  for (const event of [
    { type: 'URL', sessionId: 'preview-1', url: 'http://127.0.0.1:7357' },
    { type: 'APP_ID', sessionId: 'preview-1', appId: 'app' },
    { type: 'STARTED', sessionId: 'preview-1' },
    { type: 'BROWSER_OPENED', sessionId: 'preview-1', bindingId: 'tab-1' },
  ] satisfies SessionEvent[]) value = step(value, event);
  return value;
}
describe('session transitions', () => {
  it('stopping the owned log session stops the preview, but stale log events do not', () => {
    expect(step(ready(), { type: 'LOG_SESSION_ENDED', sessionId: 'old', bindingId: 'tab-1' }).state.kind).toBe('running');
    expect(step(ready(), { type: 'LOG_SESSION_ENDED', sessionId: 'preview-1', bindingId: 'old' }).state.kind).toBe('running');
    const ended = step(ready(), { type: 'LOG_SESSION_ENDED', sessionId: 'preview-1', bindingId: 'tab-1' });
    expect(ended.state.kind).toBe('stopping'); expect(ended.effects.map(effect => effect.type)).toEqual(['CLEAR_TIMERS', 'STOP']);
    const restarting = step(ready(), { type: 'RESTART' });
    expect(step(restarting, { type: 'LOG_SESSION_ENDED', sessionId: 'preview-1', bindingId: 'tab-1' }).context.nextSpec).toEqual(spec);
  });
  it('log failures preserve preview and compilation; successful reconnect clears the warning', () => {
    const failure = step(ready(), { type: 'LOG_SESSION_ERROR', sessionId: 'preview-1', bindingId: 'tab-1', message: 'Attach failed' });
    expect(failure.state.kind).toBe('running'); expect(failure.context.logError).toBe('Attach failed');
    expect(failure.effects).toEqual([{ type: 'REPORT', message: 'Attach failed' }]);
    const update = step(failure, { type: 'UPDATE', reason: 'save' });
    expect(update.state.kind).toBe('updating');
    const done = step(update, { type: 'COMPILED', sessionId: 'preview-1', operationId: 2, code: 0 });
    expect(done.context.logError).toBe('Attach failed');
    const connected = step(done, { type: 'LOG_SESSION_STARTED', sessionId: 'preview-1', bindingId: 'tab-1' });
    expect(connected.context.logError).toBeUndefined(); expect(connected.context.logConsoleConnected).toBe(true);
    expect(step(connected, { type: 'LOG_SESSION_ERROR', sessionId: 'preview-1', bindingId: 'old', message: 'Stale' }).effects).toEqual([]);
  });
  it('opens URL before app.started, and only becomes ready when all startup facts arrive', () => {
    const start = step(initialSnapshot(), { type: 'RUN', spec });
    const url = step(start, { type: 'URL', sessionId: 'preview-1', url: 'http://127.0.0.1:7357' });
    expect(url.state.kind).toBe('starting');
    expect(url.effects).toContainEqual({ type: 'OPEN', sessionId: 'preview-1', url: 'http://127.0.0.1:7357' });
    expect(ready().state.kind).toBe('running');
  });
  it('merges repeated run without spawning another process', () => {
    const first = step(initialSnapshot(), { type: 'RUN', spec });
    expect(step(first, { type: 'RUN', spec }).effects).toEqual([]);
    expect(step(ready(), { type: 'RUN', spec }).effects.map(e => e.type)).toEqual(['OPEN']);
  });
  it('only successful current operation can refresh', () => {
    const update = step(ready(), { type: 'UPDATE', reason: 'save' });
    expect(update.state.kind).toBe('updating');
    expect(step(update, { type: 'COMPILED', sessionId: 'preview-1', operationId: 999, code: 0 }).effects).toEqual([]);
    const done = step(update, { type: 'COMPILED', sessionId: 'preview-1', operationId: 2, code: 0 });
    expect(done.state.kind).toBe('running');
    expect(done.effects.some(e => e.type === 'REFRESH')).toBe(true);
  });
  it('compiler errors are recoverable and never refresh', () => {
    const update = step(ready(), { type: 'UPDATE', reason: 'manual' });
    const failure = step(update, { type: 'COMPILED', sessionId: 'preview-1', operationId: 2, code: 1, message: 'Invalid Dart' });
    expect(failure.state).toMatchObject({ kind: 'running', lastError: 'Invalid Dart' });
    expect(failure.effects.map(e => e.type)).toEqual(['REPORT']);
    expect(step(failure, { type: 'UPDATE', reason: 'save' }).state.kind).toBe('updating');
  });
  it('merges saves during compilation into one pending update', () => {
    const update = step(ready(), { type: 'UPDATE', reason: 'save' });
    const saved = step(step(update, { type: 'SAVE' }), { type: 'SAVE' });
    const done = step(saved, { type: 'COMPILED', sessionId: 'preview-1', operationId: 2, code: 0 });
    expect(done.effects.filter(e => e.type === 'DISPATCH')).toHaveLength(1);
  });
  it.each(['starting', 'running', 'updating'] as const)('browser close in %s cancels work and stops', kind => {
    let value = ready();
    if (kind === 'starting') value = { ...value, state: { kind, sessionId: 'preview-1', spec } };
    if (kind === 'updating') value = step(value, { type: 'UPDATE', reason: 'save' });
    const closed = step(value, { type: 'BROWSER_CLOSED', sessionId: 'preview-1', bindingId: 'tab-1' });
    expect(closed.state).toMatchObject({ kind: 'stopping', next: 'stopped' });
    expect(closed.context.pending).toBe(false);
    expect(closed.effects.map(e => e.type)).toEqual(['CLEAR_TIMERS', 'STOP']);
    expect(step(closed, { type: 'COMPILED', sessionId: 'preview-1', operationId: 2, code: 0 }).effects).toEqual([]);
  });
  it('old session and binding close events are ignored', () => {
    expect(step(ready(), { type: 'BROWSER_CLOSED', sessionId: 'old', bindingId: 'tab-1' }).state.kind).toBe('running');
    expect(step(ready(), { type: 'BROWSER_CLOSED', sessionId: 'preview-1', bindingId: 'old' }).state.kind).toBe('running');
  });
  it('close during restart cancels pending restart', () => {
    const restarting = step(ready(), { type: 'RESTART' });
    expect(restarting.context.nextSpec).toEqual(spec);
    const closed = step(restarting, { type: 'BROWSER_CLOSED', sessionId: 'preview-1', bindingId: 'tab-1' });
    expect(closed.context.nextSpec).toBeUndefined();
    expect(closed.effects.some(e => e.type === 'STOP')).toBe(false);
    const cleaned = step(closed, { type: 'CLEANED', sessionId: 'preview-1' });
    expect(cleaned.effects.some(effect => effect.type === 'DISPATCH')).toBe(false);
    expect(cleaned.effects.filter(effect => effect.type === 'CONSOLE_RESULT')).toHaveLength(1);
  });
  it('failure is terminal only after cleanup, and cleanup failure never permits another process', () => {
    const failed = step(ready(), { type: 'FATAL', sessionId: 'preview-1', message: 'Timeout' });
    expect(failed.state.kind).toBe('stopping');
    const cleanupFailed = step(failed, { type: 'CLEANUP_FAILED', sessionId: 'preview-1', message: 'Access denied' });
    expect(cleanupFailed.state.kind).toBe('stopping');
    expect(step(cleanupFailed, { type: 'RUN', spec }).effects).toEqual([]);
    expect(step(failed, { type: 'CLEANED', sessionId: 'preview-1' }).state).toEqual({ kind: 'failed', failure: 'Timeout' });
  });
  it('switching targets waits for cleanup and starts with a new session id', () => {
    const switching = step(ready(), { type: 'RUN', spec: { ...spec, entrypoint: 'lib/other.dart' } });
    expect(switching.state.kind).toBe('stopping');
    const clean = step(switching, { type: 'CLEANED', sessionId: 'preview-1' });
    const run = clean.effects.find(e => e.type === 'DISPATCH');
    expect(run?.type).toBe('DISPATCH');
    if (run?.type === 'DISPATCH') expect(step(clean, run.event).state).toMatchObject({ kind: 'starting', sessionId: 'preview-2' });
  });
  it('restart accepts fresh configuration both while running and after stop', () => {
    const updated = { ...spec, port: 7400, sdkPath: 'D:/new-sdk' };
    const restarting = step(ready(), { type: 'RESTART', spec: updated });
    expect(restarting.context.nextSpec).toEqual(updated);
    const stopped = step(step(ready(), { type: 'STOP' }), { type: 'CLEANED', sessionId: 'preview-1' });
    const start = step(stopped, { type: 'RESTART', spec: updated });
    expect(start.state).toMatchObject({ kind: 'starting', spec: updated });
  });
  it('feeds browser refresh results back into the owned session and ignores stale bindings', () => {
    const current = step(ready(), { type: 'BROWSER_REFRESHED', sessionId: 'preview-1', bindingId: 'tab-1', latencyMs: 80 });
    expect(current.context.lastRefreshLatencyMs).toBe(80);
    expect(step(current, { type: 'BROWSER_REFRESHED', sessionId: 'preview-1', bindingId: 'old', latencyMs: 999 }).context.lastRefreshLatencyMs).toBe(80);
    const stopping = step(current, { type: 'STOP' });
    expect(step(stopping, { type: 'BROWSER_REFRESHED', sessionId: 'preview-1', bindingId: 'tab-1', latencyMs: 999 }).context.lastRefreshLatencyMs).toBe(80);
  });
});

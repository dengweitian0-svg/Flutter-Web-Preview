import { initialSnapshot, sessionId, type LaunchSpec, type SessionEvent, type Snapshot, type Transition } from './types';

const sameTarget = (a: LaunchSpec, b: LaunchSpec) => a.projectRoot === b.projectRoot && a.entrypoint === b.entrypoint;

export function transition(snapshot: Snapshot, event: SessionEvent): Transition {
  const result: Transition = { state: snapshot.state, context: { ...snapshot.context }, effects: [] };
  const { context, effects } = result;
  const state = snapshot.state;
  const id = sessionId(state);
  if ('sessionId' in event && event.sessionId !== id) return result;

  const start = (spec: LaunchSpec) => {
    const sequence = context.sequence + 1;
    result.context = { ...initialSnapshot().context, sequence, currentSpec: spec };
    const newId = `preview-${sequence}`;
    result.state = { kind: 'starting', sessionId: newId, spec };
    effects.push({ type: 'START', sessionId: newId, spec });
  };
  const stop = (next: 'stopped' | 'failed', failure?: string) => {
    context.pending = false;
    effects.push({ type: 'CLEAR_TIMERS' });
    if (!id) { result.state = next === 'failed' ? { kind: 'failed', failure: failure ?? 'Preview failed.' } : { kind: 'stopped' }; return; }
    result.state = { kind: 'stopping', sessionId: id, next, failure };
    if (state.kind !== 'stopping') effects.push({ type: 'STOP', sessionId: id });
  };
  const drain = () => {
    if (context.pending && context.browserOpen && result.state.kind === 'running') effects.push({ type: 'DISPATCH', event: { type: 'UPDATE', reason: 'save' } });
  };
  const ready = () => {
    if (state.kind === 'starting' && context.started && context.appId && context.url) {
      result.state = { kind: 'running', session: { sessionId: state.sessionId, spec: state.spec, appId: context.appId, url: context.url } };
      effects.push({ type: 'CLEAR_TIMERS' });
      drain();
    }
  };

  switch (event.type) {
    case 'RUN':
      if (state.kind === 'stopped' || state.kind === 'failed') start(event.spec);
      else if (state.kind === 'stopping') context.nextSpec = event.spec;
      else if (context.currentSpec && sameTarget(context.currentSpec, event.spec)) {
        if (context.url) effects.push({ type: 'OPEN', sessionId: id!, url: context.url });
      } else { context.nextSpec = event.spec; stop('stopped'); }
      break;
    case 'STOP':
      context.nextSpec = undefined;
      stop('stopped');
      break;
    case 'RESTART':
      if (!context.currentSpec) break;
      if (state.kind === 'stopped' || state.kind === 'failed') start(context.currentSpec);
      else { context.nextSpec = context.currentSpec; stop('stopped'); }
      break;
    case 'APP_ID':
      if (state.kind === 'starting') { context.appId = event.appId; ready(); }
      break;
    case 'URL':
      if (state.kind === 'starting') {
        const first = !context.url;
        context.url = event.url;
        if (first) effects.push({ type: 'OPEN', sessionId: id!, url: event.url });
        ready();
      }
      break;
    case 'STARTED':
      if (state.kind === 'starting') { context.started = true; ready(); }
      break;
    case 'BROWSER_OPENED':
      if (state.kind !== 'stopping') { context.bindingId = event.bindingId; context.browserOpen = true; drain(); }
      break;
    case 'BROWSER_CLOSED':
      if (event.bindingId !== context.bindingId) break;
      context.browserOpen = false;
      context.nextSpec = undefined;
      stop('stopped');
      break;
    case 'SAVE':
      if (state.kind === 'starting' || state.kind === 'updating' || state.kind === 'running') context.pending = true;
      break;
    case 'CANCEL_SAVE':
      context.pending = false;
      break;
    case 'UPDATE':
      if (state.kind === 'starting' || state.kind === 'updating') context.pending = true;
      else if (state.kind === 'running' && (context.browserOpen || event.reason === 'manual')) {
        context.pending = false;
        const operationId = ++context.sequence;
        result.state = { kind: 'updating', session: state.session, operationId };
        effects.push({ type: 'COMPILE', session: state.session, operationId, reason: event.reason });
      }
      break;
    case 'COMPILED':
      if (state.kind !== 'updating' || event.operationId !== state.operationId) break;
      result.state = { kind: 'running', session: state.session, lastError: event.code === 0 ? undefined : event.message ?? 'Flutter compilation failed.' };
      if (event.code === 0 && context.browserOpen) effects.push({ type: 'REFRESH', sessionId: id!, operationId: event.operationId });
      if (event.code !== 0) effects.push({ type: 'REPORT', message: event.message ?? 'Flutter compilation failed. Fix the Dart error and save again.' });
      drain();
      break;
    case 'OPEN_BROWSER':
      if (id && context.url && state.kind !== 'stopping') effects.push({ type: 'OPEN', sessionId: id, url: context.url });
      break;
    case 'REFRESH_BROWSER':
      if (id && context.browserOpen && state.kind !== 'stopping') effects.push({ type: 'REFRESH', sessionId: id });
      break;
    case 'BROWSER_ERROR':
      if (state.kind !== 'stopping') {
        if (state.kind === 'running') result.state = { ...state, lastError: event.message };
        effects.push({ type: 'REPORT', message: event.message });
      }
      break;
    case 'FATAL':
      if (state.kind !== 'stopping') { context.nextSpec = undefined; stop('failed', event.message); }
      break;
    case 'CLEANED':
      if (state.kind === 'stopping') {
        context.browserOpen = false; context.bindingId = undefined; context.appId = undefined; context.url = undefined; context.started = false;
        result.state = state.next === 'failed' ? { kind: 'failed', failure: state.failure ?? 'Preview failed.' } : { kind: 'stopped' };
        if (state.next === 'failed') effects.push({ type: 'REPORT', message: state.failure ?? 'Preview failed.' });
        if (context.nextSpec) { const spec = context.nextSpec; context.nextSpec = undefined; effects.push({ type: 'DISPATCH', event: { type: 'RUN', spec } }); }
      }
      break;
    case 'CLEANUP_FAILED':
      if (state.kind === 'stopping') effects.push({ type: 'REPORT', message: `Cannot confirm Flutter stopped: ${event.message}. Retry Stop.` });
      break;
  }
  return result;
}

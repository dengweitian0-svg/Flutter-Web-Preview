export interface LaunchSpec {
  projectRoot: string;
  entrypoint: string;
  sdkPath: string;
  port: number;
  startupTimeout: number;
  reloadTimeout: number;
}
export interface ReadySession { sessionId: string; spec: LaunchSpec; appId: string; url: string }
export type SessionState =
  | { kind: 'stopped' }
  | { kind: 'starting'; sessionId: string; spec: LaunchSpec }
  | { kind: 'running'; session: ReadySession; lastError?: string }
  | { kind: 'updating'; session: ReadySession; operationId: number }
  | { kind: 'stopping'; sessionId: string; next: 'stopped' | 'failed'; failure?: string }
  | { kind: 'failed'; failure: string };

export interface SessionContext {
  appId?: string;
  url?: string;
  started: boolean;
  browserOpen: boolean;
  bindingId?: string;
  pending: boolean;
  nextSpec?: LaunchSpec;
  currentSpec?: LaunchSpec;
  sequence: number;
}
export interface Snapshot { state: SessionState; context: SessionContext }
export const initialSnapshot = (): Snapshot => ({ state: { kind: 'stopped' }, context: { started: false, browserOpen: false, pending: false, sequence: 0 } });
export function sessionId(state: SessionState): string | undefined {
  if (state.kind === 'starting' || state.kind === 'stopping') return state.sessionId;
  if (state.kind === 'running' || state.kind === 'updating') return state.session.sessionId;
}
export type SessionEvent =
  | { type: 'RUN'; spec: LaunchSpec }
  | { type: 'STOP'; reason?: string }
  | { type: 'RESTART'; spec?: LaunchSpec }
  | { type: 'SAVE' }
  | { type: 'CANCEL_SAVE' }
  | { type: 'UPDATE'; reason: 'save' | 'manual' }
  | { type: 'OPEN_BROWSER' | 'REFRESH_BROWSER' }
  | { type: 'APP_ID'; sessionId: string; appId: string }
  | { type: 'URL'; sessionId: string; url: string }
  | { type: 'STARTED'; sessionId: string }
  | { type: 'BROWSER_OPENED'; sessionId: string; bindingId: string }
  | { type: 'BROWSER_CLOSED'; sessionId: string; bindingId: string }
  | { type: 'BROWSER_ERROR'; sessionId: string; message: string; bindingLost?: boolean }
  | { type: 'COMPILED'; sessionId: string; operationId: number; code: number; message?: string }
  | { type: 'FATAL'; sessionId: string; message: string }
  | { type: 'CLEANED'; sessionId: string }
  | { type: 'CLEANUP_FAILED'; sessionId: string; message: string };
export type Effect =
  | { type: 'START'; sessionId: string; spec: LaunchSpec }
  | { type: 'STOP'; sessionId: string }
  | { type: 'CLEAR_TIMERS' }
  | { type: 'COMPILE'; session: ReadySession; operationId: number; reason: 'save' | 'manual' }
  | { type: 'OPEN'; sessionId: string; url: string }
  | { type: 'REFRESH'; sessionId: string; operationId?: number }
  | { type: 'DISPATCH'; event: SessionEvent }
  | { type: 'REPORT'; message: string };
export interface Transition extends Snapshot { effects: Effect[] }
export interface Disposable { dispose(): void }
export interface EventSource<T> { subscribe(listener: (event: T) => void): Disposable }
export interface CompileResult { code: number; message?: string }
export type RuntimeEvent =
  | Extract<SessionEvent, { type: 'APP_ID' | 'URL' | 'STARTED' | 'FATAL' }>;
export type BrowserEvent = Extract<SessionEvent, { type: 'BROWSER_OPENED' | 'BROWSER_CLOSED' | 'BROWSER_ERROR' }>;
export interface FlutterRuntime {
  readonly events: EventSource<RuntimeEvent>;
  start(sessionId: string, spec: LaunchSpec): Promise<void>;
  recompile(sessionId: string, reason: 'save' | 'manual', timeout: number): Promise<CompileResult>;
  stop(sessionId: string): Promise<void>;
}
export interface PreviewBrowser {
  readonly events: EventSource<BrowserEvent>;
  open(sessionId: string, url: string): Promise<void>;
  refresh(sessionId: string): Promise<void>;
  release(sessionId: string): Promise<void>;
}

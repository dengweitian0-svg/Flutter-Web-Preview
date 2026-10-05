import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { Signal } from '../core/signal';
import type { BrowserEvent, ConsoleResult, EventSource } from '../core/types';
import { LifecycleDebugAdapter } from './lifecycleDebugAdapter';

export const previewDebugType = 'flutter-web-preview';
export interface PreviewConsoleHost {
  readonly events: EventSource<BrowserEvent>;
  ensure(sessionId: string): Promise<vscode.DebugSession | undefined>;
  reportLifecycle(sessionId: string, result: ConsoleResult): void;
}
interface ConsoleSession {
  token: string; id: string; adapter: LifecycleDebugAdapter; session?: vscode.DebugSession;
  launch?: Promise<vscode.DebugSession | undefined>; finished: boolean; stopRequested?: boolean;
}

/** The console outlives the browser, so confirmed cleanup can still be displayed. */
export class PreviewConsole implements PreviewConsoleHost, vscode.Disposable {
  readonly events = new Signal<BrowserEvent>();
  private readonly entries = new Map<string, ConsoleSession>();
  private readonly subscriptions: vscode.Disposable[];
  constructor(private readonly log: (text: string) => void) {
    this.subscriptions = [
      vscode.debug.registerDebugAdapterDescriptorFactory(previewDebugType, {
        createDebugAdapterDescriptor: session => {
          const entry = this.entries.get(String(session.configuration.flutterWebPreviewConsoleSessionId));
          if (!entry || session.configuration.flutterWebPreviewConsoleToken !== entry.token) throw new Error('Start the log console using Run Web Preview.');
          entry.session = session;
          return new vscode.DebugAdapterInlineImplementation(entry.adapter);
        },
      }),
      vscode.debug.onDidTerminateDebugSession(session => {
        const id: unknown = session.configuration.flutterWebPreviewConsoleSessionId;
        if (typeof id !== 'string') return;
        const entry = this.entries.get(id);
        if (!entry || entry.token !== session.configuration.flutterWebPreviewConsoleToken || entry.session?.id !== session.id || session.configuration.type !== previewDebugType) return;
        this.entries.delete(id);
        this.requestStop(entry);
      }),
    ];
  }
  ensure(id: string): Promise<vscode.DebugSession | undefined> {
    const current = this.entries.get(id);
    if (current) return current.launch!;
    const token = `console:${randomUUID()}`;
    const adapter = new LifecycleDebugAdapter(id, () => this.requestStop(entry));
    const entry: ConsoleSession = { token, id, adapter, finished: false };
    this.entries.set(id, entry);
    entry.launch = this.launch(entry);
    return entry.launch;
  }
  private requestStop(entry: ConsoleSession): void {
    if (entry.finished || entry.stopRequested) return;
    entry.stopRequested = true;
    this.events.emit({ type: 'LOG_CONSOLE_STOP_REQUEST', sessionId: entry.id });
  }
  private async launch(entry: ConsoleSession): Promise<vscode.DebugSession | undefined> {
    try {
      const started = await vscode.debug.startDebugging(undefined, {
        type: previewDebugType, request: 'launch', name: `Flutter Web Preview (${entry.id})`, noDebug: true,
        flutterWebPreviewConsoleSessionId: entry.id, flutterWebPreviewConsoleToken: entry.token,
        flutterWebPreviewLogToken: entry.token, internalConsoleOptions: 'openOnSessionStart',
      }, { noDebug: true, consoleMode: vscode.DebugConsoleMode.Separate, suppressSaveBeforeStart: true, suppressDebugToolbar: true, suppressDebugStatusbar: true, suppressDebugView: true });
      if (entry.finished) return undefined;
      if (!started || !entry.session) throw new Error('Preview lifecycle console could not start.');
      return entry.session;
    } catch (error) {
      this.entries.delete(entry.id);
      entry.finished = true;
      entry.adapter.dispose();
      throw error;
    }
  }
  reportLifecycle(id: string, result: ConsoleResult): void {
    const entry = this.entries.get(id);
    if (!entry || entry.finished) return;
    if (result.cleaned) entry.finished = true;
    try { entry.adapter.report(result); }
    catch (error) { this.log(`Cannot display lifecycle result for ${id}: ${String(error)}\n`); }
  }
  dispose(): void {
    for (const entry of this.entries.values()) entry.adapter.dispose();
    this.entries.clear(); this.events.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}

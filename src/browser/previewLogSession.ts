import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { Signal } from '../core/signal';
import type { BrowserEvent } from '../core/types';

interface Attachment {
  token: string; sessionId: string; bindingId: string; url: string;
  cancelled: boolean; ready: boolean; terminated: boolean;
  debugSession?: vscode.DebugSession; task?: Promise<void>;
}

/** Owns only the browser logging sessions created by this preview adapter. */
export class PreviewLogSession {
  readonly events = new Signal<BrowserEvent>();
  private readonly owner = `${randomUUID()}:`;
  private sequence = 0;
  private current?: Attachment;
  private readonly attachments = new Map<string, Attachment>();
  private readonly pendingLaunches = new Set<Promise<boolean>>();
  private readonly subscriptions: vscode.Disposable[];
  private disposed = false;

  constructor(private readonly log: (text: string) => void) {
    this.subscriptions = [
      vscode.debug.onDidStartDebugSession(session => {
        const token: unknown = session.configuration.flutterWebPreviewLogToken;
        if (session.parentSession || typeof token !== 'string' || !token.startsWith(this.owner)) return;
        const attachment = this.attachments.get(token);
        if (!attachment || attachment.cancelled || this.disposed) {
          void this.stop(session).catch(error => this.log(`Cannot release late log session: ${String(error)}\n`));
        } else attachment.debugSession = session;
      }),
      vscode.debug.onDidTerminateDebugSession(session => {
        const token: unknown = session.configuration.flutterWebPreviewLogToken;
        if (session.parentSession || typeof token !== 'string') return;
        const attachment = this.attachments.get(token);
        if (!attachment || attachment.debugSession?.id !== session.id) return;
        attachment.terminated = true;
        if (attachment.ready && !attachment.cancelled && this.current === attachment) {
          this.current = undefined;
          this.attachments.delete(token);
          this.events.emit({ type: 'LOG_SESSION_ENDED', sessionId: attachment.sessionId, bindingId: attachment.bindingId });
        }
      }),
    ];
  }

  attach(sessionId: string, bindingId: string, url: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const previous = this.current;
    if (previous && previous.sessionId === sessionId && previous.bindingId === bindingId && previous.url === url) return previous.task!;
    if (previous) previous.cancelled = true;
    const attachment: Attachment = {
      token: `${this.owner}${++this.sequence}`, sessionId, bindingId, url,
      cancelled: false, ready: false, terminated: false,
    };
    this.current = attachment;
    this.attachments.set(attachment.token, attachment);
    attachment.task = this.launch(attachment, previous);
    return attachment.task;
  }

  private async launch(attachment: Attachment, previous?: Attachment): Promise<void> {
    let launch: Thenable<boolean> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (previous?.debugSession && !previous.terminated) await this.stop(previous.debugSession);
      if (previous?.ready) this.attachments.delete(previous.token);
      if (attachment.cancelled) return;
      if (!vscode.extensions.getExtension('ms-vscode.js-debug')) throw new Error('Enable the built-in JavaScript Debugger extension.');
      launch = vscode.debug.startDebugging(undefined, {
        type: 'editor-browser', request: 'attach', name: 'Flutter Web Preview',
        urlFilter: `${new URL(attachment.url).origin}/*`, outputCapture: 'console',
        noDebug: true, internalConsoleOptions: 'openOnSessionStart',
        flutterWebPreviewLogToken: attachment.token,
      }, {
        noDebug: true, consoleMode: vscode.DebugConsoleMode.Separate,
        suppressSaveBeforeStart: true, suppressDebugToolbar: true,
        suppressDebugStatusbar: true, suppressDebugView: true,
      });
      const pending = Promise.resolve(launch);
      this.pendingLaunches.add(pending);
      void pending.catch(() => {}).finally(() => this.pendingLaunches.delete(pending));
      const started = await Promise.race([
        launch,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Browser log connection timed out.')), 15000); }),
      ]);
      if (attachment.cancelled) return;
      if (!started || !attachment.debugSession || attachment.terminated) throw new Error('Browser log connection was not established.');
      attachment.ready = true;
      this.log('Browser application logs are available in the Flutter Web Preview Debug Console.\n');
      this.events.emit({ type: 'LOG_SESSION_STARTED', sessionId: attachment.sessionId, bindingId: attachment.bindingId });
    } catch (error) {
      if (!attachment.cancelled && this.current === attachment) {
        attachment.cancelled = true;
        this.current = undefined;
        const message = `Cannot connect preview logs: ${error instanceof Error ? error.message : String(error)} Use Open Preview Browser to retry.`;
        this.events.emit({ type: 'LOG_SESSION_ERROR', sessionId: attachment.sessionId, bindingId: attachment.bindingId, message });
      }
    } finally {
      clearTimeout(timer);
      if (attachment.cancelled) {
        if (attachment.debugSession && !attachment.terminated) {
          await this.stop(attachment.debugSession).catch(error => this.log(`Cannot release log session: ${String(error)}\n`));
        }
        // Retain cancellation listeners until a pending VS Code launch settles.
        void Promise.resolve(launch).catch(() => {}).finally(() => this.attachments.delete(attachment.token));
      }
    }
  }

  private async stop(session: vscode.DebugSession): Promise<void> { await vscode.debug.stopDebugging(session); }

  async release(sessionId: string): Promise<void> {
    const attachment = this.current;
    if (!attachment || attachment.sessionId !== sessionId) return;
    attachment.cancelled = true;
    this.current = undefined;
    if (attachment.debugSession && !attachment.terminated) await this.stop(attachment.debugSession);
    if (attachment.ready) this.attachments.delete(attachment.token);
  }

  dispose(): void {
    this.disposed = true;
    if (this.current) void this.release(this.current.sessionId).catch(error => this.log(`${String(error)}\n`));
    this.events.clear();
    // A launch can finish after cancellation; its owned session must still be released.
    void Promise.allSettled([...this.pendingLaunches, ...[...this.attachments.values()].map(attachment => attachment.task)]).then(() => {
      for (const subscription of this.subscriptions) subscription.dispose();
      this.attachments.clear();
    });
  }
}

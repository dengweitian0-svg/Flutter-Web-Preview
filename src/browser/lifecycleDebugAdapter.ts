import * as vscode from 'vscode';
import type { ConsoleResult } from '../core/types';

interface Request extends vscode.DebugProtocolMessage { type: string; seq: number; command: string }
export class LifecycleDebugAdapter implements vscode.DebugAdapter {
  private readonly messages = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.messages.event;
  private sequence = 0;
  private launched = false;
  private completed?: ConsoleResult;
  private terminated = false;
  private stopRequested = false;
  private readonly pendingStops: Request[] = [];
  constructor(private readonly sessionId: string, private readonly requestStop: () => void) {}
  private send(message: Record<string, unknown>): void { this.messages.fire({ ...message, seq: ++this.sequence } as vscode.DebugProtocolMessage); }
  private response(request: Request, body: Record<string, unknown> = {}, success = true): void {
    this.send({ type: 'response', request_seq: request.seq, command: request.command, success, body });
  }
  private output(text: string, category = 'console'): void { this.send({ type: 'event', event: 'output', body: { output: `${text}\n`, category } }); }
  handleMessage(message: vscode.DebugProtocolMessage): void {
    const request = message as Request;
    if (request.type !== 'request') return;
    switch (request.command) {
      case 'initialize':
        this.response(request, { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true });
        this.send({ type: 'event', event: 'initialized' }); break;
      case 'launch':
        this.launched = true; this.response(request);
        this.output(`[Flutter Web Preview] start: ${this.sessionId}`);
        this.publishCompletion(); break;
      case 'configurationDone': this.response(request); break;
      case 'threads': this.response(request, { threads: [{ id: 1, name: 'Preview lifecycle' }] }); break;
      case 'stackTrace': this.response(request, { stackFrames: [], totalFrames: 0 }); break;
      case 'scopes': this.response(request, { scopes: [] }); break;
      case 'setBreakpoints': this.response(request, { breakpoints: [] }); break;
      case 'disconnect': case 'terminate':
        if (this.terminated) { this.response(request); break; }
        this.pendingStops.push(request);
        if (!this.stopRequested) { this.stopRequested = true; this.requestStop(); }
        break;
      default:
        this.send({ type: 'response', request_seq: request.seq, command: request.command, success: false, message: 'This session displays preview logs. Use Flutter Web Preview commands to control the application.' });
    }
  }
  report(result: ConsoleResult): void {
    if (this.completed || this.terminated) return;
    if (!result.cleaned) {
      this.output(`[Flutter Web Preview] stop failed: ${result.failure ?? 'Cleanup not confirmed'}. Retry Stop Web Preview.`, 'stderr');
      return;
    }
    this.completed = result;
    this.publishCompletion();
  }
  private publishCompletion(): void {
    if (!this.launched || !this.completed || this.terminated) return;
    this.terminated = true;
    this.output(`[Flutter Web Preview] exit: ${this.sessionId} ended; Flutter stopped.${this.completed.failure ? ` Reason: ${this.completed.failure}` : ''}`);
    for (const request of this.pendingStops.splice(0)) this.response(request);
    this.send({ type: 'event', event: 'terminated' });
  }
  dispose(): void {
    if (!this.terminated && !this.stopRequested) { this.stopRequested = true; this.requestStop(); }
    this.messages.dispose();
  }
}

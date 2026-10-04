import * as vscode from 'vscode';
import path from 'node:path';
import { IntegratedBrowser } from './browser/integratedBrowser';
import { PreviewSessionController } from './core/controller';
import { sessionId, type SessionState } from './core/types';
import { FlutterProcessRuntime } from './flutter/flutterRuntime';
import { belongsToProject, nearestProject } from './project/flutterProject';
import { numericSetting, resolveLaunch } from './project/resolveLaunch';
import { mainOffsets } from './ui/dartMain';

export interface PreviewStatus { state: SessionState['kind']; projectRoot?: string; url?: string; error?: string; browserAvailable: boolean; lastRefreshLatencyMs?: number }
export interface PreviewApi { getStatus(): PreviewStatus }
let controller: PreviewSessionController | undefined;
let browser: IntegratedBrowser | undefined;
let intent = 0;

export function activate(context: vscode.ExtensionContext): PreviewApi {
  const output = vscode.window.createOutputChannel('Flutter Web Preview');
  const log = (text: string) => output.append(text.endsWith('\n') ? text : `${text}\n`);
  const report = (message: string) => {
    log(message);
    if (controller?.current.state.kind === 'failed' || controller?.current.state.kind === 'stopping') {
      void vscode.window.showErrorMessage(message, 'Show Output').then(choice => { if (choice) output.show(true); });
    }
  };
  const runtime = new FlutterProcessRuntime(log);
  const preview: IntegratedBrowser = new IntegratedBrowser(id => !!controller && sessionId(controller.current.state) === id && ['starting', 'running', 'updating'].includes(controller.current.state.kind), log);
  browser = preview;
  const session = new PreviewSessionController(runtime, preview, report, log, snapshot => {
    const resource = snapshot.context.currentSpec ? vscode.Uri.file(snapshot.context.currentSpec.projectRoot) : undefined;
    return numericSetting(vscode.workspace.getConfiguration('flutterWebPreview', resource), 'reloadTimeout', 30000, 1000, 3600000);
  });
  controller = session;
  context.subscriptions.push(preview.events.subscribe(event => {
    if (event.type === 'BROWSER_CLOSED' && event.sessionId === sessionId(session.current.state) && event.bindingId === session.current.context.bindingId) intent++;
    if (event.type === 'BROWSER_ERROR' && event.bindingLost && event.sessionId === sessionId(session.current.state)) {
      void vscode.window.showWarningMessage(event.message, 'Open Preview Browser', 'Stop Web Preview').then(choice => {
        if (event.sessionId !== sessionId(session.current.state)) return;
        if (choice === 'Open Preview Browser') void vscode.commands.executeCommand('flutterWebPreview.openBrowser');
        if (choice === 'Stop Web Preview') void vscode.commands.executeCommand('flutterWebPreview.stop');
      });
    }
  }));
  const status = vscode.window.createStatusBarItem('flutterWebPreview.status', vscode.StatusBarAlignment.Left, 25);
  status.command = 'flutterWebPreview.actions';
  const updateStatus = () => {
    const { state, context: current } = session.current;
    const error = state.kind === 'failed' ? state.failure : state.kind === 'running' ? state.lastError ?? (!current.browserOpen ? 'Preview browser unavailable. Use Open Preview Browser.' : undefined) : undefined;
    const icons = { stopped: 'globe', starting: 'loading~spin', running: error ? 'warning' : 'globe', updating: 'sync~spin', stopping: 'loading~spin', failed: 'error' };
    status.text = `$(${icons[state.kind]}) Web Preview: ${state.kind}`;
    status.tooltip = error ?? (current.currentSpec ? `${path.basename(current.currentSpec.projectRoot)} — ${state.kind}` : 'Run a Flutter Web preview');
    status.show();
    void vscode.commands.executeCommand('setContext', 'flutterWebPreview.active', ['starting', 'running', 'updating', 'stopping'].includes(state.kind));
  };
  context.subscriptions.push(output, status, session.changes.subscribe(updateStatus)); updateStatus();
  const register = (name: string, callback: (...args: unknown[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(`flutterWebPreview.${name}`, async (...args: unknown[]) => {
      try { return await callback(...args); }
      catch (error) { const message = error instanceof Error ? error.message : String(error); log(message); void vscode.window.showErrorMessage(message, 'Show Output').then(choice => { if (choice) output.show(true); }); throw error; }
    }));
  };
  register('run', async uri => {
    const request = ++intent;
    await IntegratedBrowser.checkSupport();
    const spec = await resolveLaunch(uri instanceof vscode.Uri ? uri : undefined);
    if (spec && request === intent) session.dispatch({ type: 'RUN', spec });
  });
  register('stop', async () => { intent++; await session.stop(); });
  register('restart', async () => {
    const request = ++intent;
    const current = session.current.context.currentSpec;
    if (!current) { await vscode.commands.executeCommand('flutterWebPreview.run'); return; }
    const spec = await resolveLaunch(vscode.Uri.file(current.entrypoint));
    if (spec && request === intent) {
      session.dispatch({ type: 'RESTART', spec });
    }
  });
  register('reload', () => {
    if (['stopped', 'failed', 'stopping'].includes(session.current.state.kind)) throw new Error('Run Web Preview before requesting an update.');
    session.dispatch({ type: 'UPDATE', reason: 'manual' });
  });
  register('openBrowser', () => { session.dispatch({ type: 'OPEN_BROWSER' }); });
  register('reloadBrowser', () => { session.dispatch({ type: 'REFRESH_BROWSER' }); });
  register('showOutput', () => output.show(true));
  register('actions', async () => {
    const action = await vscode.window.showQuickPick([
      { label: 'Run Web Preview', command: 'run' }, { label: 'Stop Web Preview', command: 'stop' },
      { label: 'Restart Web Preview', command: 'restart' }, { label: 'Reload Web Preview', command: 'reload' },
      { label: 'Open Preview Browser', command: 'openBrowser' }, { label: 'Reload Preview Browser', command: 'reloadBrowser' },
      { label: 'Show Output', command: 'showOutput' },
    ]);
    if (action) await vscode.commands.executeCommand(`flutterWebPreview.${action.command}`);
  });
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
    const current = session.current; const spec = current.context.currentSpec; const id = sessionId(current.state);
    if (!id || !spec || document.uri.scheme !== 'file' || !document.fileName.toLowerCase().endsWith('.dart')) return;
    void belongsToProject(document.uri.fsPath, spec.projectRoot).then(belongs => {
      if (!belongs || sessionId(session.current.state) !== id) return;
      const config = vscode.workspace.getConfiguration('flutterWebPreview', vscode.Uri.file(spec.projectRoot));
      if (config.get<boolean>('reloadOnSave', true)) {
        try { session.save(numericSetting(config, 'reloadDelay', 300, 0, 60000)); } catch (error) { report(String(error)); }
      }
    }).catch(error => report(String(error)));
  }));
  const lensChanges = new vscode.EventEmitter<void>();
  context.subscriptions.push(lensChanges, vscode.languages.registerCodeLensProvider([{ scheme: 'file', language: 'dart' }, { scheme: 'file', pattern: '**/*.dart' }], {
    onDidChangeCodeLenses: lensChanges.event,
    async provideCodeLenses(document) {
      if (!vscode.workspace.getConfiguration('flutterWebPreview', document.uri).get<boolean>('showCodeLens', true)) return [];
      const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!workspace || !await nearestProject(document.uri.fsPath, workspace.uri.fsPath)) return [];
      return mainOffsets(document.getText()).map(offset => new vscode.CodeLens(new vscode.Range(document.positionAt(offset), document.positionAt(offset)), { title: '$(play) Run Web Preview', command: 'flutterWebPreview.run', arguments: [document.uri] }));
    },
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('flutterWebPreview.showCodeLens')) lensChanges.fire();
    if (event.affectsConfiguration('flutterWebPreview.reloadOnSave')) {
      const spec = session.current.context.currentSpec;
      if (!vscode.workspace.getConfiguration('flutterWebPreview', spec ? vscode.Uri.file(spec.projectRoot) : undefined).get<boolean>('reloadOnSave', true)) session.cancelSavedUpdates();
    }
  }));
  log('Flutter Web Preview activated. Closing the preview stops its Flutter process.');
  return { getStatus: () => {
    const { state, context: current } = session.current;
    return { state: state.kind, projectRoot: current.currentSpec?.projectRoot, url: current.url, browserAvailable: current.browserOpen, lastRefreshLatencyMs: current.lastRefreshLatencyMs, error: state.kind === 'failed' ? state.failure : state.kind === 'running' ? state.lastError : undefined };
  } };
}

export async function deactivate(): Promise<void> {
  intent++;
  await controller?.dispose(); browser?.dispose(); controller = undefined; browser = undefined;
}

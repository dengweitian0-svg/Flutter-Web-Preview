import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PreviewApi } from '../../src/extension';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function shutdownTest(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; assert(root);
  const marker = process.env.PREVIEW_SHUTDOWN_MARKER; assert(marker);
  const runId = process.env.PREVIEW_RUN_ID; assert(runId);
  const extension = vscode.extensions.getExtension<PreviewApi>('wende.flutter-web-preview'); assert(extension);
  const api = await extension.activate();
  const file = vscode.Uri.file(path.join(root, 'lib', 'main.dart'));
  await vscode.window.showTextDocument(file);
  if (process.env.FLUTTER_SDK_PATH) await vscode.workspace.getConfiguration('flutterWebPreview', file).update('flutterSdkPath', process.env.FLUTTER_SDK_PATH, vscode.ConfigurationTarget.Workspace);
  await vscode.commands.executeCommand('flutterWebPreview.run', file);
  const start = Date.now();
  while (api.getStatus().state !== 'running' || !api.getStatus().browserAvailable) {
    if (api.getStatus().state === 'failed' || Date.now() - start > 180000) throw new Error(api.getStatus().error ?? 'Shutdown fixture startup timed out');
    await wait(100);
  }
  const command = 'workbench.action.closeWindow';
  assert((await vscode.commands.getCommands(true)).includes(command));
  const record = { runId, hostPid: process.pid, started: true, closeRequested: true };
  await writeFile(marker, JSON.stringify(record));
  try { await vscode.commands.executeCommand(command); }
  catch (error) { await writeFile(marker, JSON.stringify({ ...record, error: String(error) })); throw error; }
  // A successful window close deliberately ends this test host.
  await new Promise<never>(() => {});
}

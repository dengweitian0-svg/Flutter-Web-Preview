import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PreviewApi } from '../../src/extension';
import { DevTools } from './devTools';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function performanceTest(): Promise<void> {
  const extension = vscode.extensions.getExtension<PreviewApi>('wende.flutter-web-preview'); assert(extension);
  const api = await extension.activate();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; assert(root);
  const file = vscode.Uri.file(path.join(root, 'lib', 'main.dart'));
  const original = await readFile(file.fsPath, 'utf8');
  const document = await vscode.workspace.openTextDocument(file);
  const config = vscode.workspace.getConfiguration('flutterWebPreview', file);
  const initialSdk = config.inspect<string>('flutterSdkPath')?.workspaceValue;
  const initialPort = config.inspect<number>('port')?.workspaceValue;
  const artifacts = process.env.PREVIEW_ARTIFACTS_DIR ?? path.join(extension.extensionPath, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  let devTools: DevTools | undefined;
  const samples: { operation: string; elapsedMs: number }[] = [];
  let resources: unknown;
  const replace = async (text: string) => {
    const edit = new vscode.WorkspaceEdit(); edit.replace(file, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    assert(await vscode.workspace.applyEdit(edit)); assert(await document.save());
  };
  const rendered = async (expected: string, startedAt: number) => {
    while (Date.now() - startedAt < 120000) {
      assert.notEqual(api.getStatus().state, 'failed', api.getStatus().error);
      try {
        if (!devTools && api.getStatus().url) devTools = await DevTools.connect(api.getStatus().url!);
        if (devTools && (await devTools.text()).includes(expected)) return;
      } catch { devTools?.close(); devTools = undefined; }
      await wait(50);
    }
    throw new Error(`Page did not render ${expected} within 120 seconds`);
  };
  try {
    if (process.env.PREVIEW_TEST_PORT) await config.update('port', Number(process.env.PREVIEW_TEST_PORT), vscode.ConfigurationTarget.Workspace);
    if (process.env.FLUTTER_SDK_PATH) await config.update('flutterSdkPath', process.env.FLUTTER_SDK_PATH, vscode.ConfigurationTarget.Workspace);
    await vscode.window.showTextDocument(document);
    let startedAt = Date.now();
    await vscode.commands.executeCommand('flutterWebPreview.run', file);
    await rendered('Preview version 1', startedAt);
    samples.push({ operation: 'startup', elapsedMs: Date.now() - startedAt });
    // Measure saves with the normal application log connection active.
    const logDeadline = Date.now() + 60000;
    while (!api.getStatus().logConsoleConnected && Date.now() < logDeadline) await wait(50);
    assert(api.getStatus().logConsoleConnected, 'Application logs must be connected');
    for (let index = 0; index < 3; index++) {
      await vscode.window.showTextDocument(document);
      startedAt = Date.now();
      await replace(original.replace('Preview version 1', `Preview performance ${index}`));
      await rendered(`Preview performance ${index}`, startedAt);
      samples.push({ operation: `save-${index + 1}`, elapsedMs: Date.now() - startedAt });
    }
    resources = await devTools!.evaluate("performance.getEntriesByType('resource').map(e => ({name:e.name,duration:e.duration,transferSize:e.transferSize}))");
    console.log(`PERFORMANCE: ${JSON.stringify(samples)}`);
  } finally {
    if (devTools) {
      resources ??= await devTools.evaluate("performance.getEntriesByType('resource').map(e => ({name:e.name,duration:e.duration,transferSize:e.transferSize}))").catch(() => undefined);
      devTools.close();
    }
    await vscode.commands.executeCommand('flutterWebPreview.stop');
    await replace(original);
    await config.update('flutterSdkPath', initialSdk, vscode.ConfigurationTarget.Workspace);
    await config.update('port', initialPort, vscode.ConfigurationTarget.Workspace);
    await writeFile(path.join(artifacts, 'performance.json'), JSON.stringify({ samples, resources, status: api.getStatus(), vscode: vscode.version, sdk: process.env.FLUTTER_SDK_PATH }, null, 2));
  }
}

import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { checkPort } from '../../src/flutter/flutterRuntime';
import type { PreviewApi } from '../../src/extension';
import { DevTools, testPort, waitForText } from './devTools';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>, timeout = 180000): Promise<void> {
  const start = Date.now();
  while (!await predicate()) { if (Date.now() - start > timeout) throw new Error('E2E condition timed out.'); await wait(100); }
}
export async function endToEnd(): Promise<void> {
  const extension = vscode.extensions.getExtension<PreviewApi>('wende.flutter-web-preview'); assert(extension);
  const api = await extension.activate();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; assert(root);
  const file = vscode.Uri.file(path.join(root, 'lib', 'main.dart'));
  const original = await readFile(file.fsPath, 'utf8');
  const artifacts = process.env.PREVIEW_ARTIFACTS_DIR ?? path.join(extension.extensionPath, 'artifacts'); await mkdir(artifacts, { recursive: true });
  const checks: string[] = [];
  let phase = 'startup';
  let devTools: DevTools | undefined;
  const command = (name: string, ...args: unknown[]) => vscode.commands.executeCommand(`flutterWebPreview.${name}`, ...args);
  const document = await vscode.workspace.openTextDocument(file);
  const config = vscode.workspace.getConfiguration('flutterWebPreview', file);
  const initialSdk = config.inspect<string>('flutterSdkPath')?.workspaceValue;
  const initialReload = config.inspect<boolean>('reloadOnSave')?.workspaceValue;
  const initialReloadOnAutoSave = config.inspect<boolean>('reloadOnAutoSave')?.workspaceValue;
  const initialTimeout = config.inspect<number>('reloadTimeout')?.workspaceValue;
  const initialPort = config.inspect<number>('port')?.workspaceValue;
  const filesConfig = vscode.workspace.getConfiguration('files', file);
  const initialAutoSave = filesConfig.inspect<string>('autoSave')?.workspaceValue;
  const initialAutoSaveDelay = filesConfig.inspect<number>('autoSaveDelay')?.workspaceValue;
  const replace = async (text: string, save = true) => {
    const edit = new vscode.WorkspaceEdit(); edit.replace(file, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    assert(await vscode.workspace.applyEdit(edit)); if (save) assert(await document.save());
  };
  const rendered = async (expected: string, previousDocument?: string) => {
    const connection = { current: devTools };
    try { await waitForText(connection, api.getStatus().url ?? `http://127.0.0.1:${testPort}`, expected, 60000, previousDocument); }
    finally { devTools = connection.current; }
  };
  try {
    await config.update('reloadOnAutoSave', undefined, vscode.ConfigurationTarget.Workspace);
    assert.equal(config.get<boolean>('reloadOnAutoSave'), false, 'Automatic save refresh must be disabled by default');
    await vscode.window.showTextDocument(document);
    if (process.env.FLUTTER_SDK_PATH) await config.update('flutterSdkPath', process.env.FLUTTER_SDK_PATH, vscode.ConfigurationTarget.Workspace);
    await config.update('port', testPort, vscode.ConfigurationTarget.Workspace);
    const commands = await vscode.commands.getCommands();
    for (const name of ['run', 'stop', 'restart', 'reload', 'openBrowser', 'reloadBrowser', 'showOutput']) assert(commands.includes(`flutterWebPreview.${name}`));
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', file);
    assert(lenses?.some(lens => lens.command?.command === 'flutterWebPreview.run'), 'Dart main must have our CodeLens');
    checks.push('commands and CodeLens');
    await command('run', file);
    await until(() => api.getStatus().state === 'running' || api.getStatus().state === 'failed');
    assert.equal(api.getStatus().state, 'running', api.getStatus().error);
    await rendered('Preview version 1'); await devTools!.screenshot(path.join(artifacts, 'preview-before.png'));
    checks.push('Run renders Flutter in Integrated Browser');
    phase = 'save and complete browser navigation';
    const initialDocument = await devTools!.documentId();
    const initialRefreshes = api.getStatus().refreshCount;
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    await replace(original.replace('Preview version 1', 'Preview version 2'));
    await until(() => api.getStatus().state === 'failed' || (api.getStatus().lastCompilation?.code === 0 && api.getStatus().refreshCount > initialRefreshes), 60000);
    assert.equal(api.getStatus().state, 'running', api.getStatus().error);
    await rendered('Preview version 2', initialDocument);
    await until(() => api.getStatus().lastRefreshLatencyMs !== undefined && vscode.window.activeTextEditor?.document.uri.toString() === file.toString(), 5000);
    assert(api.getStatus().lastRefreshLatencyMs !== undefined && api.getStatus().lastRefreshLatencyMs! <= 500, 'Successful compile must request browser refresh within 500 ms');
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), file.toString(), 'Automatic refresh must restore code focus');
    await devTools!.screenshot(path.join(artifacts, 'preview-after.png'));
    checks.push('Dart save automatically compiles and visibly updates page');
    phase = 'compile failure retains the existing document';
    const beforeFailure = api.getStatus();
    const retainedDocument = await devTools!.documentId();
    await replace(`${original}\ninvalid dart syntax !!!`);
    await until(() => api.getStatus().state === 'failed' || (api.getStatus().lastCompilation?.operationId ?? 0) > (beforeFailure.lastCompilation?.operationId ?? 0), 45000);
    const failedCompile = api.getStatus();
    assert.equal(failedCompile.state, 'running', failedCompile.error);
    assert(failedCompile.lastCompilation && failedCompile.lastCompilation.code !== 0, 'The invalid edit must produce a failed compilation');
    assert.equal(failedCompile.refreshCount, beforeFailure.refreshCount, 'A failed compilation must not refresh the browser');
    assert.equal(await devTools!.documentId(), retainedDocument, 'A failed compilation must preserve the current document');
    const retainedText = await devTools!.text();
    assert(retainedText.includes('Preview version 2'), `Failed compilation lost the previous page: ${retainedText}`);
    phase = 'repair and remaining lifecycle checks';
    await replace(original.replace('Preview version 1', 'Preview version 3'));
    await rendered('Preview version 3'); checks.push('compiler failure retains page, save repairs it');
    await filesConfig.update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Workspace);
    await filesConfig.update('autoSaveDelay', 300, vscode.ConfigurationTarget.Workspace);
    const beforeAutoSave = api.getStatus();
    await replace(original.replace('Preview version 1', 'Preview version auto'), false);
    await until(() => !document.isDirty, 5000); await wait(1000);
    assert.equal(api.getStatus().state, 'running', 'Auto Save must not start a compilation by default');
    assert.equal(api.getStatus().lastCompilation?.operationId, beforeAutoSave.lastCompilation?.operationId);
    assert.equal(api.getStatus().refreshCount, beforeAutoSave.refreshCount);
    assert((await devTools!.text()).includes('Preview version 3'), 'Auto Save must retain the preview by default');
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('workbench.action.files.save');
    await rendered('Preview version auto'); checks.push('Auto Save retains the page by default; explicit save updates it even after Auto Save');
    await config.update('reloadOnAutoSave', true, vscode.ConfigurationTarget.Workspace);
    await replace(original.replace('Preview version 1', 'Preview version auto enabled'), false);
    await rendered('Preview version auto enabled'); checks.push('reloadOnAutoSave opt-in updates the page on Auto Save');
    await filesConfig.update('autoSave', 'off', vscode.ConfigurationTarget.Workspace);
    await config.update('reloadOnSave', false, vscode.ConfigurationTarget.Workspace);
    await replace(original.replace('Preview version 1', 'Preview version disabled')); await wait(700);
    assert((await devTools!.text()).includes('Preview version auto enabled'));
    await config.update('reloadOnSave', true, vscode.ConfigurationTarget.Workspace);
    await replace(original.replace('Preview version 1', 'Preview version enabled'));
    await rendered('Preview version enabled'); checks.push('reloadOnSave changes take effect immediately');
    await config.update('reloadTimeout', 0, vscode.ConfigurationTarget.Workspace);
    await command('reload'); await until(() => !!api.getStatus().error?.includes('reloadTimeout'), 5000);
    assert.equal(api.getStatus().state, 'running');
    await config.update('reloadTimeout', 30000, vscode.ConfigurationTarget.Workspace);
    await replace(original.replace('Preview version 1', 'Preview version repaired'));
    await rendered('Preview version repaired'); checks.push('invalid live timeout is recoverable');
    await vscode.commands.executeCommand('workbench.action.browser.open', { reuseUrlFilter: `http://127.0.0.1:${testPort}/**` });
    const previous = vscode.window.tabGroups.activeTabGroup.activeTab; assert(previous);
    await vscode.commands.executeCommand('workbench.action.moveEditorToNextGroup'); await wait(400);
    assert.equal(api.getStatus().state, 'running');
    const moved = vscode.window.tabGroups.activeTabGroup.activeTab; assert(moved);
    await until(() => !api.getStatus().browserAvailable, 5000);
    await command('openBrowser');
    await until(() => api.getStatus().browserAvailable, 5000);
    await replace(original.replace('Preview version 1', 'Preview version 4'));
    await rendered('Preview version 4');
    checks.push('unavailable ownership pauses updates; explicit browser open safely rebinds');
    devTools?.close(); devTools = undefined;
    await vscode.window.tabGroups.close(moved); await until(() => api.getStatus().state === 'stopped', 15000); await checkPort(testPort);
    const tabCount = vscode.window.tabGroups.all.flatMap(group => [...group.tabs]).length;
    await replace(original); await wait(600);
    assert.equal(api.getStatus().state, 'stopped'); assert.equal(vscode.window.tabGroups.all.flatMap(group => [...group.tabs]).length, tabCount);
    checks.push('move retains session; close stops and releases port; later save does not restart');
    const cycles = Number(process.env.PREVIEW_STRESS_CYCLES ?? 0);
    for (let cycle = 0; cycle < cycles; cycle++) {
      await command('run', file);
      await until(() => api.getStatus().state === 'running' || api.getStatus().state === 'failed');
      assert.equal(api.getStatus().state, 'running', api.getStatus().error);
      await until(() => vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input === undefined)), 10000);
      await wait(150);
      if (cycle % 3 === 0) {
        await command('restart');
        await until(() => api.getStatus().state === 'running' || api.getStatus().state === 'failed');
        assert.equal(api.getStatus().state, 'running', api.getStatus().error);
        await command('stop');
      } else if (cycle % 3 === 1) {
        await vscode.commands.executeCommand('workbench.action.browser.open', { reuseUrlFilter: `http://127.0.0.1:${testPort}/**` });
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab; assert(tab);
        await vscode.window.tabGroups.close(tab);
        await until(() => api.getStatus().state === 'stopped', 15000);
      } else await command('stop');
      assert.equal(api.getStatus().state, 'stopped'); await checkPort(testPort);
      console.log(`STRESS CYCLE ${cycle + 1}/${cycles} PASSED`);
    }
    if (cycles) checks.push(`${cycles} Run/Stop/Restart/close cycles release the port`);
    await config.update('port', testPort + 1, vscode.ConfigurationTarget.Workspace);
    await command('restart');
    await until(() => api.getStatus().state === 'running' && api.getStatus().browserAvailable, 180000);
    assert(new URL(api.getStatus().url!).port === String(testPort + 1), 'Restart must read the new port setting');
    await checkPort(testPort);
    await command('stop'); await checkPort(testPort + 1);
    checks.push('Restart reads fresh startup settings and releases both ports');
    console.log(`E2E PASSED: ${checks.join('; ')}`);
  } catch (error) {
    const failure = { phase, checks: [...checks], error: error instanceof Error ? error.stack : String(error), status: api.getStatus(), browser: devTools?.diagnostics() };
    // Persist the original failure before any diagnostic CDP request or cleanup.
    await writeFile(path.join(artifacts, 'e2e-failure.json'), JSON.stringify(failure, null, 2));
    const page = await devTools?.text().catch(problem => `Cannot read page: ${String(problem)}`);
    await devTools?.screenshot(path.join(artifacts, 'e2e-failure.png')).catch(() => {});
    await writeFile(path.join(artifacts, 'e2e-failure.json'), JSON.stringify({ ...failure, page, browser: devTools?.diagnostics() }, null, 2));
    throw error;
  } finally {
    devTools?.close(); await command('stop'); await replace(original);
    await writeFile(path.join(artifacts, 'e2e-checks.json'), JSON.stringify({ checks, status: api.getStatus(), vscode: vscode.version, sdk: process.env.FLUTTER_SDK_PATH ?? 'PATH' }, null, 2));
    await config.update('flutterSdkPath', initialSdk, vscode.ConfigurationTarget.Workspace);
    await config.update('reloadOnSave', initialReload, vscode.ConfigurationTarget.Workspace);
    await config.update('reloadOnAutoSave', initialReloadOnAutoSave, vscode.ConfigurationTarget.Workspace);
    await config.update('reloadTimeout', initialTimeout, vscode.ConfigurationTarget.Workspace);
    await config.update('port', initialPort, vscode.ConfigurationTarget.Workspace);
    await filesConfig.update('autoSave', initialAutoSave, vscode.ConfigurationTarget.Workspace);
    await filesConfig.update('autoSaveDelay', initialAutoSaveDelay, vscode.ConfigurationTarget.Workspace);
  }
}

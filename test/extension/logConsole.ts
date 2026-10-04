import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import type { PreviewApi } from '../../src/extension';
import { checkPort } from '../../src/flutter/flutterRuntime';
import { DevTools } from './devTools';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>, timeout = 180000) {
  const start = Date.now();
  while (!await predicate()) { if (Date.now() - start > timeout) throw new Error('Log console test timed out'); await wait(100); }
}
interface Output { session: vscode.DebugSession; body: { output?: string; variablesReference?: number } }
function rootSession(session: vscode.DebugSession): vscode.DebugSession { while (session.parentSession) session = session.parentSession; return session; }

export async function logConsoleTest(): Promise<void> {
  const extension = vscode.extensions.getExtension<PreviewApi>('wende.flutter-web-preview'); assert(extension);
  const api = await extension.activate();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; assert(root);
  const file = vscode.Uri.file(path.join(root, 'lib/main.dart'));
  const original = await readFile(file.fsPath, 'utf8');
  const artifacts = process.env.PREVIEW_ARTIFACTS_DIR ?? path.join(extension.extensionPath, 'artifacts'); await mkdir(artifacts, { recursive: true });
  const document = await vscode.workspace.openTextDocument(file);
  const config = vscode.workspace.getConfiguration('flutterWebPreview', file);
  const initialSdk = config.inspect<string>('flutterSdkPath')?.workspaceValue;
  const records: Output[] = []; const sessions = new Map<string, vscode.DebugSession>(); const checks: string[] = [];
  const terminated = new Set<string>();
  const terminations = vscode.debug.onDidTerminateDebugSession(session => terminated.add(session.id));
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker(session) {
      const root = rootSession(session);
      if (!root.configuration.flutterWebPreviewLogToken && root.configuration.name !== 'Unrelated browser') return;
      sessions.set(session.id, session);
      return { onDidSendMessage(message) { if (message.type === 'event' && message.event === 'output' && message.body.category !== 'telemetry') records.push({ session, body: message.body }); } };
    },
  });
  let preview: DevTools | undefined; let workbench: DevTools | undefined;
  let unrelated: vscode.DebugSession | undefined;
  const command = (name: string, ...args: unknown[]) => vscode.commands.executeCommand(`flutterWebPreview.${name}`, ...args);
  const server = createServer((_request, response) => { response.end('<title>Unrelated browser</title>Unrelated'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const otherUrl = `http://127.0.0.1:${address.port}/`;
  const replace = async (text: string) => {
    const edit = new vscode.WorkspaceEdit(); edit.replace(file, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    assert(await vscode.workspace.applyEdit(edit)); assert(await document.save());
  };
  const ready = async () => {
    await until(() => api.getStatus().state === 'failed' || api.getStatus().error?.includes('Cannot connect preview logs') || (api.getStatus().state === 'running' && api.getStatus().logConsoleConnected));
    assert.equal(api.getStatus().state, 'running', api.getStatus().error);
    assert.equal(api.getStatus().error, undefined);
    preview?.close(); preview = await DevTools.connect(api.getStatus().url!);
    await until(async () => (await preview!.text()).includes('Emit preview logs'), 60000);
  };
  const emitAndCheck = async () => {
    // A real user clicks the visible browser, which may currently be behind a text tab.
    const url = new URL(api.getStatus().url!);
    if (!vscode.window.tabGroups.activeTabGroup.activeTab?.label.includes(url.host)) {
      await vscode.commands.executeCommand('workbench.action.browser.open', { reuseUrlFilter: `${url.origin}/**` });
      await wait(500); await ready();
    }
    records.length = 0;
    await preview!.click('Emit preview logs');
    const output = () => records.filter(record => rootSession(record.session).configuration.flutterWebPreviewLogToken).map(record => record.body.output ?? '').join('');
    await until(() => output().includes('异步 developer.log 中文'), 15000);
    for (const text of ['点击 print 中文', '第二行', '点击 debugPrint 中文', '点击 developer.log 中文', '异步 print 中文', '异步 debugPrint 中文', '异步 developer.log 中文']) assert(output().includes(text), `Missing ${text}: ${output()}`);
    assert.equal(output().split('重复消息').length - 1, 2, 'Identical application messages must be delivered twice, without duplicate subscriptions');
    assert(output().includes('preview-fixture')); assert(output().includes('900'));
    const object = records.find(record => record.body.output?.includes('点击 developer.log 中文'));
    assert(object && object.body.variablesReference, 'Developer log metadata must be expandable');
    const variables = await object.session.customRequest('variables', { variablesReference: object.body.variablesReference });
    const metadata = JSON.stringify(variables);
    for (const field of ['message', 'name', 'level', 'error', 'stackTrace']) assert(metadata.includes(field), `Developer log must preserve ${field}`);
    assert(!records.some(record => rootSession(record.session).configuration.name === 'Unrelated browser'), 'Preview logs must not enter the unrelated session');
  };
  try {
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    if (process.env.FLUTTER_SDK_PATH) await config.update('flutterSdkPath', process.env.FLUTTER_SDK_PATH, vscode.ConfigurationTarget.Workspace);
    await command('run', file); await ready();
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), file.toString(), 'Initial log attachment must preserve editor focus');
    workbench = await DevTools.connect('vscode-file://');
    assert(await workbench.evaluate(`!!document.querySelector('.repl')`), 'Run must automatically open Debug Console');
    await command('showDebugConsole');
    assert(await workbench.evaluate(`!!document.querySelector('.repl')`), 'Show Debug Console must keep an already open console visible');
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    await emitAndCheck();
    await until(async () => String(await workbench!.evaluate(`document.querySelector('.repl')?.innerText`)).includes('异步 developer.log 中文'), 10000);
    await workbench.screenshot(path.join(artifacts, 'debug-console-logs.png'));
    checks.push('Real Flutter click and async print/debugPrint/developer.log reach DAP and visible Debug Console; Chinese, multiline, duplicates, expandable metadata');

    const ownerToken = () => [...sessions.values()].filter(session => !session.parentSession && session.configuration.flutterWebPreviewLogToken).at(-1)!.configuration.flutterWebPreviewLogToken;
    const token = ownerToken();
    await command('run', file); await command('openBrowser'); await wait(500); await ready();
    assert.equal(ownerToken(), token, 'Repeated Run/Open must reuse logging session');
    await emitAndCheck();
    await command('reloadBrowser'); await wait(500); await ready(); await emitAndCheck();
    assert.equal(ownerToken(), token, 'Browser reload must reuse logging session');
    await vscode.window.showTextDocument(document);
    await replace(original.replace('Preview version 1', 'Preview logs saved'));
    await until(async () => api.getStatus().state === 'running' && (await preview!.text()).includes('Preview logs saved'), 60000);
    await wait(500); await ready();
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), file.toString(), 'Save refresh must preserve editor focus');
    await emitAndCheck(); assert.equal(ownerToken(), token);
    checks.push('Repeated Run/Open, browser reload, and Dart save keep a single logging session and editor focus');

    await command('restart'); await until(() => api.getStatus().state === 'stopping' || !api.getStatus().logConsoleConnected, 10000);
    await ready(); assert.notEqual(ownerToken(), token); await emitAndCheck();
    checks.push('Restart establishes a fresh logging session and captures application logs');

    await vscode.commands.executeCommand('workbench.action.browser.open', { url: otherUrl, openToSide: true });
    assert(await vscode.debug.startDebugging(undefined, { type: 'editor-browser', request: 'attach', name: 'Unrelated browser', urlFilter: `${otherUrl}*`, noDebug: true }, { noDebug: true, suppressDebugToolbar: true }));
    unrelated = [...sessions.values()].find(session => !session.parentSession && session.configuration.name === 'Unrelated browser'); assert(unrelated);
    await emitAndCheck();
    await command('stop'); await until(() => api.getStatus().state === 'stopped', 15000); await checkPort(7357);
    await until(() => [...sessions.values()].filter(session => rootSession(session).configuration.flutterWebPreviewLogToken).every(session => terminated.has(session.id)), 15000);
    assert(!terminated.has(unrelated.id), 'Stop must preserve unrelated debugger');
    const other = await DevTools.connect(otherUrl);
    await other.evaluate(`console.log('Unrelated debugger remains connected')`); other.close();
    await until(() => records.some(record => rootSession(record.session).id === unrelated!.id && record.body.output?.includes('Unrelated debugger remains connected')), 5000);
    checks.push('Other browser and active debug session remain isolated; Stop releases Flutter port');

    await command('run', file); await ready();
    await vscode.debug.stopDebugging([...sessions.values()].filter(session => !session.parentSession && session.configuration.flutterWebPreviewLogToken).at(-1));
    await until(() => api.getStatus().state === 'stopped', 15000); await checkPort(7357);
    checks.push('Stopping the owned logging session stops the preview and releases the port');
    await command('run', file); await ready();
    await vscode.commands.executeCommand('workbench.action.browser.open', { reuseUrlFilter: `${new URL(api.getStatus().url!).origin}/**` });
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab; assert(tab); await vscode.window.tabGroups.close(tab);
    await until(() => api.getStatus().state === 'stopped', 15000); await checkPort(7357);
    checks.push('Closing preview cleans up log session and Flutter');
    console.log(`LOG CONSOLE PASSED: ${checks.join('; ')}`);
  } catch (error) {
    await writeFile(path.join(artifacts, 'log-console-failure.json'), JSON.stringify({ error: String(error), status: api.getStatus(), sessions: [...sessions.values()].map(session => ({ id: session.id, parent: session.parentSession?.id, configuration: session.configuration, ended: terminated.has(session.id) })), output: records.map(record => ({ session: record.session.id, body: record.body })), page: await preview?.evaluate(`[...document.querySelectorAll('[role="button"],button')].map(node => ({ html: node.outerHTML, rect: node.getBoundingClientRect().toJSON() }))`).catch(() => undefined) }, null, 2));
    if (preview) await preview.screenshot(path.join(artifacts, 'log-console-failure.png')).catch(() => {});
    throw error;
  } finally {
    preview?.close(); workbench?.close();
    await command('stop'); if (unrelated) await vscode.debug.stopDebugging(unrelated);
    await replace(original); await config.update('flutterSdkPath', initialSdk, vscode.ConfigurationTarget.Workspace);
    tracker.dispose(); terminations.dispose(); await new Promise<void>(resolve => server.close(() => resolve()));
    await writeFile(path.join(artifacts, 'log-console-checks.json'), JSON.stringify({ checks, status: api.getStatus(), vscode: vscode.version, sdk: process.env.FLUTTER_SDK_PATH, output: records.map(record => ({ name: record.session.name, body: record.body })) }, null, 2));
  }
}

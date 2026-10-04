import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { IntegratedBrowser } from '../../src/browser/integratedBrowser';
import { FlutterProcessRuntime, checkPort } from '../../src/flutter/flutterRuntime';
import { PreviewSessionController } from '../../src/core/controller';
import { sessionId } from '../../src/core/types';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function run(): Promise<void> {
  if (process.env.PREVIEW_TEST_MODE === 'browser') { await browserLifecycle(); return; }
  if (process.env.PREVIEW_TEST_MODE === 'runtime') { await runtimeLifecycle(); return; }
  const trace: unknown[] = [];
  const snapshot = () => vscode.window.tabGroups.all.map(group => ({ column: group.viewColumn, active: group.isActive, tabs: group.tabs.map(tab => ({ label: tab.label, input: tab.input, active: tab.isActive })) }));
  const listener = vscode.window.tabGroups.onDidChangeTabs(event => trace.push({ event: 'tabs', opened: event.opened.map(t => t.label), closed: event.closed.map(t => t.label), changed: event.changed.map(t => t.label), snapshot: snapshot() }));
  const groups = vscode.window.tabGroups.onDidChangeTabGroups(() => trace.push({ event: 'groups', snapshot: snapshot() }));
  try {
    const commands = await vscode.commands.getCommands(true);
    assert(commands.includes('workbench.action.browser.open'));
    assert(commands.includes('workbench.action.browser.reload'));
    await vscode.commands.executeCommand('workbench.action.browser.open', { url: 'http://127.0.0.1:7357', openToSide: true, reuseUrlFilter: 'http://127.0.0.1:7357/**' });
    await wait(800);
    const original = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert(original, 'Browser open must activate a tab');
    trace.push({ event: 'bound', input: original.input, snapshot: snapshot() });
    await vscode.commands.executeCommand('workbench.action.moveEditorToNextGroup');
    await wait(500);
    const moved = vscode.window.tabGroups.activeTabGroup.activeTab;
    trace.push({ event: 'moved', sameIdentity: moved === original, originalStillPresent: vscode.window.tabGroups.all.some(g => g.tabs.includes(original)), snapshot: snapshot() });
    assert(moved, 'Moved browser must be an active tab');
    await vscode.window.tabGroups.close(moved);
    await wait(400);
    trace.push({ event: 'closed', snapshot: snapshot() });
  } finally {
    listener.dispose(); groups.dispose();
    const root = vscode.extensions.getExtension('wende.flutter-web-preview')?.extensionPath;
    assert(root);
    await mkdir(path.join(root, 'artifacts'), { recursive: true });
    await writeFile(path.join(root, 'artifacts/browser-probe.json'), JSON.stringify(trace, null, 2));
  }
}

async function until(predicate: () => boolean, timeout = 180000): Promise<void> {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) throw new Error('Test condition timed out.'); await wait(50); }
}

async function runtimeLifecycle(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; assert(root);
  const file = path.join(root, 'lib', 'main.dart'); const original = await readFile(file, 'utf8');
  const log: string[] = []; const report: string[] = [];
  const runtime = new FlutterProcessRuntime(text => { log.push(text); console.log(text); });
  const browser: IntegratedBrowser = new IntegratedBrowser(id => controller && sessionId(controller.current.state) === id && !['stopping', 'stopped', 'failed'].includes(controller.current.state.kind), text => { log.push(text); console.log(text); });
  const controller: PreviewSessionController = new PreviewSessionController(runtime, browser, message => { report.push(message); console.log(message); }, console.log);
  try {
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    controller.dispatch({ type: 'RUN', spec: { projectRoot: root, entrypoint: file, sdkPath: process.env.FLUTTER_SDK_PATH ?? 'D:\\flutter\\flutter', port: 7357, startupTimeout: 180000, reloadTimeout: 30000 } });
    await until(() => controller.current.state.kind === 'running' || controller.current.state.kind === 'failed');
    assert.equal(controller.current.state.kind, 'running', report.join('\n'));
    await until(() => !!browser.currentTab || report.length > 0, 5000);
    assert(browser.currentTab);
    await writeFile(file, original.replace('Preview version 1', 'Preview version 2'));
    controller.save(20);
    await until(() => log.some(text => text.includes('Preview browser refreshed.')) || report.length > 0, 45000);
    assert.equal(report.length, 0, report.join('\n'));
    await browser.open(sessionId(controller.current.state)!, controller.current.context.url!);
    await vscode.commands.executeCommand('workbench.action.browser.open', { reuseUrlFilter: 'http://127.0.0.1:7357/**' });
    await vscode.commands.executeCommand('workbench.action.moveEditorToNextGroup'); await wait(400);
    assert.equal(controller.current.state.kind, 'running');
    assert(browser.currentTab);
    await vscode.window.tabGroups.close(browser.currentTab!);
    await until(() => controller.current.state.kind === 'stopped', 15000);
    await checkPort(7357);
    console.log('FLUTTER RUNTIME LIFECYCLE PASSED');
  } finally {
    await writeFile(file, original); await controller.dispose(); browser.dispose();
    const extensionRoot = vscode.extensions.getExtension('wende.flutter-web-preview')?.extensionPath; assert(extensionRoot);
    await writeFile(path.join(extensionRoot, 'artifacts/runtime-test.json'), JSON.stringify({ log, report, finalState: controller.current.state }, null, 2));
  }
}

async function browserLifecycle(): Promise<void> {
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<html><head><title>Preview fixture</title></head><body>Preview fixture</body></html>'); });
  await new Promise<void>(resolve => server.listen(7357, '127.0.0.1', resolve));
  let closed = 0; let active = true;
  const browser = new IntegratedBrowser(() => active, console.log);
  browser.events.subscribe(event => { if (event.type === 'BROWSER_CLOSED') { closed++; active = false; } });
  try {
    await IntegratedBrowser.checkSupport();
    await browser.open('browser-test', 'http://127.0.0.1:7357/');
    const tab = browser.currentTab; assert(tab);
    await browser.refresh('browser-test');
    await vscode.commands.executeCommand('workbench.action.moveEditorToNextGroup');
    await wait(500);
    assert.equal(closed, 0, 'Moving the preview must not stop it');
    assert(browser.currentTab && browser.currentTab !== tab, 'Move must rebind the new tab object');
    await browser.refresh('browser-test');
    await vscode.window.tabGroups.close(browser.currentTab!);
    await wait(250);
    assert.equal(closed, 1, 'Actual close must emit exactly one session-close event');
    const count = vscode.window.tabGroups.all.flatMap(group => [...group.tabs]).length;
    await browser.refresh('browser-test'); await wait(100);
    assert.equal(vscode.window.tabGroups.all.flatMap(group => [...group.tabs]).length, count, 'Refresh after close must not recreate a tab');
    console.log('BROWSER LIFECYCLE PASSED');
  } finally { await browser.release('browser-test'); browser.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

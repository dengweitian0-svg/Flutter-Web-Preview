import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function run(): Promise<void> {
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

import * as vscode from 'vscode';
import { Signal } from '../core/signal';
import type { BrowserEvent, PreviewBrowser } from '../core/types';
import { TabTracker } from './tabTracker';

interface Binding { sessionId: string; bindingId: string; url: string; tracker: TabTracker<vscode.Tab>; ownershipReported?: boolean }
export class IntegratedBrowser implements PreviewBrowser {
  readonly events = new Signal<BrowserEvent>();
  private binding?: Binding;
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();
  private reconcileTimer?: ReturnType<typeof setTimeout>;
  private readonly subscriptions: vscode.Disposable[];
  constructor(private readonly active: (id: string) => boolean, private readonly log: (text: string) => void) {
    this.subscriptions = [vscode.window.tabGroups.onDidChangeTabs(() => this.observe()), vscode.window.tabGroups.onDidChangeTabGroups(() => this.observe())];
  }
  static async checkSupport(): Promise<void> {
    const commands = await vscode.commands.getCommands(true);
    for (const command of ['workbench.action.browser.open', 'workbench.action.browser.reload']) {
      if (!commands.includes(command)) throw new Error('This VS Code version cannot control Integrated Browser. Upgrade to VS Code 1.140 or later.');
    }
  }
  private tabs(): vscode.Tab[] { return vscode.window.tabGroups.all.flatMap(group => [...group.tabs]); }
  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.tail.then(task); this.tail = next.catch(() => {}); return next;
  }
  private observe(): void {
    const binding = this.binding;
    if (!binding?.tracker.current) return;
    binding.tracker.observe(this.tabs(), tab => tab.input === undefined, Date.now());
    clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      if (this.binding !== binding) return;
      const result = binding.tracker.reconcile(this.tabs());
      if (result === 'closed') {
        binding.tracker.clear();
        this.events.emit({ type: 'BROWSER_CLOSED', sessionId: binding.sessionId, bindingId: binding.bindingId });
      } else if (result === 'ambiguous') {
        if (!binding.ownershipReported) {
          binding.ownershipReported = true;
          this.events.emit({ type: 'BROWSER_ERROR', sessionId: binding.sessionId, bindingLost: true, message: 'Preview tab identity changed. Automatic updates are paused. Use Open Preview Browser to rebind, or Stop Web Preview.' });
        }
      }
    }, 75);
  }
  async open(id: string, url: string): Promise<void> {
    const generation = this.generation;
    return this.enqueue(async () => {
      if (!this.active(id) || generation !== this.generation) return;
      const previous = vscode.window.activeTextEditor;
      const selection = previous?.selections;
      const uri = new URL(url);
      if (uri.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(uri.hostname)) throw new Error('Only the local Flutter preview can be opened.');
      await vscode.commands.executeCommand('workbench.action.browser.open', { url, openToSide: true, reuseUrlFilter: `${uri.origin}/**` });
      // Editor and extension-host tab models are synchronized asynchronously.
      const tab = await this.activeBrowserTab();
      if (!tab) throw new Error('Integrated Browser opened without a trackable tab.');
      if (!this.active(id) || generation !== this.generation) {
        await vscode.window.tabGroups.close(tab, true); return;
      }
      const old = this.binding;
      const tracker = new TabTracker<vscode.Tab>(); tracker.bind(tab, this.tabs());
      const bindingId = old?.sessionId === id ? old.bindingId : `browser-${++this.generation}`;
      this.binding = { sessionId: id, bindingId, url, tracker };
      this.events.emit({ type: 'BROWSER_OPENED', sessionId: id, bindingId });
      if (previous && this.active(id) && this.tabs().some(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === previous.document.uri.toString())) {
        const editor = await vscode.window.showTextDocument(previous.document, { viewColumn: previous.viewColumn, preserveFocus: false });
        if (selection) editor.selections = selection;
      }
    });
  }
  private async activeBrowserTab(): Promise<vscode.Tab | undefined> {
    for (let count = 0; count < 20; count++) {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (tab && tab.input === undefined) return tab;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  async refresh(id: string, completedAt?: number): Promise<void> {
    return this.enqueue(async () => {
      const binding = this.binding;
      if (!binding || binding.sessionId !== id || !this.active(id)) return;
      const result = binding.tracker.reconcile(this.tabs());
      if (result === 'closed') {
        binding.tracker.clear();
        this.events.emit({ type: 'BROWSER_CLOSED', sessionId: id, bindingId: binding.bindingId }); return;
      }
      if (result === 'ambiguous') throw new Error('Preview tab ownership is ambiguous. Open the preview again.');
      const tab = binding.tracker.current;
      if (!tab) return;
      const previous = vscode.window.activeTextEditor;
      const selection = previous?.selections;
      const index = tab.group.tabs.indexOf(tab);
      // Focus the recorded tab using public editor commands; open would recreate a closed tab.
      for (let attempt = 0; vscode.window.tabGroups.activeTabGroup !== tab.group && attempt <= vscode.window.tabGroups.all.length; attempt++) {
        if (!this.active(id) || !this.tabs().includes(tab)) return;
        await vscode.commands.executeCommand('workbench.action.focusNextGroup');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', index);
      await new Promise(resolve => setTimeout(resolve, 25));
      if (!this.active(id) || this.binding !== binding || !this.tabs().includes(tab)) return;
      if (vscode.window.tabGroups.activeTabGroup.activeTab !== tab) throw new Error('Cannot focus the owned preview tab.');
      const latencyMs = completedAt === undefined ? undefined : Date.now() - completedAt;
      await vscode.commands.executeCommand('workbench.action.browser.reload');
      this.log('Preview browser refreshed.\n');
      if (previous && this.active(id) && !previous.document.isClosed) {
        const editor = await vscode.window.showTextDocument(previous.document, { viewColumn: previous.viewColumn, preserveFocus: false });
        if (selection) editor.selections = selection;
      }
      if (this.active(id) && this.binding === binding) this.events.emit({ type: 'BROWSER_REFRESHED', sessionId: id, bindingId: binding.bindingId, latencyMs });
    });
  }
  async release(id: string): Promise<void> {
    if (this.binding?.sessionId === id) { this.generation++; this.binding.tracker.clear(); this.binding = undefined; }
    clearTimeout(this.reconcileTimer);
    await this.tail;
  }
  get currentTab(): vscode.Tab | undefined { return this.binding?.tracker.current; }
  dispose(): void {
    this.generation++; clearTimeout(this.reconcileTimer); this.binding?.tracker.clear(); this.binding = undefined;
    for (const subscription of this.subscriptions) subscription.dispose(); this.events.clear();
  }
}

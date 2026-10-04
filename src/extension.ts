import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Flutter Web Preview');
  context.subscriptions.push(output);
  output.appendLine('Flutter Web Preview activated.');
}

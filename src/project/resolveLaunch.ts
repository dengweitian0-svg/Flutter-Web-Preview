import * as vscode from 'vscode';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { LaunchSpec } from '../core/types';
import { exists, flutterProjectAt, nearestProject, within } from './flutterProject';
import { mainOffsets } from '../ui/dartMain';

export async function sdkRoot(resource: vscode.Uri): Promise<string> {
  const configured = vscode.workspace.getConfiguration('flutterWebPreview', resource).get<string>('flutterSdkPath');
  const dart = vscode.workspace.getConfiguration('dart', resource).get<string>('flutterSdkPath');
  const candidates = [configured, dart, ...(process.env.PATH ?? '').split(path.delimiter).map(bin => path.dirname(bin))].filter((entry): entry is string => !!entry);
  for (const candidate of candidates) if (await exists(path.join(candidate, 'bin', 'flutter.bat'))) {
    const versionFile = path.join(candidate, 'bin', 'cache', 'flutter.version.json');
    if (await exists(versionFile)) {
      const version = JSON.parse(await readFile(versionFile, 'utf8')) as { frameworkVersion?: string };
      const parts = version.frameworkVersion?.match(/^(\d+)\.(\d+)/);
      if (parts && (Number(parts[1]) < 3 || Number(parts[1]) === 3 && Number(parts[2]) < 35)) throw new Error('Flutter 3.35 or later is required.');
    }
    return realpath(candidate);
  }
  throw new Error('Flutter SDK was not found. Set flutterWebPreview.flutterSdkPath to its root directory.');
}
export function numericSetting(config: vscode.WorkspaceConfiguration, name: string, fallback: number, min: number, max: number): number {
  const value = config.get<number>(name, fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`flutterWebPreview.${name} must be an integer between ${min} and ${max}.`);
  return value;
}
export async function resolveLaunch(uri?: vscode.Uri): Promise<LaunchSpec | undefined> {
  if (process.platform !== 'win32') throw new Error('Flutter Web Preview 0.1 supports local Windows only.');
  if (vscode.env.remoteName) throw new Error('Remote workspaces are not supported in 0.1. Open a local Windows workspace.');
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running its Flutter application.');
  const file = uri ?? vscode.window.activeTextEditor?.document.uri;
  let root: string | undefined;
  if (file?.scheme === 'file' && file.fsPath.endsWith('.dart')) {
    const workspace = vscode.workspace.getWorkspaceFolder(file);
    if (workspace) root = await nearestProject(file.fsPath, workspace.uri.fsPath);
  }
  if (!root) {
    const pubspecs = await vscode.workspace.findFiles('**/pubspec.yaml', '**/{.git,.dart_tool,build,.cache,node_modules}/**', 1000);
    const candidates: string[] = [];
    for (const pubspec of pubspecs) { const candidate = path.dirname(pubspec.fsPath); if (await flutterProjectAt(candidate)) candidates.push(candidate); }
    if (!candidates.length) throw new Error('No Flutter Web application found. The project needs Flutter dependencies, lib/ and web/.');
    if (candidates.length === 1) root = candidates[0];
    else root = (await vscode.window.showQuickPick(candidates.map(candidate => ({ label: path.basename(candidate), description: candidate, root: candidate })), { placeHolder: 'Select a Flutter Web project' }))?.root;
    if (!root) return;
  }
  const resource = vscode.Uri.file(root);
  const config = vscode.workspace.getConfiguration('flutterWebPreview', resource);
  let entrypoint = path.resolve(root, config.get<string>('entrypoint', 'lib/main.dart'));
  if (file?.scheme === 'file' && within(file.fsPath, root) && file.fsPath.endsWith('.dart') && mainOffsets(await readFile(file.fsPath, 'utf8')).length) entrypoint = file.fsPath;
  if (!within(entrypoint, root) || !await exists(entrypoint)) throw new Error(`Flutter entrypoint does not exist inside this project: ${entrypoint}`);
  if (await nearestProject(entrypoint, root) !== await realpath(root)) throw new Error('The entrypoint belongs to a different nested package.');
  return { projectRoot: await realpath(root), entrypoint: await realpath(entrypoint), sdkPath: await sdkRoot(resource), port: numericSetting(config, 'port', 7357, 1024, 65535), startupTimeout: numericSetting(config, 'startupTimeout', 180000, 1000, 3600000), reloadTimeout: numericSetting(config, 'reloadTimeout', 30000, 1000, 3600000) };
}

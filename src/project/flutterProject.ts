import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

export async function exists(file: string): Promise<boolean> { try { await access(file); return true; } catch { return false; } }
export function within(file: string, root: string): boolean {
  const relative = path.relative(root.toLowerCase(), file.toLowerCase());
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
export async function flutterProjectAt(root: string): Promise<boolean> {
  try {
    const value: unknown = parse(await readFile(path.join(root, 'pubspec.yaml'), 'utf8'));
    if (!value || typeof value !== 'object') return false;
    const dependencies = (value as { dependencies?: { flutter?: { sdk?: unknown } } }).dependencies;
    return dependencies?.flutter?.sdk === 'flutter' && await exists(path.join(root, 'lib')) && await exists(path.join(root, 'web'));
  } catch { return false; }
}
export async function nearestProject(file: string, boundary: string): Promise<string | undefined> {
  let current = path.dirname(await realpath(file));
  const limit = await realpath(boundary);
  while (within(current, limit)) {
    if (await exists(path.join(current, 'pubspec.yaml'))) return await flutterProjectAt(current) ? current : undefined;
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
export async function belongsToProject(file: string, root: string): Promise<boolean> {
  if (!within(file, root)) return false;
  const relative = path.relative(root, file);
  if (relative.split(path.sep).some(part => ['.dart_tool', 'build', '.git', '.cache'].includes(part))) return false;
  try {
    const actualRoot = await realpath(root);
    return await nearestProject(file, root) === actualRoot;
  } catch { return false; }
}

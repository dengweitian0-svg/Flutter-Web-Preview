import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { nearestProject, belongsToProject, within } from '../../src/project/flutterProject';
describe('Flutter project boundaries', () => {
  it('rejects similarly prefixed directories and path traversal', () => {
    expect(within('D:/app-other/lib/main.dart', 'D:/app')).toBe(false);
    expect(within('D:/app/../other/main.dart', 'D:/app')).toBe(false);
    expect(within('D:/APP/lib/main.dart', 'd:/app')).toBe(true);
  });
  it('finds the nearest valid package and does not cross a nested package boundary', async () => {
    const root = await mkdtemp(path.resolve('.cache/project-test-'));
    try {
      await mkdir(path.join(root, 'lib'), { recursive: true }); await mkdir(path.join(root, 'web'));
      await writeFile(path.join(root, 'pubspec.yaml'), 'dependencies:\n  flutter:\n    sdk: flutter\n');
      const main = path.join(root, 'lib', 'main.dart'); await writeFile(main, 'void main() {}');
      expect(await nearestProject(main, root)).toBe(root); expect(await belongsToProject(main, root)).toBe(true);
      const nested = path.join(root, 'packages', 'nested'); await mkdir(nested, { recursive: true });
      await writeFile(path.join(nested, 'pubspec.yaml'), 'name: nested\n'); const file = path.join(nested, 'nested.dart'); await writeFile(file, '');
      expect(await nearestProject(file, root)).toBeUndefined(); expect(await belongsToProject(file, root)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

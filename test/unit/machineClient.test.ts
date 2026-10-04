import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachineClient } from '../../src/flutter/machineClient';
import { flutterCommand } from '../../src/flutter/windowsProcess';
import { spawnFlutter } from '../../src/flutter/windowsProcess';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
afterEach(() => vi.useRealTimers());
describe('machine protocol', () => {
  it('buffers chunks, parses multiple messages and leaves ordinary output visible', () => {
    const log = vi.fn(); const client = new MachineClient(vi.fn(), log); const events = vi.fn(); client.events.subscribe(events);
    client.feed('Launching\n[{"event":"app.st'); client.feed('art","params":{"appId":"a"}}]\n[{"event":"app.started"}]\n');
    expect(events).toHaveBeenCalledTimes(2); expect(log).toHaveBeenCalledWith('Launching\n'); client.close();
  });
  it('correlates responses even when returned out of order', async () => {
    const write = vi.fn(); const client = new MachineClient(write, vi.fn());
    const first = client.request('one', {}, 1000); const second = client.request('two', {}, 1000);
    client.feed('[{"id":2,"result":{"code":1}},{"id":1,"result":{"code":0}}]\n');
    await expect(first).resolves.toEqual({ code: 0 }); await expect(second).resolves.toEqual({ code: 1 });
    expect(JSON.parse(write.mock.calls[0]![0])[0].id).toBe(1); client.close();
  });
  it('rejects protocol errors and cancels waiting requests on exit', async () => {
    const client = new MachineClient(vi.fn(), vi.fn()); const error = client.request('bad', {}, 1000);
    client.feed('[{"id":1,"error":"unsupported"}]\n'); await expect(error).rejects.toThrow('unsupported');
    const waiting = client.request('pending', {}, 1000); client.close(); await expect(waiting).rejects.toThrow('ended');
  });
  it('times out without treating a late response as success', async () => {
    vi.useFakeTimers(); const client = new MachineClient(vi.fn(), vi.fn());
    const pending = client.request('app.restart', {}, 1000); const rejected = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1000); await rejected; client.feed('[{"id":1,"result":{"code":0}}]\n'); client.close();
  });
});
describe('Windows launcher', () => {
  it.skipIf(process.platform !== 'win32')('runs a batch file with spaces, Chinese and ampersands in real paths', async () => {
    const root = await mkdtemp(path.resolve('.cache/SDK 中文 & tools-'));
    try {
      await mkdir(path.join(root, 'bin'));
      await writeFile(path.join(root, 'bin', 'flutter.bat'), '@echo off\r\necho ARG="%~2"\r\n');
      const child = spawnFlutter(root, ['--target', 'lib/main & page.dart'], root);
      let output = ''; child.stdout.on('data', data => { output += String(data); });
      const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      expect(code).toBe(0); expect(output).toContain('ARG="lib/main & page.dart"');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('quotes SDK and target paths including spaces, Chinese and shell metacharacters', () => {
    const command = flutterCommand('D:\\Flutter SDK 中文 & tools', ['run', '--target', 'lib/main file.dart']);
    expect(command).toContain('"D:\\Flutter SDK 中文 & tools\\bin\\flutter.bat"');
    expect(command).toContain('"lib/main file.dart"'); expect(command.startsWith('""')).toBe(true);
  });
  it.each(['bad%PATH%', 'bad"quote', 'bad\ncommand'])('rejects expansion or quote injection: %s', target => {
    expect(() => flutterCommand('D:\\flutter', ['--target', target])).toThrow();
  });
});

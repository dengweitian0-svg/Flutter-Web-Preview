import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

// CMD expands percent expressions even inside quotes. Never accept them as path/argument input.
export function flutterCommand(sdkPath: string, args: string[]): string {
  const executable = path.join(sdkPath, 'bin', 'flutter.bat');
  const quote = (value: string) => {
    if (/["%\r\n\0]/.test(value)) throw new Error('Flutter paths cannot contain quotes, percent signs or control characters.');
    return `"${value}"`;
  };
  return `"${[executable, ...args].map(quote).join(' ')}"`;
}
export function commandInterpreter(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ComSpec) return env.ComSpec;
  const windowsRoot = env.SystemRoot || env.windir;
  if (!windowsRoot) throw new Error('Cannot locate cmd.exe. Set ComSpec or SystemRoot in the Windows environment.');
  return path.win32.join(windowsRoot, 'System32', 'cmd.exe');
}
export function spawnFlutter(sdkPath: string, args: string[], cwd: string): ChildProcessWithoutNullStreams {
  return spawn(commandInterpreter(), ['/d', '/v:off', '/s', '/c', flutterCommand(sdkPath, args)], {
    cwd, windowsHide: true, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
}
export async function killProcessTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid managed Flutter PID.');
  await new Promise<void>((resolve, reject) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    let output = '';
    killer.stdout.on('data', chunk => { output += String(chunk); });
    killer.stderr.on('data', chunk => { output += String(chunk); });
    killer.on('error', reject);
    killer.on('close', code => code === 0 ? resolve() : reject(new Error(`Cannot terminate managed Flutter process ${pid}: ${output.trim()}`)));
  });
}

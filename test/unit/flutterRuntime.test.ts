import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { FlutterProcessRuntime, checkPort } from '../../src/flutter/flutterRuntime';
import type { LaunchSpec } from '../../src/core/types';

async function fakeSdk(program: string): Promise<{ root: string; spec: LaunchSpec }> {
  const root = await mkdtemp(path.resolve('.cache/runtime-test-'));
  await mkdir(path.join(root, 'bin'));
  const encoded = Buffer.from(program).toString('base64');
  await writeFile(path.join(root, 'bin', 'flutter.bat'), `@echo off\r\n"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString())" -- %*\r\n`);
  return { root, spec: { projectRoot: root, entrypoint: 'lib/main.dart', sdkPath: root, port: 7369, startupTimeout: 10000, reloadTimeout: 1000 } };
}
describe.skipIf(process.platform !== 'win32')('managed Flutter process cleanup', () => {
  it('uses local web resources and the restart compiler while keeping incremental compilation failures recoverable', async () => {
    const fixture = await fakeSdk(`
      require('node:fs').writeFileSync('args.json', JSON.stringify(process.argv.slice(1)));
      process.stdout.write(JSON.stringify([{event:'app.start',params:{appId:'app'}}])+'\\n');
      let count = 0;
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const request = JSON.parse(line)[0];
        if (request.method === 'app.stop') process.exit(0);
        require('node:fs').writeFileSync('request.json', JSON.stringify(request));
        process.stdout.write(JSON.stringify([{id:request.id,result:{code:count++ === 0 ? 1 : 0,message:'result'}}])+'\\n');
      });
    `);
    const runtime = new FlutterProcessRuntime(() => {});
    const ready = new Promise<void>(resolve => runtime.events.subscribe(event => { if (event.type === 'APP_ID') resolve(); }));
    try {
      await runtime.start('updates', fixture.spec); await ready;
      const args = JSON.parse(await readFile(path.join(fixture.root, 'args.json'), 'utf8')) as string[];
      expect(args).toEqual(expect.arrayContaining(['--machine', 'web-server', '--no-web-resources-cdn', '--no-web-experimental-hot-reload', '--no-web-enable-expression-evaluation']));
      expect(args).not.toContain('--no-pub');
      expect(await runtime.recompile('updates', 'save', 1000)).toMatchObject({ code: 1 });
      expect(await runtime.recompile('updates', 'save', 1000)).toMatchObject({ code: 0 });
      const request = JSON.parse(await readFile(path.join(fixture.root, 'request.json'), 'utf8'));
      expect(request).toMatchObject({ method: 'app.restart', params: { appId: 'app', fullRestart: true } });
    } finally { await runtime.stop('updates'); await rm(fixture.root, { recursive: true, force: true }); }
  });
  it('cancels a start before the process is created', async () => {
    const fixture = await fakeSdk("require('node:fs').writeFileSync('started.txt','yes')");
    const runtime = new FlutterProcessRuntime(() => {});
    try {
      const start = runtime.start('cancelled', fixture.spec);
      const stop = runtime.stop('cancelled');
      await start; await stop;
      await expect(readFile(path.join(fixture.root, 'started.txt'))).rejects.toThrow();
      await checkPort(fixture.spec.port);
    } finally { await runtime.stop('cancelled'); await rm(fixture.root, { recursive: true, force: true }); }
  });
  it('returns malformed protocol URLs as failure events and still shuts down', async () => {
    const fixture = await fakeSdk("process.stdout.write(JSON.stringify([{event:'app.webLaunchUrl',params:{url:'invalid'}}])+'\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));");
    const runtime = new FlutterProcessRuntime(() => {});
    const fatal = new Promise<string>(resolve => runtime.events.subscribe(event => { if (event.type === 'FATAL') resolve(event.message); }));
    try {
      await runtime.start('invalid-url', fixture.spec);
      await expect(fatal).resolves.toContain('invalid preview URL');
      await runtime.stop('invalid-url');
    } finally { await runtime.stop('invalid-url'); await rm(fixture.root, { recursive: true, force: true }); }
  });
  it('terminates the owned process tree when graceful shutdown is ignored', async () => {
    const fixture = await fakeSdk("require('node:fs').writeFileSync('child.pid',String(process.pid));process.stdin.resume();setInterval(()=>{},1000);");
    const runtime = new FlutterProcessRuntime(() => {});
    try {
      await runtime.start('defiant', fixture.spec);
      let pid = 0;
      for (let attempt = 0; attempt < 50 && !pid; attempt++) {
        try { pid = Number(await readFile(path.join(fixture.root, 'child.pid'), 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      expect(pid).toBeGreaterThan(0);
      await runtime.stop('defiant');
      expect(() => process.kill(pid, 0)).toThrow();
      await checkPort(fixture.spec.port);
    } finally { await runtime.stop('defiant'); await rm(fixture.root, { recursive: true, force: true }); }
  }, 15000);
});

import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { Signal } from '../core/signal';
import type { CompileResult, FlutterRuntime, LaunchSpec, RuntimeEvent } from '../core/types';
import { MachineClient } from './machineClient';
import { killProcessTree, spawnFlutter } from './windowsProcess';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

interface ProcessSession {
  id: string; cancelled: boolean; appId?: string; process?: ChildProcessWithoutNullStreams;
  startedAt: number;
  client?: MachineClient; launch?: Promise<void>; stopping?: Promise<void>;
  exited: Promise<void>; resolveExit(): void; closed: boolean;
}
export async function checkPort(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', error => reject(new Error(`Port ${port} is unavailable. Change flutterWebPreview.port. ${error.message}`)));
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
  });
}
export class FlutterProcessRuntime implements FlutterRuntime {
  readonly events = new Signal<RuntimeEvent>();
  private session?: ProcessSession;
  constructor(private readonly log: (text: string) => void) {}
  async start(id: string, spec: LaunchSpec): Promise<void> {
    if (this.session) throw new Error('The previous Flutter process has not been cleaned up.');
    let resolveExit = () => {};
    const exited = new Promise<void>(resolve => { resolveExit = resolve; });
    const session: ProcessSession = { id, cancelled: false, closed: false, exited, resolveExit, startedAt: Date.now() };
    this.session = session;
    session.launch = this.launch(session, spec);
    return session.launch;
  }
  private async launch(session: ProcessSession, spec: LaunchSpec): Promise<void> {
    try {
      await access(path.join(spec.sdkPath, 'bin', 'flutter.bat'));
      await checkPort(spec.port);
      if (session.cancelled) return;
      // web-server cannot apply stateful hot reload. The restart-oriented AMD
      // compiler avoids the library-bundle overhead on full page reloads.
      // Serve the renderer locally and omit Dart debugger evaluation metadata;
      // application console logging uses the browser debugger independently.
      const args = ['--suppress-analytics', 'run', '--machine', '-d', 'web-server', '--no-web-resources-cdn', '--no-web-experimental-hot-reload', '--no-web-enable-expression-evaluation', '--web-hostname', '127.0.0.1', '--web-port', String(spec.port), '--target', spec.entrypoint];
      this.log(`Starting Flutter in ${spec.projectRoot}\nflutter ${args.join(' ')}\n`);
      const child = spawnFlutter(spec.sdkPath, args, spec.projectRoot);
      session.process = child;
      const client = new MachineClient(text => {
        if (!child.stdin.writable) throw new Error('Flutter stdin is unavailable.');
        child.stdin.write(text);
      }, this.log);
      session.client = client;
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => client.feed(String(chunk)));
      child.stderr.on('data', chunk => this.log(String(chunk)));
      child.stdin.on('error', error => { if (!session.cancelled) this.events.emit({ type: 'FATAL', sessionId: session.id, message: `Flutter stdin failed: ${error.message}` }); });
      child.on('error', error => {
        this.finish(session);
        if (!session.cancelled) this.events.emit({ type: 'FATAL', sessionId: session.id, message: `Cannot start Flutter: ${error.message}` });
      });
      child.on('close', (code, signal) => {
        this.log(`Flutter exited: code=${code}, signal=${signal}\n`);
        this.finish(session);
        if (!session.cancelled) this.events.emit({ type: 'FATAL', sessionId: session.id, message: `Flutter exited unexpectedly (code ${code}). See Flutter Web Preview output.` });
      });
      client.events.subscribe(message => {
        const params = message.params;
        switch (message.event) {
          case 'app.start':
            if (typeof params.appId === 'string') { session.appId = params.appId; this.events.emit({ type: 'APP_ID', sessionId: session.id, appId: params.appId }); }
            break;
          case 'app.webLaunchUrl': {
            if (typeof params.url !== 'string') break;
            let url: URL;
            try { url = new URL(params.url); }
            catch { this.events.emit({ type: 'FATAL', sessionId: session.id, message: 'Flutter returned an invalid preview URL.' }); break; }
            if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port) !== spec.port) {
              this.events.emit({ type: 'FATAL', sessionId: session.id, message: 'Flutter returned an unexpected preview URL.' }); break;
            }
            this.events.emit({ type: 'URL', sessionId: session.id, url: url.href });
            break;
          }
          case 'app.started':
            this.log(`Flutter server ready (${Date.now() - session.startedAt} ms since start; browser rendering continues separately).\n`);
            this.events.emit({ type: 'STARTED', sessionId: session.id }); break;
          case 'app.log': if (typeof params.log === 'string') this.log(`${params.log}\n`); break;
          case 'daemon.logMessage': if (typeof params.message === 'string') this.log(`${params.message}\n`); break;
          case 'app.progress': if (typeof params.message === 'string') this.log(`${params.message}\n`); break;
          case 'app.stop':
            if (!session.cancelled) this.events.emit({ type: 'FATAL', sessionId: session.id, message: 'Flutter application stopped.' });
            break;
        }
      });
    } catch (error) {
      if (!session.process) this.finish(session);
      throw error;
    }
  }
  private finish(session: ProcessSession): void {
    if (session.closed) return;
    session.closed = true; session.client?.close(); session.resolveExit();
  }
  async recompile(id: string, reason: 'save' | 'manual', timeout: number): Promise<CompileResult> {
    const session = this.session;
    if (!session || session.id !== id || session.cancelled || !session.appId || !session.client) throw new Error('Flutter is not ready for updates.');
    const start = Date.now();
    const result = await session.client.request('app.restart', { appId: session.appId, fullRestart: true, pause: false, reason }, timeout);
    const completedAt = Date.now();
    if (!result || typeof result !== 'object' || typeof (result as Record<string, unknown>).code !== 'number') throw new Error('Flutter returned an invalid compilation response.');
    const value = result as Record<string, unknown>;
    this.log(`Compilation ${value.code === 0 ? 'succeeded' : 'failed'} (${Date.now() - start} ms).\n`);
    return { code: value.code as number, message: typeof value.message === 'string' ? value.message : undefined, completedAt };
  }
  async stop(id: string): Promise<void> {
    const session = this.session;
    if (!session || session.id !== id) return;
    session.cancelled = true;
    if (session.stopping) return session.stopping;
    session.stopping = this.cleanup(session);
    try { await session.stopping; } catch (error) { session.stopping = undefined; throw error; }
  }
  private async cleanup(session: ProcessSession): Promise<void> {
    await session.launch?.catch(() => {});
    const child = session.process;
    if (child && !session.closed) {
      if (session.appId && session.client) void session.client.request('app.stop', { appId: session.appId }, 4000).catch(error => this.log(`${String(error)}\n`));
      else child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([session.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]);
      clearTimeout(timer);
      if (!session.closed && child.pid) {
        await killProcessTree(child.pid);
        await Promise.race([session.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Flutter process tree did not finish after taskkill.')), 5000); })]);
        clearTimeout(timer);
      }
      if (!session.closed) throw new Error('Cannot confirm Flutter process exited.');
    }
    session.client?.close();
    if (this.session === session) this.session = undefined;
  }
}

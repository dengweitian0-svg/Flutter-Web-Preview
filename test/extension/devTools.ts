import { writeFile } from 'node:fs/promises';
export class TransientCdpError extends Error {}
function portSetting(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1024 || value > 65534) throw new Error(`Invalid ${name}: ${value}`);
  return value;
}
export const testPort = portSetting('PREVIEW_TEST_PORT', 7357);
const cdpPort = portSetting('PREVIEW_CDP_PORT', 9333);
export interface BrowserTarget { id: string; url: string; webSocketDebuggerUrl: string }
export class DevTools {
  private sequence = 0;
  private disconnected = false;
  private readonly events: { method: string; params?: unknown; at: number }[] = [];
  private readonly pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private constructor(private readonly socket: WebSocket, readonly target: BrowserTarget) {
    socket.onmessage = event => {
      const value = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: unknown; result?: Record<string, unknown>; error?: unknown };
      if (!value.id) {
        if (value.method) { this.events.push({ method: value.method, params: value.params, at: Date.now() }); if (this.events.length > 50) this.events.shift(); }
        return;
      }
      const request = this.pending.get(value.id); if (!request) return;
      clearTimeout(request.timer); this.pending.delete(value.id);
      if (value.error) {
        const message = JSON.stringify(value.error);
        request.reject(/Cannot find context|Execution context was destroyed|Inspected target navigated|Session closed|Target closed/i.test(message) ? new TransientCdpError(message) : new Error(message));
      } else request.resolve(value.result ?? {});
    };
    socket.onclose = () => this.disconnect(new TransientCdpError(`CDP connection closed: ${this.target.url}`));
    socket.onerror = () => this.disconnect(new TransientCdpError(`CDP connection failed: ${this.target.url}`));
  }
  static async connect(url: string, port = cdpPort, timeout = 10000): Promise<DevTools> {
    const deadline = Date.now() + timeout;
    const remaining = () => Math.max(1, deadline - Date.now());
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(remaining()) }).catch(error => {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' || (error.cause as { code?: string })?.code === 'ECONNREFUSED')) throw new TransientCdpError(`CDP target discovery interrupted: ${url}`);
      throw error;
    });
    if (!response.ok) throw new Error(`CDP target discovery failed: ${response.status}`);
    const targets = await response.json() as BrowserTarget[];
    const matches = targets.filter(target => target.url.startsWith(url));
    if (matches.length > 1) throw new Error(`Ambiguous browser target for ${url}: ${matches.map(t => t.id).join(', ')}`);
    const target = matches[0];
    if (!target) throw new TransientCdpError(`No rendered browser target for ${url}: ${targets.map(t => t.url).join(', ')}`);
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new TransientCdpError(`CDP connection timed out: ${url}`)); socket.close(); }, remaining());
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = socket.onclose = () => { clearTimeout(timer); reject(new TransientCdpError(`CDP connection failed: ${url}`)); };
    });
    const client = new DevTools(socket, target);
    try { await client.request('Page.enable', {}, remaining()); return client; }
    catch (error) { client.close(); throw error; }
  }
  request(method: string, params: Record<string, unknown> = {}, timeout = 10000): Promise<Record<string, unknown>> {
    if (this.disconnected) return Promise.reject(new TransientCdpError(`CDP disconnected: ${this.target.url}`));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new TransientCdpError(`CDP ${method} timed out: ${this.target.url}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async text(timeout = 10000): Promise<string> {
    const expression = `(() => {
      function collect(node) {
        if (node.nodeType === 3) return node.textContent || '';
        if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return '';
        if (['SCRIPT', 'STYLE'].includes(node.nodeName)) return '';
        return (node.getAttribute?.('aria-label') || '') + ' ' + [...node.childNodes].map(collect).join(' ') + (node.shadowRoot ? collect(node.shadowRoot) : '');
      }
      return collect(document);
    })()`;
    return String(await this.evaluate(expression, timeout) ?? '');
  }
  async evaluate(expression: string, timeout = 10000): Promise<unknown> {
    const result = await this.request('Runtime.evaluate', { expression, returnByValue: true }, timeout);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return (result.result as { value?: unknown })?.value;
  }
  async documentId(timeout = 10000): Promise<string> {
    const response = await this.request('Page.getFrameTree', {}, timeout);
    return (response.frameTree as { frame: { loaderId: string } }).frame.loaderId;
  }
  diagnostics(): unknown { return { target: this.target, disconnected: this.disconnected, events: [...this.events] }; }
  async click(label: string): Promise<void> {
    await this.request('Page.bringToFront');
    const layoutFrame = () => this.request('Runtime.evaluate', { expression: 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))', awaitPromise: true, returnByValue: true });
    await layoutFrame();
    const expression = `(() => {
      const button = [...document.querySelectorAll('[role="button"],button')].find(node => (node.getAttribute('aria-label') || node.textContent || '').includes(${JSON.stringify(label)}));
      if (!button) return null;
      const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`;
    let point: { x: number; y: number } | undefined;
    const start = Date.now();
    while (!point) {
      point = await this.evaluate(expression) as typeof point;
      if (Date.now() - start > 15000) throw new Error(`No rendered button: ${label}`);
      if (!point) await new Promise(resolve => setTimeout(resolve, 100));
    }
    await this.request('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    // Hover can initialize Flutter semantics and change the button's layout.
    await layoutFrame();
    const hoveredPoint = await this.evaluate(expression) as typeof point;
    if (!hoveredPoint) throw new Error(`Button disappeared before click: ${label}`);
    this.events.push({ method: 'test.click', params: { label, beforeHover: point, afterHover: hoveredPoint }, at: Date.now() });
    if (this.events.length > 50) this.events.shift();
    point = hoveredPoint;
    await this.request('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await this.request('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    // Flutter 3.35 defers semantic pointer initialization to the next event loop.
    await new Promise(resolve => setTimeout(resolve, 60));
    await this.request('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  async screenshot(file: string): Promise<void> {
    const result = await this.request('Page.captureScreenshot', { format: 'png' });
    if (typeof result.data !== 'string') throw new Error('CDP screenshot returned no data.');
    await writeFile(file, Buffer.from(result.data, 'base64'));
  }
  private disconnect(error: Error): void {
    this.disconnected = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  close(): void { this.disconnect(new TransientCdpError('CDP closed.')); this.socket.close(); }
}

export interface DocumentExpectation { previousDocument?: string; retainedDocument?: string }
/** Retry only navigation/connection failures; evaluation and assertion failures stay visible. */
export async function waitForText(connection: { current?: DevTools }, url: string, expected: string, timeout = 60000, { previousDocument, retainedDocument }: DocumentExpectation = {}): Promise<void> {
  const deadline = Date.now() + timeout;
  const remaining = () => Math.max(1, Math.min(10000, deadline - Date.now()));
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      connection.current ??= await DevTools.connect(url, cdpPort, remaining());
      const client = connection.current;
      const document = await client.documentId(remaining());
      if (retainedDocument && document !== retainedDocument) throw new Error(`Page document changed from ${retainedDocument} to ${document} while it must be retained.`);
      if ((!previousDocument || document !== previousDocument) && await client.evaluate('document.readyState', remaining()) === 'complete' && (await client.text(remaining())).includes(expected)) {
        if (retainedDocument) {
          const currentDocument = await client.documentId(remaining());
          if (currentDocument !== retainedDocument) throw new Error(`Page document changed from ${retainedDocument} to ${currentDocument} while it must be retained.`);
        }
        if (Date.now() <= deadline) return;
      }
      last = `Document ${document} does not yet contain ${expected}`;
    } catch (error) {
      if (!(error instanceof TransientCdpError)) throw error;
      last = error; connection.current?.close(); connection.current = undefined;
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(100, deadline - Date.now()))));
  }
  throw new Error(`Page did not render ${expected} within ${timeout} ms: ${String(last)}`);
}

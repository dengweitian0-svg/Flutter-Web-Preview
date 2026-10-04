import { writeFile } from 'node:fs/promises';
export class DevTools {
  private sequence = 0;
  private readonly pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = event => {
      const value = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: unknown };
      if (!value.id) return;
      const request = this.pending.get(value.id); if (!request) return;
      clearTimeout(request.timer); this.pending.delete(value.id);
      if (value.error) request.reject(new Error(JSON.stringify(value.error))); else request.resolve(value.result ?? {});
    };
  }
  static async connect(url: string, port = 9333): Promise<DevTools> {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { url: string; webSocketDebuggerUrl: string }[];
    const target = targets.find(target => target.url.startsWith(url));
    if (!target) throw new Error(`No rendered browser target for ${url}: ${targets.map(t => t.url).join(', ')}`);
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('CDP connection failed.')); });
    return new DevTools(socket);
  }
  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 10000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async text(): Promise<string> {
    const expression = `(() => {
      function collect(node) {
        if (node.nodeType === 3) return node.textContent || '';
        if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return '';
        if (['SCRIPT', 'STYLE'].includes(node.nodeName)) return '';
        return (node.getAttribute?.('aria-label') || '') + ' ' + [...node.childNodes].map(collect).join(' ') + (node.shadowRoot ? collect(node.shadowRoot) : '');
      }
      return collect(document);
    })()`;
    const response = await this.request('Runtime.evaluate', { expression, returnByValue: true });
    return String((response.result as { value?: unknown })?.value ?? '');
  }
  async evaluate(expression: string): Promise<unknown> {
    const result = await this.request('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return (result.result as { value?: unknown })?.value;
  }
  async screenshot(file: string): Promise<void> {
    const result = await this.request('Page.captureScreenshot', { format: 'png' });
    if (typeof result.data !== 'string') throw new Error('CDP screenshot returned no data.');
    await writeFile(file, Buffer.from(result.data, 'base64'));
  }
  close(): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP closed.')); }
    this.pending.clear(); this.socket.close();
  }
}

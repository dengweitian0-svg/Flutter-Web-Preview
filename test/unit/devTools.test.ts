import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevTools, TransientCdpError, waitForText } from '../extension/devTools';

class TestSocket {
  static current: TestSocket;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  evaluateResult: Record<string, unknown> = { result: { value: 'Preview version 2' } };
  ignoreEvaluation = false;
  constructor() { TestSocket.current = this; queueMicrotask(() => this.onopen?.()); }
  send(data: string) {
    const request = JSON.parse(data) as { id: number; method: string };
    if (request.method === 'Runtime.evaluate' && this.ignoreEvaluation) return;
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: request.id, result: request.method === 'Runtime.evaluate' ? this.evaluateResult : {} }) }));
  }
  close() { this.onclose?.(); }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function installSocket() {
  vi.stubGlobal('WebSocket', TestSocket);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [{ id: 'page', url: 'http://localhost/', webSocketDebuggerUrl: 'ws://localhost/' }] })));
}
describe('CDP page verification', () => {
  it('reports evaluation exceptions rather than turning them into empty page text', async () => {
    installSocket(); const client = await DevTools.connect('http://localhost/');
    TestSocket.current.evaluateResult = { exceptionDetails: { text: 'Page evaluation failed' } };
    await expect(client.text()).rejects.toThrow('Page evaluation failed'); client.close();
  });
  it('rejects an outstanding request immediately when its socket closes', async () => {
    installSocket(); const client = await DevTools.connect('http://localhost/');
    TestSocket.current.ignoreEvaluation = true;
    const pending = client.text(); const rejected = expect(pending).rejects.toBeInstanceOf(TransientCdpError);
    TestSocket.current.close(); await rejected;
  });
  it('returns a retryable timeout for a request that never responds', async () => {
    installSocket(); const client = await DevTools.connect('http://localhost/');
    vi.useFakeTimers(); TestSocket.current.ignoreEvaluation = true;
    const rejected = expect(client.text()).rejects.toBeInstanceOf(TransientCdpError);
    await vi.advanceTimersByTimeAsync(10000); await rejected; client.close();
  });
  it('uses the new button coordinates when hover changes its layout', async () => {
    installSocket(); const client = await DevTools.connect('http://localhost/');
    vi.spyOn(client, 'evaluate').mockResolvedValueOnce({ x: 10, y: 20 }).mockResolvedValueOnce({ x: 30, y: 40 });
    const request = vi.spyOn(client, 'request').mockResolvedValue({});
    await client.click('Emit preview logs');
    expect(request).toHaveBeenCalledWith('Input.dispatchMouseEvent', { type: 'mousePressed', x: 30, y: 40, button: 'left', clickCount: 1 });
    expect(request).toHaveBeenCalledWith('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 30, y: 40, button: 'left', clickCount: 1 });
    client.close();
  });
  it('refuses to select an arbitrary page when multiple targets match', async () => {
    installSocket();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [
      { id: 'one', url: 'http://localhost/', webSocketDebuggerUrl: 'ws://localhost/one' },
      { id: 'two', url: 'http://localhost/', webSocketDebuggerUrl: 'ws://localhost/two' },
    ] })));
    await expect(DevTools.connect('http://localhost/')).rejects.toThrow('Ambiguous browser target');
  });
  it('reconnects after a transient read failure and waits for a new, complete document', async () => {
    const stale = { documentId: vi.fn(async () => 'old'), evaluate: vi.fn(async () => 'complete'), text: vi.fn(async () => 'Preview version 2'), close: vi.fn() };
    const fresh = { documentId: vi.fn(async () => 'new'), evaluate: vi.fn(async () => 'complete'), text: vi.fn(async () => 'Preview version 2'), close: vi.fn() };
    stale.documentId.mockResolvedValueOnce('old').mockRejectedValueOnce(new TransientCdpError('Navigation interrupted'));
    vi.spyOn(DevTools, 'connect').mockResolvedValueOnce(stale as unknown as DevTools).mockResolvedValueOnce(fresh as unknown as DevTools);
    const connection: { current?: DevTools } = {};
    await waitForText(connection, 'http://localhost/', 'Preview version 2', 2000, { previousDocument: 'old' });
    expect(stale.text).not.toHaveBeenCalled(); expect(stale.close).toHaveBeenCalledOnce();
    expect(fresh.text).toHaveBeenCalledOnce(); expect(connection.current).toBe(fresh);
  });
  it('does not retry a real evaluation error', async () => {
    const client = { documentId: vi.fn(async () => 'new'), evaluate: vi.fn(async () => { throw new Error('Broken expression'); }), close: vi.fn() };
    const connect = vi.spyOn(DevTools, 'connect').mockResolvedValue(client as unknown as DevTools);
    await expect(waitForText({}, 'http://localhost/', 'Version', 1000)).rejects.toThrow('Broken expression');
    expect(connect).toHaveBeenCalledOnce();
  });
  it('keeps a live target connection across restarts and requires the new document', async () => {
    const client = { documentId: vi.fn().mockResolvedValueOnce('old').mockResolvedValue('new'), evaluate: vi.fn(async () => 'complete'), text: vi.fn(async () => 'Emit preview logs'), close: vi.fn() };
    const discovery = vi.spyOn(DevTools, 'connect').mockRejectedValue(new TransientCdpError('Discovery is unavailable'));
    const connection = { current: client as unknown as DevTools };
    await waitForText(connection, 'http://localhost/', 'Emit preview logs', 2000, { previousDocument: 'old' });
    expect(client.documentId).toHaveBeenCalledTimes(2);
    expect(client.text).toHaveBeenCalledOnce();
    expect(discovery).not.toHaveBeenCalled(); expect(client.close).not.toHaveBeenCalled();
    expect(connection.current).toBe(client);
  });
  it('fails at its total deadline when the document never becomes ready', async () => {
    const client = { documentId: vi.fn(async () => 'new'), evaluate: vi.fn(async () => 'loading') };
    vi.spyOn(DevTools, 'connect').mockResolvedValue(client as unknown as DevTools);
    await expect(waitForText({}, 'http://localhost/', 'Version', 50)).rejects.toThrow('within 50 ms');
  });
  it('waits for transiently empty semantics text while retaining the same document', async () => {
    const client = { documentId: vi.fn(async () => 'retained'), evaluate: vi.fn(async () => 'complete'), text: vi.fn().mockResolvedValueOnce('').mockResolvedValue('Old page') };
    await waitForText({ current: client as unknown as DevTools }, 'http://localhost/', 'Old page', 2000, { retainedDocument: 'retained' });
    expect(client.text).toHaveBeenCalledTimes(2);
    expect(client.documentId).toHaveBeenCalledTimes(3);
  });
  it('fails immediately if a retained document navigates even when the expected text exists', async () => {
    const client = { documentId: vi.fn(async () => 'new'), evaluate: vi.fn(async () => 'complete'), text: vi.fn(async () => 'Old page') };
    await expect(waitForText({ current: client as unknown as DevTools }, 'http://localhost/', 'Old page', 2000, { retainedDocument: 'old' })).rejects.toThrow('Page document changed');
    expect(client.documentId).toHaveBeenCalledOnce(); expect(client.text).not.toHaveBeenCalled();
  });
  it('rejects navigation that occurs during the retained page text read', async () => {
    const client = { documentId: vi.fn().mockResolvedValueOnce('old').mockResolvedValue('new'), evaluate: vi.fn(async () => 'complete'), text: vi.fn(async () => 'Old page') };
    await expect(waitForText({ current: client as unknown as DevTools }, 'http://localhost/', 'Old page', 2000, { retainedDocument: 'old' })).rejects.toThrow('Page document changed');
    expect(client.text).toHaveBeenCalledOnce(); expect(client.documentId).toHaveBeenCalledTimes(2);
  });
});

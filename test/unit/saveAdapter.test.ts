import { describe, expect, it, vi } from 'vitest';
import { TextDocumentSaveReason, type Uri } from 'vscode';
import { SaveAdapter, type SaveTarget } from '../../src/saves/saveAdapter';

vi.mock('vscode', () => ({ TextDocumentSaveReason: { Manual: 1, AfterDelay: 2, FocusOut: 3 } }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  let target: SaveTarget | undefined = { sessionId: 'preview-1', projectRoot: 'D:/app' };
  const request = vi.fn();
  const belongs = vi.fn(async () => true);
  const adapter = new SaveAdapter({ target: () => target, isCurrent: captured => captured.sessionId === target?.sessionId, belongs, request });
  const document = {
    uri: { scheme: 'file', fsPath: 'D:/app/lib/main.dart' } as Uri,
    fileName: 'D:/app/lib/main.dart', version: 1, isDirty: true, isClosed: false,
    save: vi.fn(async () => { document.isDirty = false; return true; }),
  };
  return { adapter, document, request, belongs, setTarget: (value?: SaveTarget) => { target = value; } };
}

describe('explicit save intent and native save events', () => {
  it('updates once after a successful save with no will-save notification', async () => {
    const app = setup();
    app.document.save.mockImplementation(async () => {
      app.document.isDirty = false;
      await app.adapter.didSave(app.document);
      return true;
    });
    expect(await app.adapter.saveAndReload(app.document)).toBe(true);
    expect(app.document.save).toHaveBeenCalledTimes(1);
    expect(app.request).toHaveBeenCalledExactlyOnceWith({ sessionId: 'preview-1', projectRoot: 'D:/app' }, TextDocumentSaveReason.Manual);
  });

  it('suppresses the passive path before a slow project lookup can cause a second update', async () => {
    const app = setup(); const lookup = deferred<boolean>(); const saved = deferred<boolean>();
    app.belongs.mockReturnValue(lookup.promise);
    app.document.save.mockImplementation(async () => {
      app.adapter.willSave(app.document, TextDocumentSaveReason.Manual);
      app.document.isDirty = false;
      void app.adapter.didSave(app.document);
      return saved.promise;
    });
    const operation = app.adapter.saveAndReload(app.document);
    await Promise.resolve();
    expect(app.belongs).not.toHaveBeenCalled(); expect(app.request).not.toHaveBeenCalled();
    saved.resolve(true); await Promise.resolve(); await Promise.resolve();
    lookup.resolve(true); await operation;
    expect(app.request).toHaveBeenCalledTimes(1);
    // A later native save is independent; it must no longer be suppressed.
    app.adapter.willSave(app.document, TextDocumentSaveReason.Manual);
    await app.adapter.didSave(app.document);
    expect(app.request).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent commands for the same document and session', async () => {
    const app = setup(); const saved = deferred<boolean>();
    app.document.save.mockImplementation(async () => { const result = await saved.promise; app.document.isDirty = false; return result; });
    const first = app.adapter.saveAndReload(app.document);
    const second = app.adapter.saveAndReload(app.document);
    expect(first).toBe(second); saved.resolve(true); await first;
    expect(app.document.save).toHaveBeenCalledTimes(1); expect(app.request).toHaveBeenCalledTimes(1);
  });

  it('updates an already saved document without waiting for another save event', async () => {
    const app = setup(); app.document.isDirty = false;
    expect(await app.adapter.saveAndReload(app.document)).toBe(true);
    expect(app.document.save).not.toHaveBeenCalled(); expect(app.request).toHaveBeenCalledTimes(1);
  });

  it('saves a newer edit requested while the first project lookup is pending', async () => {
    const app = setup(); const lookup = deferred<boolean>();
    app.belongs.mockReturnValueOnce(lookup.promise);
    const first = app.adapter.saveAndReload(app.document);
    await Promise.resolve(); await Promise.resolve();
    expect(app.belongs).toHaveBeenCalledTimes(1);
    app.document.version++; app.document.isDirty = true;
    const second = app.adapter.saveAndReload(app.document); expect(second).not.toBe(first);
    lookup.resolve(true); await first; await second;
    expect(app.document.save).toHaveBeenCalledTimes(2);
    expect(app.document.isDirty).toBe(false);
    expect(app.request).toHaveBeenCalledTimes(1);
  });

  it.each(['edit', 'close'] as const)('rechecks document state after the project lookup when there is a new %s', async change => {
    const app = setup(); const lookup = deferred<boolean>(); app.belongs.mockReturnValue(lookup.promise);
    const operation = app.adapter.saveAndReload(app.document);
    await Promise.resolve(); await Promise.resolve();
    if (change === 'edit') { app.document.version++; app.document.isDirty = true; }
    else app.document.isClosed = true;
    lookup.resolve(true); await operation; expect(app.request).not.toHaveBeenCalled();
  });

  it('does not turn a later Auto Save into the earlier manual update during a slow lookup', async () => {
    const app = setup(); const lookup = deferred<boolean>(); app.belongs.mockReturnValueOnce(lookup.promise);
    const manual = app.adapter.saveAndReload(app.document);
    await Promise.resolve(); await Promise.resolve();
    app.document.version++; app.document.isDirty = false;
    app.adapter.willSave(app.document, TextDocumentSaveReason.AfterDelay);
    await app.adapter.didSave(app.document);
    lookup.resolve(true); await manual;
    expect(app.request).toHaveBeenCalledExactlyOnceWith(expect.anything(), TextDocumentSaveReason.AfterDelay);
  });

  it('retains save participant edits but rejects newer changes after that saved version', async () => {
    const app = setup();
    app.document.save.mockImplementation(async () => {
      app.document.version++; app.document.isDirty = false;
      app.adapter.willSave(app.document, TextDocumentSaveReason.Manual);
      await app.adapter.didSave(app.document);
      return true;
    });
    await app.adapter.saveAndReload(app.document);
    expect(app.request).toHaveBeenCalledExactlyOnceWith(expect.anything(), TextDocumentSaveReason.Manual);
  });

  it('does not let old-session validation swallow a native save from a new session', async () => {
    const app = setup(); const lookup = deferred<boolean>(); app.belongs.mockReturnValueOnce(lookup.promise);
    const old = app.adapter.saveAndReload(app.document);
    await Promise.resolve(); await Promise.resolve();
    app.setTarget({ sessionId: 'preview-2', projectRoot: 'D:/app' });
    app.adapter.willSave(app.document, TextDocumentSaveReason.Manual);
    await app.adapter.didSave(app.document);
    lookup.resolve(true); await old;
    expect(app.request).toHaveBeenCalledExactlyOnceWith({ sessionId: 'preview-2', projectRoot: 'D:/app' }, TextDocumentSaveReason.Manual);
  });

  it('keeps ownership of in-flight save notifications after a session change', async () => {
    const app = setup(); const saved = deferred<boolean>();
    app.document.save.mockImplementation(async () => {
      await saved.promise; app.document.isDirty = false;
      app.adapter.willSave(app.document, TextDocumentSaveReason.Manual);
      await app.adapter.didSave(app.document);
      return true;
    });
    const old = app.adapter.saveAndReload(app.document); await Promise.resolve();
    app.setTarget({ sessionId: 'preview-2', projectRoot: 'D:/app' });
    saved.resolve(true); await old; expect(app.request).not.toHaveBeenCalled();
  });

  it('does not erase a newer native will-save reason when old validation completes', async () => {
    const app = setup(); const lookup = deferred<boolean>(); app.belongs.mockReturnValueOnce(lookup.promise);
    const old = app.adapter.saveAndReload(app.document);
    await Promise.resolve(); await Promise.resolve();
    app.setTarget({ sessionId: 'preview-2', projectRoot: 'D:/app' });
    app.adapter.willSave(app.document, TextDocumentSaveReason.Manual);
    lookup.resolve(true); await old;
    await app.adapter.didSave(app.document);
    expect(app.request).toHaveBeenCalledExactlyOnceWith({ sessionId: 'preview-2', projectRoot: 'D:/app' }, TextDocumentSaveReason.Manual);
  });

  it('suppresses in-flight save participant events even with a newer queued edit', async () => {
    const app = setup(); const saved = deferred<boolean>();
    app.document.save.mockImplementationOnce(async () => {
      await saved.promise; app.document.version++; app.document.isDirty = false;
      app.adapter.willSave(app.document, TextDocumentSaveReason.Manual);
      await app.adapter.didSave(app.document);
      return true;
    });
    const first = app.adapter.saveAndReload(app.document); await Promise.resolve();
    app.document.version++;
    const second = app.adapter.saveAndReload(app.document);
    saved.resolve(true); await Promise.all([first, second]);
    // The two explicit commands are independent; there is no passive third request.
    expect(app.request).toHaveBeenCalledTimes(2);
  });

  it('does not update on failed or cancelled saves and clears their reason', async () => {
    const app = setup();
    app.document.save.mockImplementation(async () => { app.adapter.willSave(app.document, TextDocumentSaveReason.Manual); return false; });
    expect(await app.adapter.saveAndReload(app.document)).toBe(false);
    expect(app.request).not.toHaveBeenCalled();
    await app.adapter.didSave(app.document);
    expect(app.request).toHaveBeenCalledExactlyOnceWith(expect.anything(), undefined);
  });

  it('cleans up after a rejected save so that a retry can update', async () => {
    const app = setup(); app.document.save.mockRejectedValueOnce(new Error('Disk full'));
    await expect(app.adapter.saveAndReload(app.document)).rejects.toThrow('Disk full');
    expect(app.request).not.toHaveBeenCalled();
    await app.adapter.saveAndReload(app.document); expect(app.request).toHaveBeenCalledTimes(1);
  });

  it.each(['stop', 'restart'] as const)('rejects an old save completing after %s', async action => {
    const app = setup(); const saved = deferred<boolean>();
    app.document.save.mockImplementation(async () => { await saved.promise; app.document.isDirty = false; return true; });
    const operation = app.adapter.saveAndReload(app.document); await Promise.resolve();
    app.setTarget(action === 'stop' ? undefined : { sessionId: 'preview-2', projectRoot: 'D:/app' });
    saved.resolve(true); await operation; expect(app.request).not.toHaveBeenCalled();
  });

  it.each(['explicit', 'native'] as const)('rechecks the session after asynchronous project validation for %s saves', async source => {
    const app = setup(); const lookup = deferred<boolean>(); app.belongs.mockReturnValue(lookup.promise);
    const operation = source === 'explicit' ? app.adapter.saveAndReload(app.document) : app.adapter.didSave(app.document);
    await Promise.resolve(); await Promise.resolve();
    app.setTarget({ sessionId: 'preview-2', projectRoot: 'D:/app' }); lookup.resolve(true); await operation;
    expect(app.request).not.toHaveBeenCalled();
  });

  it('allows a new explicit command in a new session without retargeting the pending operation', async () => {
    const app = setup(); const saved = deferred<boolean>();
    app.document.save.mockImplementation(async () => { await saved.promise; app.document.isDirty = false; return true; });
    const old = app.adapter.saveAndReload(app.document); await Promise.resolve();
    app.setTarget({ sessionId: 'preview-2', projectRoot: 'D:/app' });
    const current = app.adapter.saveAndReload(app.document); expect(old).not.toBe(current);
    saved.resolve(true); await Promise.all([old, current]);
    expect(app.request).toHaveBeenCalledExactlyOnceWith({ sessionId: 'preview-2', projectRoot: 'D:/app' }, TextDocumentSaveReason.Manual);
  });

  it.each([TextDocumentSaveReason.Manual, TextDocumentSaveReason.AfterDelay, TextDocumentSaveReason.FocusOut, undefined])('preserves native save reason %s without guessing', async reason => {
    const app = setup(); if (reason !== undefined) app.adapter.willSave(app.document, reason);
    await app.adapter.didSave(app.document);
    expect(app.request).toHaveBeenCalledExactlyOnceWith(expect.anything(), reason);
    app.request.mockClear(); await app.adapter.didSave(app.document);
    expect(app.request).toHaveBeenCalledExactlyOnceWith(expect.anything(), undefined);
  });

  it.each(['other-project', 'non-dart', 'non-file', 'no-session'])('saves %s documents without updating the preview', async kind => {
    const app = setup();
    if (kind === 'other-project') app.belongs.mockResolvedValue(false);
    if (kind === 'non-dart') app.document.fileName = 'D:/app/README.md';
    if (kind === 'non-file') app.document.uri = { scheme: 'untitled' } as Uri;
    if (kind === 'no-session') app.setTarget();
    await app.adapter.saveAndReload(app.document);
    expect(app.document.save).toHaveBeenCalledTimes(1); expect(app.request).not.toHaveBeenCalled();
  });

  it('does not refresh unsaved changes made while the save was in flight', async () => {
    const app = setup(); app.document.save.mockResolvedValue(true);
    await app.adapter.saveAndReload(app.document); expect(app.request).not.toHaveBeenCalled();
  });

  it('does not save a closed document or update after disposal', async () => {
    const app = setup(); app.document.isClosed = true;
    expect(await app.adapter.saveAndReload(app.document)).toBe(false); expect(app.document.save).not.toHaveBeenCalled();
    app.document.isClosed = false; const saved = deferred<boolean>();
    app.document.save.mockImplementation(async () => { await saved.promise; app.document.isDirty = false; return true; });
    const operation = app.adapter.saveAndReload(app.document); await Promise.resolve(); app.adapter.dispose();
    saved.resolve(true); await operation; expect(app.request).not.toHaveBeenCalled();
  });
});

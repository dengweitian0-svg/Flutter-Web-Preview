import { TextDocumentSaveReason, type TextDocument } from 'vscode';

type SaveDocument = Pick<TextDocument, 'uri' | 'fileName' | 'version' | 'isDirty' | 'isClosed' | 'save'>;
export interface SaveTarget { sessionId: string; projectRoot: string }
interface SaveHost {
  target(): SaveTarget | undefined;
  isCurrent(target: SaveTarget): boolean;
  belongs(document: SaveDocument, target: SaveTarget): Promise<boolean>;
  request(target: SaveTarget, reason: TextDocumentSaveReason | undefined): void;
}

/** Save intent and results stay in the editor adapter; scheduling stays in the controller. */
export class SaveAdapter {
  private readonly reasons = new WeakMap<SaveDocument, TextDocumentSaveReason>();
  private readonly operations = new WeakMap<SaveDocument, { target?: SaveTarget; version: number; result: Promise<boolean> }>();
  private readonly saving = new WeakSet<SaveDocument>();
  private disposed = false;
  constructor(private readonly host: SaveHost) {}

  willSave(document: SaveDocument, reason: TextDocumentSaveReason): void {
    if (!this.saving.has(document)) this.reasons.set(document, reason);
  }
  close(document: SaveDocument): void { this.reasons.delete(document); }
  dispose(): void { this.disposed = true; }

  async didSave(document: SaveDocument): Promise<void> {
    const reason = this.reasons.get(document);
    this.reasons.delete(document);
    // Capture ownership synchronously, before any project lookup can yield.
    const target = this.host.target();
    const pending = this.operations.get(document);
    if (this.saving.has(document) || (target && pending?.target?.sessionId === target.sessionId && pending.version === document.version)) return;
    await this.request(document, target, reason);
  }

  saveAndReload(document: SaveDocument): Promise<boolean> {
    const target = this.host.target();
    const pending = this.operations.get(document);
    if (pending && pending.target?.sessionId === target?.sessionId && pending.version === document.version) return pending.result;
    const operation = { target, version: document.version, result: Promise.resolve(false) };
    // Install the marker before save() can synchronously emit a save event.
    // A newer edit still needs a save. Serialize it behind the previous operation,
    // retaining the target captured at invocation even if the session changes.
    operation.result = (pending ? pending.result.catch(() => false) : Promise.resolve()).then(async () => {
      try {
        if (this.disposed || document.isClosed) return false;
        let saved = !document.isDirty;
        if (!saved) {
          this.reasons.delete(document);
          this.saving.add(document);
          try { saved = await document.save(); }
          finally { this.saving.delete(document); }
        }
        if (saved && !document.isDirty && !document.isClosed) {
          // Save participants may edit the document. Pin the version actually
          // saved, so a later Auto Save cannot become this manual request.
          operation.version = document.version;
          await this.request(document, target, TextDocumentSaveReason.Manual, operation.version);
        }
        return saved;
      } finally {
        if (this.operations.get(document) === operation) {
          this.operations.delete(document);
        }
      }
    });
    this.operations.set(document, operation);
    return operation.result;
  }

  private async request(document: SaveDocument, target: SaveTarget | undefined, reason: TextDocumentSaveReason | undefined, savedVersion?: number): Promise<void> {
    if (this.disposed || !target || document.uri.scheme !== 'file' || !document.fileName.toLowerCase().endsWith('.dart') || !this.host.isCurrent(target)) return;
    if (!await this.host.belongs(document, target) || this.disposed || !this.host.isCurrent(target)) return;
    if (savedVersion !== undefined && (document.version !== savedVersion || document.isDirty || document.isClosed)) return;
    this.host.request(target, reason);
  }
}

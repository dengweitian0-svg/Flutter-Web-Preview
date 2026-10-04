import { describe, expect, it } from 'vitest';
import { TabTracker } from '../../src/browser/tabTracker';
describe('browser tab identity tracking', () => {
  it('does not classify focus or hidden tabs as closed', () => {
    const tab = {}; const other = {}; const tracker = new TabTracker<object>(); tracker.bind(tab, [tab, other]);
    tracker.observe([other, tab], () => true, 0); expect(tracker.reconcile([other, tab])).toBe('present');
  });
  it('transfers the binding when a move opens a replacement before closing the old tab', () => {
    const original = {}; const moved = {}; const tracker = new TabTracker<object>(); tracker.bind(original, [original]);
    tracker.observe([original, moved], () => true, 0); tracker.observe([moved], () => true, 30);
    expect(tracker.reconcile([moved])).toBe('moved'); expect(tracker.current).toBe(moved);
    tracker.observe([], () => true, 100); expect(tracker.reconcile([])).toBe('closed');
  });
  it('does not use an unrelated tab opened long before the close as a replacement', () => {
    const original = {}; const other = {}; const tracker = new TabTracker<object>(); tracker.bind(original, [original]);
    tracker.observe([original, other], () => true, 0); tracker.observe([other], () => true, 300);
    expect(tracker.reconcile([other])).toBe('closed');
  });
  it('leaves ambiguous structural changes unresolved instead of killing a process', () => {
    const original = {}; const a = {}; const b = {}; const tracker = new TabTracker<object>(); tracker.bind(original, [original]);
    tracker.observe([a, b], () => true, 0); expect(tracker.reconcile([a, b])).toBe('ambiguous');
  });
});

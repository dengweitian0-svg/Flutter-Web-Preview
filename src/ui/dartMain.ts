// Preserve offsets while removing comments and strings, including nested block comments.
export function maskDart(source: string): string {
  const result = source.split(''); let index = 0;
  const mask = (start: number, end: number) => { for (let i = start; i < end; i++) if (result[i] !== '\n' && result[i] !== '\r') result[i] = ' '; };
  while (index < source.length) {
    const start = index;
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index); index = end < 0 ? source.length : end; mask(start, index);
    } else if (source.startsWith('/*', index)) {
      let depth = 1; index += 2;
      while (index < source.length && depth) {
        if (source.startsWith('/*', index)) { depth++; index += 2; }
        else if (source.startsWith('*/', index)) { depth--; index += 2; }
        else index++;
      }
      mask(start, index);
    } else if (source[index] === '"' || source[index] === "'") {
      const quote = source[index]!; const delimiter = source.startsWith(quote.repeat(3), index) ? quote.repeat(3) : quote;
      const raw = index > 0 && source[index - 1] === 'r'; index += delimiter.length;
      while (index < source.length) {
        if (!raw && source[index] === '\\') { index += 2; continue; }
        if (source.startsWith(delimiter, index)) { index += delimiter.length; break; }
        index++;
      }
      mask(start, Math.min(index, source.length));
    } else index++;
  }
  return result.join('');
}
export function mainOffsets(source: string): number[] {
  const masked = maskDart(source); const offsets: number[] = [];
  const pattern = /^[ \t]*(?:(?:void|Future\s*<\s*void\s*>|FutureOr\s*<\s*void\s*>|dynamic)\s+)?main\s*\(/gm;
  for (const match of masked.matchAll(pattern)) {
    let depth = 0;
    for (let i = 0; i < match.index; i++) { if (masked[i] === '{') depth++; else if (masked[i] === '}') depth--; }
    if (depth !== 0) continue;
    let cursor = match.index + match[0].length; let parameters = 1;
    while (cursor < masked.length && parameters) { if (masked[cursor] === '(') parameters++; else if (masked[cursor] === ')') parameters--; cursor++; }
    if (parameters === 0 && /^\s*(?:async\s*)?(?:\{|=>)/.test(masked.slice(cursor))) offsets.push(match.index + match[0].indexOf('main'));
  }
  return offsets;
}

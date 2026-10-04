import { describe, expect, it } from 'vitest';
import { mainOffsets } from '../../src/ui/dartMain';
describe('Dart entrypoint discovery', () => {
  it.each(['void main() {}', 'Future<void> main() async {}', 'main(List<String> args) => runApp(App());', 'Future < void > main(\nList<String> args\n) async { }'])('recognizes top-level main: %s', source => expect(mainOffsets(source)).toHaveLength(1));
  it('ignores nested comments, strings and class methods', () => {
    const source = `/* void main() {} /* nested */ */\n// main() {}\nfinal s = '''void main() {}''';\nclass App { void main() {} }\nvoid main() {}`;
    expect(mainOffsets(source)).toHaveLength(1);
    expect(source.slice(mainOffsets(source)[0])).toBe('main() {}');
  });
  it('does not treat calls or assigned expressions as entrypoints', () => expect(mainOffsets('final a = main();\nmain();')).toEqual([]));
});

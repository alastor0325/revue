/**
 * @jest-environment jsdom
 */
'use strict';

// Syntax highlighting of diff lines (public/highlight.js) with the real
// vendored highlight.js bundle, plus how renderFile uses it.

global.fetch = jest.fn();
global.EventSource = jest.fn(() => ({ addEventListener: jest.fn(), close: jest.fn() }));

const hljs = require('../public/vendor/highlight.min.js').default;
const {
  setHighlighter, languageFor, splitHighlightedLines, highlightDiffLines,
} = require('../public/highlight');
const { renderFile, state } = require('../public/app');

const ctx = (content) => ({ type: 'context', content });
const add = (content) => ({ type: 'added', content });
const del = (content) => ({ type: 'removed', content });

beforeEach(() => setHighlighter(hljs));
afterAll(() => setHighlighter(null));

describe('languageFor', () => {
  // languageFor may return a highlight.js alias (e.g. "mm"); compare the
  // language each one resolves to.
  const resolves = (filePath, expected) =>
    expect(hljs.getLanguage(languageFor(filePath))).toBe(hljs.getLanguage(expected));

  test('maps Firefox file types to highlight.js languages', () => {
    resolves('dom/media/MediaDecoder.h', 'cpp'); // C++, not C
    resolves('dom/media/MediaDecoder.cpp', 'cpp');
    resolves('dom/webidl/HTMLMediaElement.webidl', 'cpp');
    resolves('ipc/PContent.ipdl', 'cpp');
    resolves('widget/cocoa/nsAppShell.mm', 'objectivec');
    resolves('toolkit/modules/Foo.sys.mjs', 'javascript');
    resolves('toolkit/modules/Old.jsm', 'javascript');
    resolves('dom/media/moz.build', 'python');
    resolves('Cargo.toml', 'ini');
    resolves('build/Makefile', 'makefile');
    resolves('config/Makefile.in', 'makefile');
    resolves('gfx/wr/src/lib.rs', 'rust');
    resolves('test/foo.py', 'python');
  });

  test('returns null for unknown types and without a loaded highlighter', () => {
    expect(languageFor('data/blob.xyz')).toBeNull();
    expect(languageFor('LICENSE')).toBeNull();
    // CMake is not Make syntax: not coloured as a Makefile.
    expect(hljs.getLanguage(languageFor('CMakeLists.txt') || 'x')).not.toBe(hljs.getLanguage('makefile'));
    setHighlighter(null);
    expect(languageFor('a.cpp')).toBeNull();
  });
});

describe('splitHighlightedLines', () => {
  test('closes spans open at a newline and reopens them on the next line', () => {
    const html = 'a <span class="c">/* x\ny */</span> b\nc';
    expect(splitHighlightedLines(html)).toEqual([
      'a <span class="c">/* x</span>',
      '<span class="c">y */</span> b',
      'c',
    ]);
  });

  test('handles nested spans', () => {
    const html = '<span class="a"><span class="b">1\n2</span>3</span>';
    expect(splitHighlightedLines(html)).toEqual([
      '<span class="a"><span class="b">1</span></span>',
      '<span class="a"><span class="b">2</span>3</span>',
    ]);
  });
});

describe('highlightDiffLines', () => {
  test('returns one fragment per line and colours tokens', () => {
    const out = highlightDiffLines([ctx('int main() {'), add('  return 0;'), ctx('}')], 'a.cpp');
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('hljs-type');
    expect(out[1]).toContain('<span class="hljs-keyword">return</span>');
  });

  test('a block comment across added lines is coloured on every line', () => {
    const out = highlightDiffLines([add('/* first'), add('   second */'), add('int x;')], 'a.cpp');
    expect(out[0]).toMatch(/hljs-comment">\/\* first/);
    expect(out[1]).toMatch(/hljs-comment">   second \*\//);
    expect(out[2]).not.toContain('hljs-comment');
  });

  test('removed lines are highlighted from the old side of the hunk', () => {
    // On the new side the comment never opens, so `return` would be a keyword;
    // on the old side it is inside the removed comment.
    const out = highlightDiffLines([del('/*'), del('return 1;'), del('*/'), ctx('return 2;')], 'a.cpp');
    expect(out[1]).toContain('hljs-comment');
    expect(out[3]).toContain('<span class="hljs-keyword">return</span>');
  });

  test('escapes markup in the source', () => {
    const out = highlightDiffLines([add('const s = "<img src=x onerror=alert(1)>";')], 'a.js');
    expect(out[0]).not.toContain('<img');
    expect(out[0]).toContain('&lt;img');
  });

  test('returns null for unknown file types', () => {
    expect(highlightDiffLines([add('x')], 'notes.xyz')).toBeNull();
  });

  test('a hunk of only removed lines (deleted code) is highlighted', () => {
    const out = highlightDiffLines([del('int a;'), del('int b;')], 'a.cpp');
    expect(out).toHaveLength(2);
    expect(out[1]).toContain('hljs-type');
  });
});

describe('renderFile with highlighting', () => {
  const file = {
    newPath: 'src/foo.cpp', oldPath: 'src/foo.cpp', binary: false,
    hunks: [{
      header: '@@ -1,2 +1,2 @@', oldStart: 1, oldCount: 2, newStart: 1, newCount: 2,
      lines: [
        { type: 'removed', content: 'int a = 1;', oldLineNum: 1, newLineNum: null },
        { type: 'added', content: 'int a = 2;', oldLineNum: null, newLineNum: 1 },
        { type: 'context', content: 'return a;', oldLineNum: 2, newLineNum: 2 },
      ],
    }],
  };

  beforeEach(() => { state.comments = {}; });

  test('+/- and context lines get token spans; the text is unchanged', () => {
    const el = renderFile(file, 'h1');
    const cells = [...el.querySelectorAll('.ln-content')];
    expect(cells.map((c) => c.classList.contains('hl'))).toEqual([true, true, true]);
    expect(cells[0].querySelector('.diff-sign').textContent).toBe('-');
    expect(cells[1].querySelector('.diff-sign').textContent).toBe('+');
    expect(cells[1].querySelector('.hljs-type').textContent).toBe('int');
    expect(cells[1].querySelector('.hljs-number').textContent).toBe('2');
    // The comment icon stays first; the code text is exactly the line.
    expect(cells.map((c) => c.textContent)).toEqual(['＋-int a = 1;', '＋+int a = 2;', '＋ return a;']);
  });

  test('falls back to plain text without a highlighter', () => {
    setHighlighter(null);
    const el = renderFile(file, 'h1');
    const cells = [...el.querySelectorAll('.ln-content')];
    expect(cells.some((c) => c.classList.contains('hl') || c.querySelector('span[class^="hljs"]'))).toBe(false);
    expect(cells[1].textContent).toBe('＋+int a = 2;');
  });
});

describe('highlightDiffLines caching and limits', () => {
  test('reuses the result for the same hunk lines (re-renders do not re-highlight)', () => {
    const spy = jest.spyOn(hljs, 'highlight');
    const lines = [ctx('int a;'), add('int b;')];
    const first = highlightDiffLines(lines, 'a.cpp');
    expect(highlightDiffLines(lines, 'a.cpp')).toBe(first);
    expect(spy).toHaveBeenCalledTimes(1);
    // A different array (e.g. refetched revision data) is highlighted afresh.
    highlightDiffLines([ctx('int a;'), add('int b;')], 'a.cpp');
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  test('skips hunks larger than the size limit', () => {
    const big = [add('x'.repeat(150000)), add('y'.repeat(60000))];
    expect(highlightDiffLines(big, 'a.cpp')).toBeNull();
  });
});

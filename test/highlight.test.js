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
  setHighlighter, languageFor, languageClass, splitHighlightedLines, highlightDiffLines,
  highlightSource, highlightFromSources,
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

  test('a Jinja template is highlighted as the format it renders to', () => {
    resolves('prompts/system.md.j2', 'markdown');
    resolves('conf/app.yaml.jinja2', 'yaml');
    resolves('page.html.jinja', 'xml');
    expect(languageFor('prompts/descriptions.j2')).toBeNull();
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

describe('per-language rules', () => {
  test('languageClass uses the canonical highlight.js name, aliases included', () => {
    expect(languageClass('dom/media/MediaDecoder.h')).toBe('language-cpp'); // via the "h" override
    expect(languageClass('Foo.sys.mjs')).toBe('language-javascript');      // "mjs" alias
    expect(languageClass('README.md')).toBe('language-markdown');          // "md" alias
    expect(languageClass('nsAppShell.mm')).toBe('language-objectivec');
    expect(languageClass('notes.xyz')).toBeNull();
  });

  test('renderFile tags the diff table with the language class', () => {
    const file = (newPath) => ({
      newPath, oldPath: newPath, binary: false,
      hunks: [{ header: '@@ -0,0 +1 @@', oldStart: 0, oldCount: 0, newStart: 1, newCount: 1,
        lines: [{ type: 'added', content: 'x', oldLineNum: null, newLineNum: 1 }] }],
    });
    expect(renderFile(file('a.cpp'), 'h').querySelector('.diff-table').className).toBe('diff-table language-cpp');
    expect(renderFile(file('blob.xyz'), 'h').querySelector('.diff-table').className).toBe('diff-table');
  });

  test('code embedded in HTML carries its own language class, so its rules apply', () => {
    const html = highlightDiffLines([add('<script>this.x = 1;</script>')], 'page.html')[0];
    expect(html).toContain('class="language-javascript"');
  });

  // Each grammar must emit the token classes that style.css's per-language
  // rules target, or those rules would silently never match.
  const tokens = (path, code) => highlightDiffLines(code.split('\n').map(add), path).join('\n');
  test.each([
    ['a.cpp', '#include "foo.h"\n#define N 1', ['hljs-meta', 'hljs-keyword', 'hljs-string']],
    ['a.js', 'this.x = `a${b}` + /ab+c/.source;', ['hljs-variable language_', 'hljs-property', 'hljs-subst', 'hljs-regexp']],
    ['README.md', '# Title\n- item *em* **st** `code` [t](http://x)\n> quote',
      ['hljs-section', 'hljs-bullet', 'hljs-emphasis', 'hljs-strong', 'hljs-code', 'hljs-string', 'hljs-link', 'hljs-quote']],
    ['a.py', '@cached\ndef f(self):\n    return f"{self.x}"', ['hljs-meta', 'hljs-subst']],
    ['lib.rs', "#[derive(Debug)]\nfn f<'a>(x: &'a str) {}", ['hljs-meta', 'hljs-symbol']],
    ['a.json', '{"key": 1}', ['hljs-attr']],
    ['a.yaml', 'key: value', ['hljs-attr']],
  ])('%s emits the classes its rules use', (path, code, classes) => {
    const html = tokens(path, code);
    for (const c of classes) expect(html).toContain(`class="${c}"`);
  });
});

// A hunk that starts inside a block (the JS of an HTML <script>) is coloured
// from the whole file, which shows the highlighter the lines above it.
describe('whole-file highlighting', () => {
  const OLD = '<p>x</p>\n<script>\nlet a = 1;\n</script>\n';
  const NEW = '<p>x</p>\n<script>\nlet a = 2;\n</script>\n';
  const line = (type, content, oldLineNum, newLineNum) => ({ type, content, oldLineNum, newLineNum });
  const hunkLines = () => [line('removed', 'let a = 1;', 3, null), line('added', 'let a = 2;', null, 3), line('context', '</script>', 4, 4)];
  const keyword = '<span class="hljs-keyword">let</span>';
  const sources = () => ({ old: highlightSource(OLD, 'page.html'), new: highlightSource(NEW, 'page.html') });
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test('a hunk inside a <script> is plain text on its own', () => {
    expect(highlightDiffLines(hunkLines(), 'page.html')[1]).not.toContain(keyword);
  });

  test('highlightSource splits the file into lines, without the empty one after the last newline', () => {
    const src = highlightSource(NEW, 'page.html');
    expect(src.text).toEqual(['<p>x</p>', '<script>', 'let a = 2;', '</script>']);
    expect(src.html).toHaveLength(4);
    expect(src.html[2]).toContain(keyword);
  });

  test('highlightSource returns null for a missing side or an unknown type', () => {
    expect(highlightSource(null, 'page.html')).toBeNull();
    expect(highlightSource('x', 'blob.xyz')).toBeNull();
  });

  test('highlightFromSources colours removed lines from the old file, others from the new', () => {
    const out = highlightFromSources(hunkLines(), sources());
    expect(out[0]).toContain(keyword);
    expect(out[0]).toContain('1');
    expect(out[1]).toContain(keyword);
    expect(out[1]).toContain('2');
  });

  test('highlightFromSources returns null when a line is not in the file as in the diff', () => {
    expect(highlightFromSources([line('added', 'let b = 3;', null, 3)], sources())).toBeNull();
    expect(highlightFromSources(hunkLines(), { old: null, new: sources().new })).toBeNull();
  });

  describe('renderFile', () => {
    const fileData = () => ({
      newPath: 'page.html', oldPath: 'page.html', binary: false,
      hunks: [{ header: '@@ -3,2 +3,2 @@', oldStart: 3, oldCount: 2, newStart: 3, newCount: 2, lines: hunkLines() }],
    });
    afterEach(() => { document.body.innerHTML = ''; });
    const codeCells = (el) => [...el.querySelectorAll('tr.line-added .ln-content, tr.line-removed .ln-content')];

    beforeEach(() => {
      state.comments = {};
      global.fetch.mockReset();
      global.fetch.mockImplementation((url) => Promise.resolve(
        String(url).startsWith('api/filesource')
          ? { ok: true, json: () => Promise.resolve({ old: OLD, new: NEW }) }
          : { ok: true, json: () => Promise.resolve({ lines: [], totalLines: 4 }) }));
    });

    test('recolours a hunk from the whole file when both versions arrive', async () => {
      const el = document.body.appendChild(renderFile(fileData(), 'abc1230'));
      expect(codeCells(el)[1].innerHTML).not.toContain(keyword); // per-hunk colours first
      expect(global.fetch).toHaveBeenCalledWith('api/filesource?hash=abc1230&file=page.html');
      await flush();
      const cells = codeCells(el);
      expect(cells.map((c) => c.innerHTML.includes(keyword))).toEqual([true, true]);
      // The sign and the text are unchanged.
      expect(cells.map((c) => c.textContent)).toEqual(['＋-let a = 1;', '＋+let a = 2;']);
    });

    test('a re-render uses the fetched versions at once, without fetching again', async () => {
      document.body.appendChild(renderFile(fileData(), 'abc1231'));
      await flush();
      global.fetch.mockClear();
      const el = renderFile(fileData(), 'abc1231');
      expect(codeCells(el)[1].innerHTML).toContain(keyword);
      expect(global.fetch).not.toHaveBeenCalledWith(expect.stringMatching(/^api\/filesource/));
    });

    test('a hunk that does not match the file keeps its own colours; the others are recoloured', async () => {
      const data = fileData();
      data.hunks.push({ header: '@@ -9 +9 @@', oldStart: 9, oldCount: 1, newStart: 9, newCount: 1,
        lines: [line('added', 'not in the file', null, 9)] });
      const el = document.body.appendChild(renderFile(data, 'abc1235'));
      await flush();
      const cells = codeCells(el);
      expect(cells.slice(0, 2).map((c) => c.innerHTML.includes(keyword))).toEqual([true, true]);
      expect(cells[2].textContent).toBe('＋+not in the file');
    });

    test('does not touch a table that a re-render has replaced', async () => {
      const el = renderFile(fileData(), 'abc1236'); // never attached to the document
      await flush();
      expect(codeCells(el)[1].innerHTML).not.toContain(keyword);
    });

    test('keeps per-hunk colours when the file versions cannot be read', async () => {
      global.fetch.mockImplementation(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
      const el = renderFile(fileData(), 'abc1232');
      await flush();
      expect(codeCells(el)[1].classList.contains('hl')).toBe(true);
      expect(codeCells(el)[1].innerHTML).not.toContain(keyword);
    });

    test('does not fetch for a compare view, an unknown type, or a hunk at the top of the file', () => {
      renderFile(fileData(), 'compare:abc:def');
      renderFile({ ...fileData(), newPath: 'a.xyz', oldPath: 'a.xyz' }, 'abc1233');
      const top = fileData();
      Object.assign(top.hunks[0], { oldStart: 1, newStart: 1 });
      renderFile(top, 'abc1234');
      expect(global.fetch).not.toHaveBeenCalledWith(expect.stringMatching(/^api\/filesource/));
    });
  });
});

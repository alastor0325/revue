/**
 * @jest-environment jsdom
 */
'use strict';

// Rendered (rich) diff of Markdown / Bikeshed documents: block selection, the
// block-level edit script, and how changes are marked in the new document.

const { diffBlocks, blockKey, diffSequences, markChanges } = require('../public/richdiff');

const doc = (body) => new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${body}</body></html>`, 'text/html');
const texts = (els) => els.map((e) => e.textContent);

describe('diffBlocks / blockKey', () => {
  test('picks blocks with their own text, in document order', () => {
    const d = doc('<h1>T</h1><div class="note"><p>a</p></div><ul><li><p>b</p></li><li>c</li></ul><table><tr><td>r1</td></tr></table>');
    expect(diffBlocks(d).map(blockKey)).toEqual(['T', 'a', 'b', 'c', 'r1']);
  });

  test('a step that holds a nested list is keyed on its own text (algorithm steps)', () => {
    const d = doc('<ol><li>Run these steps: <ol><li>first</li><li>second</li></ol></li></ol>');
    expect(diffBlocks(d).map(blockKey)).toEqual(['Run these steps:', 'first', 'second']);
  });

  test('ignores Bikeshed section numbers, self-links and generated sections', () => {
    const d = doc('<h2><span class="secno">3.2. </span><span class="content">Usage</span><a class="self-link" href="#u"></a></h2>'
      + '<nav id="toc"><ol><li>3.2. Usage</li></ol></nav><section id="index"><ul><li>term</li></ul></section><p>body</p>');
    expect(diffBlocks(d).map(blockKey)).toEqual(['Usage', 'body']);
  });

  test('collapses whitespace except in <pre>', () => {
    const d = doc('<p> a\n   b </p><pre>x\n  y</pre>');
    expect(diffBlocks(d).map(blockKey)).toEqual(['a b', 'x\n  y']);
  });
});

describe('diffSequences', () => {
  const ops = (a, b) => diffSequences(a, b).map((o) => (o.op === 'same' ? `=${a[o.a]}` : o.op === 'del' ? `-${a[o.a]}` : `+${b[o.b]}`));

  test('identical sequences are all "same"', () => {
    expect(ops(['a', 'b'], ['a', 'b'])).toEqual(['=a', '=b']);
  });

  test('insertions, deletions and a replacement, in order', () => {
    expect(ops(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])).toEqual(['=a', '-b', '+x', '=c', '=d', '+e']);
    expect(ops([], ['n'])).toEqual(['+n']);
    expect(ops(['o'], [])).toEqual(['-o']);
  });

  test('keeps the longest common subsequence in the middle', () => {
    expect(ops(['p', 'a', 'b', 'c', 's'], ['p', 'c', 'a', 'b', 's'])).toEqual(['=p', '+c', '=a', '=b', '-c', '=s']);
  });

  test('falls back to delete-all/add-all for a huge rewritten middle', () => {
    const a = Array.from({ length: 2500 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 2500 }, (_, i) => `b${i}`);
    const r = diffSequences(a, b);
    expect(r.filter((o) => o.op === 'del')).toHaveLength(2500);
    expect(r.filter((o) => o.op === 'add')).toHaveLength(2500);
  });
});

describe('markChanges', () => {
  test('marks added blocks and puts removed blocks back where they were', () => {
    const oldDoc = doc('<h1>T</h1><p>keep</p><p>gone</p><p>end</p>');
    const newDoc = doc('<h1>T</h1><p>keep</p><p>new</p><p>end</p>');
    const changed = markChanges(newDoc, oldDoc);
    expect(texts(changed)).toEqual(['gone', 'new']);
    expect(texts([...newDoc.body.children])).toEqual(['T', 'keep', 'gone', 'new', 'end']);
    expect(newDoc.body.children[2].className).toBe('revue-removed');
    expect(newDoc.body.children[3].className).toBe('revue-added');
  });

  test('inserting a section does not mark later (renumbered) headings', () => {
    const h = (n, t) => `<h2><span class="secno">${n}. </span>${t}</h2>`;
    const changed = markChanges(doc(h(1, 'A') + h(2, 'New') + h(3, 'B') + h(4, 'C')), doc(h(1, 'A') + h(2, 'B') + h(3, 'C')));
    expect(changed.map(blockKey)).toEqual(['New']);
  });

  test('section references renumbered by an inserted section are not changes', () => {
    const changed = markChanges(doc('<p>See <a href="#x">§ 5.2 Usage</a>.</p><ul class="index"><li>term, in § 5</li></ul>'),
      doc('<p>See <a href="#x">§ 4.2 Usage</a>.</p><ul class="index"><li>term, in § 4</li></ul>'));
    expect(changed).toEqual([]);
  });

  test('an edited step is marked; its unchanged nested steps are not, and are not duplicated', () => {
    const oldDoc = doc('<ol><li>Old step: <ol><li>keep</li></ol></li></ol>');
    const newDoc = doc('<ol><li>New step: <ol><li>keep</li></ol></li></ol>');
    const changed = markChanges(newDoc, oldDoc);
    expect(changed.map((el) => [el.className, blockKey(el)])).toEqual([['revue-removed', 'Old step:'], ['revue-added', 'New step:']]);
    expect(newDoc.body.textContent.match(/keep/g)).toHaveLength(1);
  });

  test('removed blocks at the end go after the last block', () => {
    const changed = markChanges(doc('<p>a</p>'), doc('<p>a</p><p>tail</p>'));
    expect(texts(changed)).toEqual(['tail']);
  });

  test('no changes for identical documents', () => {
    expect(markChanges(doc('<p>a</p><li>b</li>'), doc('<p>a</p><li>b</li>'))).toEqual([]);
  });
});

/* @jest-environment jsdom */
'use strict';

global.fetch = jest.fn();
global.EventSource = jest.fn(() => ({ addEventListener: jest.fn(), close: jest.fn() }));

const { renderFileNav, renderFile } = require('../public/app');

// ── Helpers ───────────────────────────────────────────────────────────────

function makeHunks(added = 2, removed = 1) {
  return [{
    header: '@@ -1,3 +1,4 @@',
    lines: [
      { type: 'context', content: 'ctx', oldLineNum: 1, newLineNum: 1 },
      { type: 'removed', content: 'old', oldLineNum: 2, newLineNum: null },
      { type: 'added',   content: 'new', oldLineNum: null, newLineNum: 2 },
      { type: 'added',   content: 'new2', oldLineNum: null, newLineNum: 3 },
    ],
    oldStart: 1, oldCount: 3, newStart: 1, newCount: 4,
  }];
}

function makeFile(path) {
  return { newPath: path, oldPath: path, hunks: makeHunks() };
}

function setupDOM() {
  document.body.innerHTML = `
    <div id="top-bar" style="height:60px;"></div>
    <div id="main-layout">
      <nav id="file-nav"></nav>
      <div id="files-changed"></div>
    </div>`;
}

function makeDiffWrap(files) {
  const wrap = document.createElement('div');
  for (const f of files) {
    wrap.appendChild(renderFile(f, 'abc123'));
  }
  return wrap;
}

// ── renderFileNav — visibility ─────────────────────────────────────────────

describe('renderFileNav — visibility', () => {
  beforeEach(setupDOM);

  test('hides #file-nav when files array is empty', () => {
    renderFileNav([], null);
    expect(document.getElementById('file-nav').style.display).toBe('none');
  });

  test('hides #file-nav when files is null', () => {
    renderFileNav(null, null);
    expect(document.getElementById('file-nav').style.display).toBe('none');
  });

  test('shows #file-nav when files are provided', () => {
    const files = [makeFile('dom/media/Foo.cpp')];
    const wrap = makeDiffWrap(files);
    renderFileNav(files, wrap);
    expect(document.getElementById('file-nav').style.display).toBe('block');
  });
});

// ── renderFileNav — file path display ─────────────────────────────────────

describe('renderFileNav — file path display', () => {
  beforeEach(setupDOM);

  test('shows the full file path in the nav item', () => {
    const files = [makeFile('dom/media/ContentPlaybackController.cpp')];
    const wrap = makeDiffWrap(files);
    renderFileNav(files, wrap);
    const pathSpan = document.querySelector('.file-nav-name');
    expect(pathSpan).not.toBeNull();
    expect(pathSpan.textContent).toBe('dom/media/ContentPlaybackController.cpp');
  });

  test('sets title attribute to the full file path', () => {
    const files = [makeFile('dom/media/Foo.h')];
    const wrap = makeDiffWrap(files);
    renderFileNav(files, wrap);
    const pathSpan = document.querySelector('.file-nav-name');
    expect(pathSpan.title).toBe('dom/media/Foo.h');
  });

  test('creates one nav item per file', () => {
    const files = [
      makeFile('dom/media/A.cpp'),
      makeFile('dom/media/B.h'),
      makeFile('layout/base/C.cpp'),
    ];
    const wrap = makeDiffWrap(files);
    renderFileNav(files, wrap);
    expect(document.querySelectorAll('.file-nav-item').length).toBe(3);
  });

  test('shows +/- stats in each nav item', () => {
    const files = [makeFile('dom/media/Foo.cpp')];
    const wrap = makeDiffWrap(files);
    renderFileNav(files, wrap);
    const addEl = document.querySelector('.file-nav-item .stat-add');
    const delEl = document.querySelector('.file-nav-item .stat-del');
    expect(addEl).not.toBeNull();
    expect(delEl).not.toBeNull();
    expect(addEl.textContent).toMatch(/^\+\d+/);
    expect(delEl.textContent).toMatch(/^-\d+/);
  });
});

// ── renderFileNav — fold toggle ────────────────────────────────────────────

describe('renderFileNav — fold toggle', () => {
  beforeEach(setupDOM);

  test('nav item has a fold button', () => {
    const files = [makeFile('dom/media/Foo.cpp')];
    const wrap = makeDiffWrap(files);
    renderFileNav(files, wrap);
    const btn = document.querySelector('.nav-fold-btn');
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('▼');
  });

  test('clicking fold button collapses the file block', () => {
    const files = [makeFile('dom/media/Foo.cpp')];
    const wrap = makeDiffWrap(files);
    renderFileNav(files, wrap);
    const foldBtn = document.querySelector('.nav-fold-btn');
    const diffBody = wrap.querySelector('.diff-body');
    expect(diffBody.style.display).not.toBe('none');

    foldBtn.click();

    expect(diffBody.style.display).toBe('none');
    expect(foldBtn.textContent).toBe('▶');
  });

  test('clicking fold button again expands the file block', () => {
    const files = [makeFile('dom/media/Foo.cpp')];
    const wrap = makeDiffWrap(files);
    renderFileNav(files, wrap);
    const foldBtn = document.querySelector('.nav-fold-btn');
    const diffBody = wrap.querySelector('.diff-body');

    foldBtn.click(); // collapse
    foldBtn.click(); // expand

    expect(diffBody.style.display).toBe('');
    expect(foldBtn.textContent).toBe('▼');
  });

  test('clicking fold button also updates the file-toggle icon in the header', () => {
    const files = [makeFile('dom/media/Foo.cpp')];
    const wrap = makeDiffWrap(files);
    renderFileNav(files, wrap);
    const foldBtn = document.querySelector('.nav-fold-btn');
    const fileToggle = wrap.querySelector('.file-toggle');

    foldBtn.click(); // collapse

    expect(fileToggle.classList.contains('collapsed')).toBe(true);

    foldBtn.click(); // expand

    expect(fileToggle.classList.contains('collapsed')).toBe(false);
  });

  test('clicking fold button does not scroll (stopPropagation prevents scroll)', () => {
    const files = [makeFile('dom/media/Foo.cpp')];
    const wrap = makeDiffWrap(files);
    renderFileNav(files, wrap);
    const scrollSpy = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const foldBtn = document.querySelector('.nav-fold-btn');

    foldBtn.click();

    expect(scrollSpy).not.toHaveBeenCalled();
    scrollSpy.mockRestore();
  });
});

// ── renderFileNav — nav item click (scroll) ───────────────────────────────

describe('renderFileNav — nav item click', () => {
  beforeEach(setupDOM);

  test('clicking nav item calls window.scrollTo', () => {
    const files = [makeFile('dom/media/Foo.cpp')];
    const wrap = makeDiffWrap(files);
    renderFileNav(files, wrap);
    const scrollSpy = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const item = document.querySelector('.file-nav-item');

    item.click();

    expect(scrollSpy).toHaveBeenCalled();
    scrollSpy.mockRestore();
  });

  test('clicking nav item expands a collapsed file block before scrolling', () => {
    const files = [makeFile('dom/media/Foo.cpp')];
    const wrap = makeDiffWrap(files);
    renderFileNav(files, wrap);
    jest.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const foldBtn = document.querySelector('.nav-fold-btn');
    foldBtn.click(); // collapse

    const diffBody = wrap.querySelector('.diff-body');
    expect(diffBody.style.display).toBe('none');

    const item = document.querySelector('.file-nav-item');
    item.click();

    expect(diffBody.style.display).toBe('');
    expect(foldBtn.textContent).toBe('▼');
    window.scrollTo.mockRestore();
  });
});

// ── renderFileNav — re-render clears previous handler ─────────────────────

describe('renderFileNav — re-render', () => {
  beforeEach(setupDOM);

  test('calling renderFileNav again replaces nav items', () => {
    const wrap1 = makeDiffWrap([makeFile('A.cpp')]);
    renderFileNav([makeFile('A.cpp')], wrap1);
    expect(document.querySelectorAll('.file-nav-item').length).toBe(1);

    const wrap2 = makeDiffWrap([makeFile('B.cpp'), makeFile('C.cpp')]);
    renderFileNav([makeFile('B.cpp'), makeFile('C.cpp')], wrap2);
    expect(document.querySelectorAll('.file-nav-item').length).toBe(2);

    const paths = [...document.querySelectorAll('.file-nav-name')].map((el) => el.textContent);
    expect(paths).toEqual(['B.cpp', 'C.cpp']);
  });
});

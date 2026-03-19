/* @jest-environment jsdom */
'use strict';

global.fetch = jest.fn();
global.EventSource = jest.fn(() => ({ addEventListener: jest.fn(), close: jest.fn() }));

const {
  renderFileNav, renderFile,
  getFileNavCollapsed, setFileNavCollapsed,
} = require('../public/app');

// ── Helpers ───────────────────────────────────────────────────────────────

function makeHunks() {
  return [{
    header: '@@ -1,3 +1,4 @@',
    lines: [
      { type: 'context', content: 'ctx',  oldLineNum: 1, newLineNum: 1 },
      { type: 'removed', content: 'old',  oldLineNum: 2, newLineNum: null },
      { type: 'added',   content: 'new',  oldLineNum: null, newLineNum: 2 },
      { type: 'added',   content: 'new2', oldLineNum: null, newLineNum: 3 },
    ],
    oldStart: 1, oldCount: 3, newStart: 1, newCount: 4,
  }];
}

function makeFile(filePath) {
  return { newPath: filePath, oldPath: filePath, hunks: makeHunks() };
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
  for (const f of files) wrap.appendChild(renderFile(f, 'abc123'));
  return wrap;
}

beforeEach(() => {
  setupDOM();
  setFileNavCollapsed(false); // reset sidebar state between tests
});

// ── Visibility ─────────────────────────────────────────────────────────────

describe('renderFileNav — visibility', () => {
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
    renderFileNav(files, makeDiffWrap(files));
    expect(document.getElementById('file-nav').style.display).not.toBe('none');
  });
});

// ── Header ─────────────────────────────────────────────────────────────────

describe('renderFileNav — header', () => {
  test('renders a header with a label', () => {
    const files = [makeFile('dom/media/Foo.cpp')];
    renderFileNav(files, makeDiffWrap(files));
    const label = document.querySelector('.file-nav-label');
    expect(label).not.toBeNull();
    expect(label.textContent).toBeTruthy();
  });

  test('renders a collapse toggle button', () => {
    const files = [makeFile('dom/media/Foo.cpp')];
    renderFileNav(files, makeDiffWrap(files));
    expect(document.querySelector('.file-nav-toggle')).not.toBeNull();
  });
});

// ── Two-level file display ─────────────────────────────────────────────────

describe('renderFileNav — filename and directory hierarchy', () => {
  test('shows the filename (not full path) in .file-nav-filename', () => {
    const files = [makeFile('dom/media/ContentPlaybackController.cpp')];
    renderFileNav(files, makeDiffWrap(files));
    const filenameEl = document.querySelector('.file-nav-filename');
    expect(filenameEl).not.toBeNull();
    expect(filenameEl.textContent).toBe('ContentPlaybackController.cpp');
  });

  test('shows the directory path in .file-nav-dir', () => {
    const files = [makeFile('dom/media/ContentPlaybackController.cpp')];
    renderFileNav(files, makeDiffWrap(files));
    const dirEl = document.querySelector('.file-nav-dir');
    expect(dirEl).not.toBeNull();
    expect(dirEl.textContent).toBe('dom/media/');
  });

  test('omits .file-nav-dir for a root-level file (no directory component)', () => {
    const files = [makeFile('Makefile')];
    renderFileNav(files, makeDiffWrap(files));
    expect(document.querySelector('.file-nav-dir')).toBeNull();
  });

  test('filename and directory are in separate elements (different hierarchy)', () => {
    const files = [makeFile('layout/base/nsPresContext.cpp')];
    renderFileNav(files, makeDiffWrap(files));
    const filenameEl = document.querySelector('.file-nav-filename');
    const dirEl      = document.querySelector('.file-nav-dir');
    // They must be siblings or parent/child — not the same element
    expect(filenameEl).not.toBe(dirEl);
    // Filename shows only the leaf name
    expect(filenameEl.textContent).toBe('nsPresContext.cpp');
    expect(dirEl.textContent).toBe('layout/base/');
  });

  test('sets item title to the full file path', () => {
    const files = [makeFile('dom/media/Foo.h')];
    renderFileNav(files, makeDiffWrap(files));
    const item = document.querySelector('.file-nav-item');
    expect(item.title).toBe('dom/media/Foo.h');
  });

  test('creates one nav item per file', () => {
    const files = [
      makeFile('dom/media/A.cpp'),
      makeFile('dom/media/B.h'),
      makeFile('layout/base/C.cpp'),
    ];
    renderFileNav(files, makeDiffWrap(files));
    expect(document.querySelectorAll('.file-nav-item').length).toBe(3);
  });

  test('shows +/- stats in each nav item', () => {
    const files = [makeFile('dom/media/Foo.cpp')];
    renderFileNav(files, makeDiffWrap(files));
    const addEl = document.querySelector('.file-nav-item .stat-add');
    const delEl = document.querySelector('.file-nav-item .stat-del');
    expect(addEl.textContent).toMatch(/^\+\d+/);
    expect(delEl.textContent).toMatch(/^-\d+/);
  });
});

// ── Sidebar collapse toggle ────────────────────────────────────────────────

describe('renderFileNav — sidebar collapse', () => {
  test('clicking toggle button collapses the sidebar', () => {
    const files = [makeFile('dom/media/Foo.cpp')];
    renderFileNav(files, makeDiffWrap(files));
    const nav = document.getElementById('file-nav');
    expect(nav.classList.contains('collapsed')).toBe(false);

    document.querySelector('.file-nav-toggle').click();

    expect(nav.classList.contains('collapsed')).toBe(true);
  });

  test('clicking toggle button again expands the sidebar', () => {
    const files = [makeFile('dom/media/Foo.cpp')];
    renderFileNav(files, makeDiffWrap(files));
    const btn = document.querySelector('.file-nav-toggle');

    btn.click(); // collapse
    btn.click(); // expand

    expect(document.getElementById('file-nav').classList.contains('collapsed')).toBe(false);
  });

  test('collapsed state persists across renderFileNav calls (patch switch)', () => {
    const files = [makeFile('dom/media/Foo.cpp')];
    const wrap = makeDiffWrap(files);
    renderFileNav(files, wrap);
    document.querySelector('.file-nav-toggle').click(); // collapse

    // Re-render (simulates switching to another patch)
    renderFileNav(files, wrap);

    expect(document.getElementById('file-nav').classList.contains('collapsed')).toBe(true);
    expect(getFileNavCollapsed()).toBe(true);
  });

  test('toggle button shows ▶ when collapsed and ◀ when expanded', () => {
    const files = [makeFile('dom/media/Foo.cpp')];
    renderFileNav(files, makeDiffWrap(files));
    const btn = document.querySelector('.file-nav-toggle');

    expect(btn.textContent).toBe('◀');
    btn.click();
    expect(btn.textContent).toBe('▶');
    btn.click();
    expect(btn.textContent).toBe('◀');
  });

  test('re-render with pre-collapsed state shows ▶ on the toggle button', () => {
    setFileNavCollapsed(true);
    const files = [makeFile('dom/media/Foo.cpp')];
    renderFileNav(files, makeDiffWrap(files));
    expect(document.querySelector('.file-nav-toggle').textContent).toBe('▶');
    expect(document.getElementById('file-nav').classList.contains('collapsed')).toBe(true);
  });
});

// ── Nav item click (scroll) ───────────────────────────────────────────────

describe('renderFileNav — nav item click', () => {
  test('clicking nav item calls window.scrollTo', () => {
    const files = [makeFile('dom/media/Foo.cpp')];
    renderFileNav(files, makeDiffWrap(files));
    const scrollSpy = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});

    document.querySelector('.file-nav-item').click();

    expect(scrollSpy).toHaveBeenCalled();
    scrollSpy.mockRestore();
  });
});

// ── Re-render ─────────────────────────────────────────────────────────────

describe('renderFileNav — re-render', () => {
  test('calling renderFileNav again replaces nav items', () => {
    renderFileNav([makeFile('A.cpp')], makeDiffWrap([makeFile('A.cpp')]));
    expect(document.querySelectorAll('.file-nav-item').length).toBe(1);

    const files2 = [makeFile('B.cpp'), makeFile('C.cpp')];
    renderFileNav(files2, makeDiffWrap(files2));
    expect(document.querySelectorAll('.file-nav-item').length).toBe(2);

    const names = [...document.querySelectorAll('.file-nav-filename')].map((el) => el.textContent);
    expect(names).toEqual(['B.cpp', 'C.cpp']);
  });
});

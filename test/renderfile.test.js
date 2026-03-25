/**
 * @jest-environment jsdom
 */
'use strict';

global.fetch = jest.fn();
global.EventSource = jest.fn(() => ({ addEventListener: jest.fn(), close: jest.fn() }));

const { renderFile, state } = require('../public/app');

// Minimal file data factory
function makeFile({ newPath = 'src/foo.cpp', oldPath = 'src/foo.cpp', hunks = [] } = {}) {
  return { newPath, oldPath, binary: false, hunks };
}

function makeHunk({ header = '@@ -1,3 +1,3 @@', oldStart = 1, oldCount = 3, newStart = 1, newCount = 3, lines = [] } = {}) {
  return { header, oldStart, oldCount, newStart, newCount, lines };
}

function makeLine(type, content, oldLineNum = null, newLineNum = null) {
  if (type === 'added')   return { type, content, oldLineNum: null, newLineNum: newLineNum ?? 1 };
  if (type === 'removed') return { type, content, oldLineNum: oldLineNum ?? 1, newLineNum: null };
  // context
  return { type: 'context', content, oldLineNum: oldLineNum ?? 1, newLineNum: newLineNum ?? 1 };
}

beforeEach(() => {
  jest.clearAllMocks();
  state.comments = {};
});

// ── Structure ────────────────────────────────────────────────────────────────

describe('renderFile — structure', () => {
  test('returns a .file-block element', () => {
    const el = renderFile(makeFile(), 'hash1');
    expect(el.classList.contains('file-block')).toBe(true);
  });

  test('contains a .file-header with the file path', () => {
    const el = renderFile(makeFile({ newPath: 'dom/media/foo.cpp' }), 'hash1');
    expect(el.querySelector('.file-path').textContent).toBe('dom/media/foo.cpp');
  });

  test('falls back to oldPath when newPath is absent (deleted file)', () => {
    const el = renderFile(makeFile({ newPath: null, oldPath: 'old/bar.cpp' }), 'hash1');
    expect(el.querySelector('.file-path').textContent).toBe('old/bar.cpp');
  });

  test('shows (unknown) when both paths are absent', () => {
    const el = renderFile({ newPath: null, oldPath: null, binary: false, hunks: [] }, 'hash1');
    expect(el.querySelector('.file-path').textContent).toBe('(unknown)');
  });

  test('contains a .diff-body with a .diff-table', () => {
    const el = renderFile(makeFile(), 'hash1');
    expect(el.querySelector('.diff-body')).not.toBeNull();
    expect(el.querySelector('.diff-table')).not.toBeNull();
  });
});

// ── Stats ────────────────────────────────────────────────────────────────────

describe('renderFile — stats display', () => {
  test('shows correct +/- counts in header', () => {
    const hunk = makeHunk({
      lines: [
        makeLine('added', 'new line', null, 1),
        makeLine('added', 'new line 2', null, 2),
        makeLine('removed', 'old line', 1, null),
      ],
    });
    const el = renderFile(makeFile({ hunks: [hunk] }), 'hash1');
    expect(el.querySelector('.stat-add').textContent).toBe('+2');
    expect(el.querySelector('.stat-del').textContent).toBe('-1');
  });

  test('shows +0 -0 for a file with only context lines', () => {
    const hunk = makeHunk({
      lines: [
        makeLine('context', 'unchanged', 1, 1),
      ],
    });
    const el = renderFile(makeFile({ hunks: [hunk] }), 'hash1');
    expect(el.querySelector('.stat-add').textContent).toBe('+0');
    expect(el.querySelector('.stat-del').textContent).toBe('-0');
  });

  test('stats are inside .file-header on the same row as the file path', () => {
    const el = renderFile(makeFile(), 'hash1');
    const header = el.querySelector('.file-header');
    // Both .file-path and .file-stats must be direct children of .file-header
    // (not nested inside an intermediate column wrapper)
    const path = header.querySelector('.file-path');
    const stats = header.querySelector('.file-stats');
    expect(path.parentElement).toBe(header);
    expect(stats.parentElement).toBe(header);
  });
});

// ── Hunk header rows ─────────────────────────────────────────────────────────

describe('renderFile — hunk header rows', () => {
  test('renders one .hunk-header row per hunk', () => {
    const file = makeFile({
      hunks: [
        makeHunk({ header: '@@ -1,2 +1,2 @@', lines: [makeLine('context', 'a', 1, 1)] }),
        makeHunk({ header: '@@ -10,2 +10,2 @@', newStart: 10, lines: [makeLine('context', 'b', 10, 10)] }),
      ],
    });
    const el = renderFile(file, 'hash1');
    const headers = el.querySelectorAll('tr.hunk-header');
    expect(headers).toHaveLength(2);
    expect(headers[0].textContent).toBe('@@ -1,2 +1,2 @@');
    expect(headers[1].textContent).toBe('@@ -10,2 +10,2 @@');
  });
});

// ── Line rows ────────────────────────────────────────────────────────────────

describe('renderFile — line rows', () => {
  function renderSingleHunk(lines) {
    const hunk = makeHunk({ lines });
    return renderFile(makeFile({ hunks: [hunk] }), 'hash1');
  }

  test('added line has .line-added class and + prefix', () => {
    const el = renderSingleHunk([makeLine('added', 'new code', null, 5)]);
    const row = el.querySelector('tr.line-added');
    expect(row).not.toBeNull();
    expect(row.querySelector('.ln-content').textContent).toContain('+new code');
  });

  test('removed line has .line-removed class and - prefix', () => {
    const el = renderSingleHunk([makeLine('removed', 'old code', 3, null)]);
    const row = el.querySelector('tr.line-removed');
    expect(row).not.toBeNull();
    expect(row.querySelector('.ln-content').textContent).toContain('-old code');
  });

  test('context line has .line-context class and space prefix', () => {
    const el = renderSingleHunk([makeLine('context', 'same', 2, 2)]);
    const row = el.querySelector('tr.line-context');
    expect(row).not.toBeNull();
    expect(row.querySelector('.ln-content').textContent).toContain(' same');
  });

  test('added line shows new line number only', () => {
    const el = renderSingleHunk([makeLine('added', 'x', null, 7)]);
    const row = el.querySelector('tr.line-added');
    expect(row.querySelector('.ln-old').textContent).toBe('');
    expect(row.querySelector('.ln-new').textContent).toBe('7');
  });

  test('removed line shows old line number only', () => {
    const el = renderSingleHunk([makeLine('removed', 'x', 4, null)]);
    const row = el.querySelector('tr.line-removed');
    expect(row.querySelector('.ln-old').textContent).toBe('4');
    expect(row.querySelector('.ln-new').textContent).toBe('');
  });

  test('context line shows both old and new line numbers', () => {
    const el = renderSingleHunk([makeLine('context', 'x', 3, 3)]);
    const row = el.querySelector('tr.line-context');
    expect(row.querySelector('.ln-old').textContent).toBe('3');
    expect(row.querySelector('.ln-new').textContent).toBe('3');
  });

  test('renders correct number of line rows', () => {
    const lines = [
      makeLine('context', 'a', 1, 1),
      makeLine('removed', 'b', 2, null),
      makeLine('added', 'c', null, 2),
    ];
    const el = renderSingleHunk(lines);
    const lineRows = el.querySelectorAll('tr.line-added, tr.line-removed, tr.line-context');
    expect(lineRows).toHaveLength(3);
  });

  test('sets data-file-path and data-line-key on each line row', () => {
    const el = renderSingleHunk([makeLine('added', 'x', null, 9)]);
    const row = el.querySelector('tr.line-added');
    expect(row.dataset.filePath).toBe('src/foo.cpp');
    expect(row.dataset.lineKey).toBe('n9');
  });
});

// ── HTML escaping ────────────────────────────────────────────────────────────

describe('renderFile — HTML escaping', () => {
  test('escapes < and > in file path', () => {
    const el = renderFile(makeFile({ newPath: '<script>alert(1)</script>' }), 'hash1');
    expect(el.querySelector('.file-path').textContent).toBe('<script>alert(1)</script>');
    expect(el.querySelector('.file-path').innerHTML).not.toContain('<script>');
  });

  test('escapes < and > in line content', () => {
    const hunk = makeHunk({ lines: [makeLine('added', '<b>bold</b>', null, 1)] });
    const el = renderFile(makeFile({ hunks: [hunk] }), 'hash1');
    const content = el.querySelector('.ln-content');
    expect(content.textContent).toContain('<b>bold</b>');
    expect(content.innerHTML).not.toContain('<b>bold</b>');
  });
});

// ── Collapse / expand toggle ─────────────────────────────────────────────────

describe('renderFile — file collapse toggle', () => {
  test('clicking header hides the diff body', () => {
    const hunk = makeHunk({ lines: [makeLine('context', 'a', 1, 1)] });
    const el = renderFile(makeFile({ hunks: [hunk] }), 'hash1');
    const header = el.querySelector('.file-header');
    const body = el.querySelector('.diff-body');
    expect(body.style.display).toBe('');
    header.click();
    expect(body.style.display).toBe('none');
  });

  test('clicking header twice re-shows the diff body', () => {
    const hunk = makeHunk({ lines: [makeLine('context', 'a', 1, 1)] });
    const el = renderFile(makeFile({ hunks: [hunk] }), 'hash1');
    const header = el.querySelector('.file-header');
    const body = el.querySelector('.diff-body');
    header.click();
    header.click();
    expect(body.style.display).toBe('');
  });

  test('toggle icon gets .collapsed class when collapsed', () => {
    const el = renderFile(makeFile(), 'hash1');
    const header = el.querySelector('.file-header');
    const toggle = header.querySelector('.file-toggle');
    expect(toggle.classList.contains('collapsed')).toBe(false);
    header.click();
    expect(toggle.classList.contains('collapsed')).toBe(true);
  });
});

// ── Expand context rows ───────────────────────────────────────────────────────

describe('renderFile — expand context rows', () => {
  test('inserts an expand row before the first hunk when hunk does not start at line 1', () => {
    // hunk starts at line 5 — lines 1–4 are hidden above
    const hunk = makeHunk({ newStart: 5, newCount: 1, oldStart: 5, oldCount: 1, lines: [makeLine('context', 'x', 5, 5)] });
    const el = renderFile(makeFile({ hunks: [hunk] }), 'hash1');
    const expandRows = el.querySelectorAll('tr.expand-context-row');
    expect(expandRows.length).toBeGreaterThanOrEqual(1);
  });

  test('does not insert an expand row before the first hunk when hunk starts at line 1', () => {
    const hunk = makeHunk({ newStart: 1, newCount: 1, oldStart: 1, oldCount: 1, lines: [makeLine('context', 'x', 1, 1)] });
    const el = renderFile(makeFile({ hunks: [hunk] }), 'hash1');
    // The only expand row should be after the last hunk (trailing lines), not before
    const table = el.querySelector('.diff-table');
    const rows = Array.from(table.rows);
    // First row after the hunk-header should NOT be an expand row
    expect(rows[0].classList.contains('hunk-header')).toBe(true);
    expect(rows[1].classList.contains('expand-context-row')).toBe(false);
  });

  test('inserts an expand row after the last hunk', () => {
    const hunk = makeHunk({ newStart: 1, newCount: 2, oldStart: 1, oldCount: 2, lines: [makeLine('context', 'a', 1, 1), makeLine('context', 'b', 2, 2)] });
    const el = renderFile(makeFile({ hunks: [hunk] }), 'hash1');
    const table = el.querySelector('.diff-table');
    const lastRow = table.rows[table.rows.length - 1];
    expect(lastRow.classList.contains('expand-context-row')).toBe(true);
  });
});

describe('renderFile — expand context button fetch ranges', () => {
  function mockFileContext(lines = []) {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ lines, totalLines: 2000 }),
    });
  }

  // Two hunks: one at line 5, one at line 1662 — creates an in-between gap [~8, 1661]
  function makeFileWithTwoHunks() {
    const hunk1 = makeHunk({
      header: '@@ -5,3 +5,3 @@',
      oldStart: 5, oldCount: 3,
      newStart: 5, newCount: 3,
      lines: [
        makeLine('context', 'a', 5, 5),
        makeLine('added',   'b', null, 6),
        makeLine('context', 'c', 6, 7),
      ],
    });
    const hunk2 = makeHunk({
      header: '@@ -1662,3 +1662,3 @@',
      oldStart: 1662, oldCount: 3,
      newStart: 1662, newCount: 3,
      lines: [
        makeLine('context', 'x', 1662, 1662),
        makeLine('added',   'y', null, 1663),
        makeLine('context', 'z', 1663, 1664),
      ],
    });
    return renderFile(makeFile({ hunks: [hunk1, hunk2] }), 'hash1');
  }

  test('↑ 20 Lines between two hunks fetches the 20 lines just above the lower hunk (near curEnd)', async () => {
    mockFileContext([]);
    const el = makeFileWithTwoHunks();

    // There are multiple expand rows; find the one between the hunks (not isFileTop/isFileBottom)
    // It should have both ↑ and ↓ buttons. Find the ↑ button in such a row.
    const expandRows = el.querySelectorAll('tr.expand-context-row');
    let upBtn = null;
    for (const row of expandRows) {
      const up = row.querySelector('button[data-action="up"]');
      const down = row.querySelector('button[data-action="down"]');
      if (up && down) { upBtn = up; break; } // between-hunks row has both
    }
    expect(upBtn).not.toBeNull();
    upBtn.click();
    await Promise.resolve();

    const url = global.fetch.mock.calls[global.fetch.mock.calls.length - 1][0];
    // Gap ends at 1661; ↑ should fetch [1642, 1661]
    expect(url).toContain('end=1661');
    const startMatch = url.match(/start=(\d+)/);
    expect(parseInt(startMatch[1], 10)).toBeGreaterThan(1600); // near 1661, not near gap start
  });

  test('↓ 20 Lines between two hunks fetches the 20 lines just below the upper hunk (near curStart)', async () => {
    mockFileContext([]);
    const el = makeFileWithTwoHunks();

    const expandRows = el.querySelectorAll('tr.expand-context-row');
    let downBtn = null;
    for (const row of expandRows) {
      const up = row.querySelector('button[data-action="up"]');
      const down = row.querySelector('button[data-action="down"]');
      if (up && down) { downBtn = down; break; }
    }
    expect(downBtn).not.toBeNull();
    downBtn.click();
    await Promise.resolve();

    const url = global.fetch.mock.calls[global.fetch.mock.calls.length - 1][0];
    // Gap starts just after hunk1 ends (~line 8); ↓ should fetch near that start
    const startMatch = url.match(/start=(\d+)/);
    const endMatch = url.match(/end=(\d+)/);
    expect(parseInt(startMatch[1], 10)).toBeLessThan(100); // near gap start, not 1661
    expect(parseInt(endMatch[1], 10)).toBeLessThan(100);   // only fetches ~20 lines from top
  });
});

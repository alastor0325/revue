/**
 * @jest-environment jsdom
 */
'use strict';

global.fetch = jest.fn();
global.EventSource = jest.fn(() => ({ addEventListener: jest.fn(), close: jest.fn() }));

const { buildPatchEl, initPatchNodes, renderTabs, patchEls, state, switchPatch, addDragScroll } = require('../public/app');

function makePatches(...messages) {
  return messages.map((msg, i) => ({
    hash: `hash${i}`,
    message: msg,
    body: msg,
    files: [{
      newPath: `file${i}.cpp`, oldPath: `file${i}.cpp`, binary: false,
      hunks: [{ header: '@@ -1,1 +1,1 @@', oldStart: 1, oldCount: 1, newStart: 1, newCount: 1,
        lines: [{ type: 'added', content: 'x', newLineNum: 1, oldLineNum: null }] }],
    }],
  }));
}

function setupDOM() {
  document.body.innerHTML = `
    <div id="top-bar" style="height:60px;">
      <div id="patch-tabs-bar" style="display:none;"><div id="patch-tabs"></div></div>
    </div>
    <button id="btn-submit" disabled></button>
    <span id="submit-warning"></span>
    <div id="main-layout">
      <nav id="file-nav" style="display:none;"></nav>
      <div id="files-changed" style="display:none;"></div>
    </div>`;
}

beforeEach(() => {
  setupDOM();
  // reset state
  state.patches = [];
  state.currentPatchIdx = 0;
  state.approved = new Set();
  state.denied = new Set();
  state.comments = {};
  state.generalComments = {};
  state.revisions = [];
  state.updatedPatches = {};
  state.showRevision = {};
  state.compareRevision = {};
  patchEls.length = 0;
});

describe('buildPatchEl', () => {
  test('returns an element with patch heading content', () => {
    state.patches = makePatches('Part 1 - fix the thing');
    const { el } = buildPatchEl(0);
    expect(el.querySelector('.patch-heading-msg').textContent).toBe('Part 1 - fix the thing');
  });

  test('uses idx for "Part N" label, not currentPatchIdx', () => {
    state.patches = makePatches('P0', 'P1', 'P2');
    state.currentPatchIdx = 0;
    const { el } = buildPatchEl(2);
    expect(el.querySelector('.patch-heading-label').textContent).toBe('Part 3 of 3');
  });

  test('returns diffWrap when patch has files', () => {
    state.patches = makePatches('Patch with files');
    const { diffWrap } = buildPatchEl(0);
    expect(diffWrap).not.toBeNull();
  });

  test('returns diffWrap null for empty files', () => {
    state.patches = [{ hash: 'abc', message: 'empty', body: 'empty', files: [] }];
    const { diffWrap } = buildPatchEl(0);
    expect(diffWrap).toBeNull();
  });

  test('renders the last-modified date when the patch has one', () => {
    state.patches = makePatches('Part 1 - fix the thing');
    state.patches[0].date = '2026-06-01T12:34:00Z';
    const { el } = buildPatchEl(0);
    const dateEl = el.querySelector('.patch-heading-date');
    expect(dateEl).not.toBeNull();
    expect(dateEl.textContent.trim().length).toBeGreaterThan(0);
    expect(dateEl.title).toBe('Last modified');
  });

  test('omits the date element when the patch has no date', () => {
    state.patches = makePatches('Part 1 - fix the thing'); // makePatches sets no date
    const { el } = buildPatchEl(0);
    expect(el.querySelector('.patch-heading-date')).toBeNull();
  });
});

describe('formatPatchDate', () => {
  const { formatPatchDate } = require('../public/app');

  test('returns a non-empty human string for a valid ISO date', () => {
    expect(formatPatchDate('2026-06-01T12:34:00Z').length).toBeGreaterThan(0);
  });

  test('returns empty string for missing or unparseable input', () => {
    expect(formatPatchDate(null)).toBe('');
    expect(formatPatchDate(undefined)).toBe('');
    expect(formatPatchDate('not a date')).toBe('');
  });
});

describe('initPatchNodes', () => {
  test('inserts one element per patch into #files-changed', () => {
    state.patches = makePatches('A', 'B', 'C');
    initPatchNodes();
    const container = document.getElementById('files-changed');
    expect(container.children).toHaveLength(3);
  });

  test('only the active patch is visible', () => {
    state.patches = makePatches('A', 'B', 'C');
    state.currentPatchIdx = 1;
    initPatchNodes();
    expect(patchEls[0].el.style.display).toBe('none');
    expect(patchEls[1].el.style.display).toBe('');
    expect(patchEls[2].el.style.display).toBe('none');
  });

  test('populates patchEls array', () => {
    state.patches = makePatches('A', 'B');
    initPatchNodes();
    expect(patchEls).toHaveLength(2);
    expect(patchEls[0].el).toBeInstanceOf(Element);
    expect(patchEls[1].el).toBeInstanceOf(Element);
  });

  test('renders empty state when patches is empty', () => {
    state.patches = [];
    initPatchNodes();
    const container = document.getElementById('files-changed');
    expect(container.querySelector('.empty-worktree')).not.toBeNull();
  });

  test('empty state contains a title and subtitle', () => {
    state.patches = [];
    initPatchNodes();
    const container = document.getElementById('files-changed');
    expect(container.querySelector('.empty-worktree-title').textContent).toBe('No changes');
    expect(container.querySelector('.empty-worktree-subtitle').textContent).toBeTruthy();
  });

  test('empty state does not add entries to patchEls', () => {
    state.patches = [];
    initPatchNodes();
    expect(patchEls).toHaveLength(0);
  });
});

describe('switchPatch', () => {
  beforeEach(() => {
    window.scrollTo = jest.fn(); // jsdom doesn't implement it
    global.fetch.mockImplementation((url) => {
      if (url === '/api/worktrees') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ current: 'x', worktrees: [] }) });
      }
      return Promise.reject(new Error(`Unmocked: ${url}`));
    });
  });

  test('hides old patch and shows the new one; revisiting does not rebuild', () => {
    state.patches = makePatches('A', 'B', 'C');
    initPatchNodes();

    const elA = patchEls[0].el; // active patch, already built

    switchPatch(1); // first visit to B builds it lazily
    expect(elA.style.display).toBe('none');
    expect(patchEls[1].el.style.display).toBe('');
    expect(patchEls[0].el).toBe(elA); // the active patch is untouched

    // Revisiting an already-built patch must NOT rebuild its DOM (anti-flicker).
    const elB = patchEls[1].el;
    switchPatch(0);
    switchPatch(1);
    expect(patchEls[1].el).toBe(elB);
    expect(patchEls[0].el).toBe(elA);
  });

  test('non-active patches are not built until first viewed', () => {
    state.patches = makePatches('A', 'B', 'C');
    initPatchNodes();
    // Only the active patch's diff is in the DOM up front.
    expect(patchEls[0].built).toBe(true);
    expect(patchEls[1].built).toBe(false);
    expect(patchEls[2].built).toBe(false);
    expect(patchEls[0].el.querySelector('.diff-table')).not.toBeNull();
    expect(patchEls[1].el.querySelector('.diff-table')).toBeNull(); // placeholder
    switchPatch(1);
    expect(patchEls[1].built).toBe(true);
    expect(patchEls[1].el.querySelector('.diff-table')).not.toBeNull();
  });

  test('updates currentPatchIdx', () => {
    state.patches = makePatches('A', 'B');
    initPatchNodes();
    switchPatch(1);
    expect(state.currentPatchIdx).toBe(1);
  });

  test('resets the page scroll to the top so the new patch starts at its head', () => {
    state.patches = makePatches('A', 'B');
    initPatchNodes();
    window.scrollTo.mockClear();
    switchPatch(1);
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  });
});

describe('renderTabs', () => {
  test('all tab buttons have the patch-tab class', () => {
    state.patches = makePatches('A', 'B', 'C');
    renderTabs();
    const btns = document.querySelectorAll('#patch-tabs .patch-tab');
    expect(btns).toHaveLength(3);
  });

  test('second call updates tabs in-place without losing patch-tab class', () => {
    state.patches = makePatches('A', 'B');
    renderTabs();
    renderTabs(); // second call — must not break querySelectorAll
    const btns = document.querySelectorAll('#patch-tabs .patch-tab');
    expect(btns).toHaveLength(2);
    btns.forEach((btn) => expect(btn.className).toContain('patch-tab'));
  });

  test('active class is set on the current patch tab', () => {
    state.patches = makePatches('A', 'B', 'C');
    state.currentPatchIdx = 1;
    renderTabs();
    const btns = document.querySelectorAll('#patch-tabs .patch-tab');
    expect(btns[0].classList.contains('active')).toBe(false);
    expect(btns[1].classList.contains('active')).toBe(true);
    expect(btns[2].classList.contains('active')).toBe(false);
  });
});

// ── addDragScroll ──────────────────────────────────────────────────────────

describe('addDragScroll', () => {
  test('stops scrolling when element is detached from DOM', () => {
    const el = document.createElement('div');
    el.scrollLeft = 0;
    document.body.appendChild(el);
    addDragScroll(el);

    // Start drag
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100, button: 0 }));
    expect(el.isConnected).toBe(true);

    // Detach the element (simulates replaceWith on re-render)
    el.remove();
    expect(el.isConnected).toBe(false);

    // Mousemove on document should not mutate scrollLeft (guard fires)
    const prevScroll = el.scrollLeft;
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 50 }));
    expect(el.scrollLeft).toBe(prevScroll);
  });

  test('swallows the click that ends a drag, but lets a plain click through', () => {
    const el = document.createElement('div');
    let scroll = 0;
    Object.defineProperty(el, 'scrollLeft', { configurable: true, get: () => scroll, set: (v) => { scroll = v; } });
    // Delegated click handler on the container, like #worktree-pills / #patch-tabs-bar:
    // the real click target is a child element that bubbles up.
    const child = document.createElement('button');
    el.appendChild(child);
    document.body.appendChild(el);
    addDragScroll(el);

    let clicks = 0;
    el.addEventListener('click', () => { clicks++; });

    // Plain click (no movement) → the delegated handler fires.
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 50 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    child.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(clicks).toBe(1);

    // Drag past the threshold → the click that follows is swallowed.
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 50 }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 120 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    child.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(clicks).toBe(1); // unchanged — the post-drag click was suppressed

    el.remove();
  });
});

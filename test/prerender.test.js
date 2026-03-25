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
    global.fetch.mockImplementation((url) => {
      if (url === '/api/worktrees') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ current: 'x', worktrees: [] }) });
      }
      return Promise.reject(new Error(`Unmocked: ${url}`));
    });
  });

  test('hides old patch and shows new one without rebuilding DOM', () => {
    state.patches = makePatches('A', 'B', 'C');
    initPatchNodes();

    const elA = patchEls[0].el;
    const elB = patchEls[1].el;

    switchPatch(1);

    expect(elA.style.display).toBe('none');
    expect(elB.style.display).toBe('');
    // Elements should be the same objects — no rebuild
    expect(patchEls[0].el).toBe(elA);
    expect(patchEls[1].el).toBe(elB);
  });

  test('updates currentPatchIdx', () => {
    state.patches = makePatches('A', 'B');
    initPatchNodes();
    switchPatch(1);
    expect(state.currentPatchIdx).toBe(1);
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
});

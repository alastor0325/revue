/* @jest-environment jsdom */
'use strict';

// Stub browser globals not available in jsdom before requiring the app module.
global.fetch = jest.fn();
global.EventSource = jest.fn(() => ({ addEventListener: jest.fn(), close: jest.fn() }));

const {
  renderDraftDisplay,
  removeExistingForm,
  showCommentForm,
  draftKey,
  drafts,
  state,
} = require('../public/app');

// ── Helpers ───────────────────────────────────────────────────────────────

const HASH = 'abc123';
const FILE = 'dom/media/Foo.cpp';
const KEY  = 'n10';
const LINE = { type: 'added', content: 'foo();', newLineNum: 10, oldLineNum: null };

function dk() { return draftKey(HASH, FILE, KEY); }

function setupTr() {
  document.body.innerHTML = '<table><tbody><tr data-line-key="n10"></tr></tbody></table>';
  return document.querySelector('tr');
}

beforeEach(() => {
  // Clear module-level draft and comment state between tests.
  Object.keys(drafts).forEach((k) => delete drafts[k]);
  state.comments = {};
  jest.clearAllMocks();
});

afterEach(() => {
  document.body.innerHTML = '';
});

// ── renderDraftDisplay ─────────────────────────────────────────────────────

describe('renderDraftDisplay', () => {
  test('inserts a .comment-draft-row when draft text exists', () => {
    const tr = setupTr();
    drafts[dk()] = 'Check this logic';
    renderDraftDisplay(tr, HASH, FILE, LINE, KEY);

    const next = tr.nextElementSibling;
    expect(next).not.toBeNull();
    expect(next.classList.contains('comment-draft-row')).toBe(true);
  });

  test('draft row contains the draft text', () => {
    const tr = setupTr();
    drafts[dk()] = 'Check this logic';
    renderDraftDisplay(tr, HASH, FILE, LINE, KEY);

    expect(tr.nextElementSibling.textContent).toContain('Check this logic');
  });

  test('does not insert a row when no draft exists', () => {
    const tr = setupTr();
    renderDraftDisplay(tr, HASH, FILE, LINE, KEY);

    expect(tr.nextElementSibling).toBeNull();
  });

  test('does not insert a row when draft text is empty string', () => {
    const tr = setupTr();
    drafts[dk()] = '   ';
    renderDraftDisplay(tr, HASH, FILE, LINE, KEY);

    expect(tr.nextElementSibling).toBeNull();
  });

  test('does not insert a row when a saved comment exists for the line', () => {
    const tr = setupTr();
    drafts[dk()] = 'Draft text';
    state.comments = { [HASH]: { [FILE]: { [KEY]: { text: 'Saved', line: 10 } } } };
    renderDraftDisplay(tr, HASH, FILE, LINE, KEY);

    expect(tr.nextElementSibling).toBeNull();
  });

  test('replaces existing draft row with updated content on re-render', () => {
    const tr = setupTr();
    drafts[dk()] = 'First draft';
    renderDraftDisplay(tr, HASH, FILE, LINE, KEY);

    drafts[dk()] = 'Updated draft';
    renderDraftDisplay(tr, HASH, FILE, LINE, KEY);

    const draftRows = document.querySelectorAll('.comment-draft-row');
    expect(draftRows).toHaveLength(1);
    expect(draftRows[0].textContent).toContain('Updated draft');
  });

  test('removes the draft row when draft is cleared on re-render', () => {
    const tr = setupTr();
    drafts[dk()] = 'Some draft';
    renderDraftDisplay(tr, HASH, FILE, LINE, KEY);
    expect(tr.nextElementSibling).not.toBeNull();

    delete drafts[dk()];
    renderDraftDisplay(tr, HASH, FILE, LINE, KEY);
    expect(tr.nextElementSibling).toBeNull();
  });
});

// ── showCommentForm renders all action buttons ─────────────────────────────

describe('showCommentForm button visibility', () => {
  test('comment form contains all three action buttons', () => {
    const tr = setupTr();
    showCommentForm(tr, HASH, FILE, LINE, KEY);

    const formRow = tr.nextElementSibling;
    expect(formRow.querySelector('.btn-cancel')).not.toBeNull();
    expect(formRow.querySelector('.btn-discard')).not.toBeNull();
    expect(formRow.querySelector('.btn-save')).not.toBeNull();
  });

  test('all three action buttons are children of .comment-actions', () => {
    const tr = setupTr();
    showCommentForm(tr, HASH, FILE, LINE, KEY);

    const formRow = tr.nextElementSibling;
    const actions = formRow.querySelector('.comment-actions');
    expect(actions).not.toBeNull();
    expect(actions.querySelector('.btn-cancel')).not.toBeNull();
    expect(actions.querySelector('.btn-discard')).not.toBeNull();
    expect(actions.querySelector('.btn-save')).not.toBeNull();
  });
});

// ── draft row restored when form is closed ─────────────────────────────────

describe('draft row restored when form is closed', () => {
  test('cancel button restores the draft row', () => {
    const tr = setupTr();
    drafts[dk()] = 'My draft';
    showCommentForm(tr, HASH, FILE, LINE, KEY);

    expect(tr.nextElementSibling.classList.contains('comment-form-row')).toBe(true);

    tr.nextElementSibling.querySelector('.btn-cancel').click();

    const next = tr.nextElementSibling;
    expect(next).not.toBeNull();
    expect(next.classList.contains('comment-draft-row')).toBe(true);
    expect(next.textContent).toContain('My draft');
  });

  test('removeExistingForm restores the draft row', () => {
    const tr = setupTr();
    drafts[dk()] = 'My draft';
    showCommentForm(tr, HASH, FILE, LINE, KEY);

    expect(tr.nextElementSibling.classList.contains('comment-form-row')).toBe(true);

    removeExistingForm();

    const next = tr.nextElementSibling;
    expect(next).not.toBeNull();
    expect(next.classList.contains('comment-draft-row')).toBe(true);
  });

  test('no draft row after discard button clears the draft', () => {
    const tr = setupTr();
    drafts[dk()] = 'Draft to discard';
    showCommentForm(tr, HASH, FILE, LINE, KEY);

    tr.nextElementSibling.querySelector('.btn-discard').click();

    expect(tr.nextElementSibling).toBeNull();
    expect(drafts[dk()]).toBeUndefined();
  });

  test('no draft row restored when no draft existed before form opened', () => {
    const tr = setupTr();
    // No draft set — form opened directly (e.g. first-time comment)
    showCommentForm(tr, HASH, FILE, LINE, KEY);

    tr.nextElementSibling.querySelector('.btn-cancel').click();

    expect(tr.nextElementSibling).toBeNull();
  });
});

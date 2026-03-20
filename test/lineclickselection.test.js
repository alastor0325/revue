/**
 * @jest-environment jsdom
 */
'use strict';

// Stub fetch before the module loads (app.js references it at the top level)
global.fetch = jest.fn();

const { renderFile, renderCommitMessageSection } = require('../public/app');

// Minimal file data with one added line
const FILE_DATA = {
  newPath: 'dom/media/Foo.cpp',
  oldPath: 'dom/media/Foo.cpp',
  binary: false,
  hunks: [
    {
      header: '@@ -1,1 +1,1 @@',
      oldStart: 1, oldCount: 1, newStart: 1, newCount: 1,
      lines: [
        { type: 'added', content: 'void foo() {}', newLineNum: 1, oldLineNum: null },
      ],
    },
  ],
};

describe('ln-content click — suppress comment form when text is selected', () => {
  let block;

  beforeEach(() => {
    document.body.innerHTML = '';
    block = renderFile(FILE_DATA, 'abc123');
    document.body.appendChild(block);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('does NOT open comment form when text is selected (drag)', () => {
    jest.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'selected text' });

    document.querySelector('.ln-content').click();

    expect(document.querySelector('.comment-form-row')).toBeNull();
  });

  test('opens comment form when no text is selected (plain click)', () => {
    jest.spyOn(window, 'getSelection').mockReturnValue({ toString: () => '' });

    document.querySelector('.ln-content').click();

    expect(document.querySelector('.comment-form-row')).not.toBeNull();
  });
});

// ── commit message click — suppress form when text is selected ─────────────

describe('commit message click — suppress form when text is selected', () => {
  let container;

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    renderCommitMessageSection(container, 'abc123', 'Bug 1234 - Fix the thing\n\nSome details.', false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('does NOT open commit feedback form when text is selected (drag)', () => {
    jest.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'Fix the thing' });

    container.querySelector('.commit-msg-subject').click();

    expect(container.querySelector('textarea')).toBeNull();
  });

  test('opens commit feedback form when no text is selected (plain click)', () => {
    jest.spyOn(window, 'getSelection').mockReturnValue({ toString: () => '' });

    container.querySelector('.commit-msg-subject').click();

    expect(container.querySelector('textarea')).not.toBeNull();
  });
});

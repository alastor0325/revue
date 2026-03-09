'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { formatPrompt, submitReview } = require('../src/claude');

// ── Fixtures ───────────────────────────────────────────────────────────────

const patch1 = { hash: 'aaa111', message: 'bugABC - Part 1: Add WebIDL' };
const patch2 = { hash: 'bbb222', message: 'bugABC - Part 2: Implement logic' };
const patch3 = { hash: 'ccc333', message: 'bugABC - Part 3: Fire events' };
const allPatches = [patch1, patch2, patch3];

const comments = [
  { file: 'dom/media/Foo.cpp', line: 42, lineContent: 'MOZ_ASSERT(mCtx);', text: 'Add a message string' },
  { file: 'dom/media/Bar.h',   line: 15, lineContent: 'void Toggle();',    text: 'Rename to SetActive' },
];

// ── formatPrompt ───────────────────────────────────────────────────────────

describe('formatPrompt', () => {
  test('includes bug ID in the output', () => {
    const out = formatPrompt('bugABC', patch1, allPatches, comments);
    expect(out).toContain('bugABC');
  });

  test('identifies the correct patch number', () => {
    expect(formatPrompt('bugABC', patch1, allPatches, comments)).toContain('Part 1 of 3');
    expect(formatPrompt('bugABC', patch2, allPatches, comments)).toContain('Part 2 of 3');
    expect(formatPrompt('bugABC', patch3, allPatches, comments)).toContain('Part 3 of 3');
  });

  test('marks the current patch with ← THIS PATCH', () => {
    const out = formatPrompt('bugABC', patch2, allPatches, comments);
    const lines = out.split('\n');
    const marked = lines.find(l => l.includes('← THIS PATCH'));
    expect(marked).toBeTruthy();
    expect(marked).toContain(patch2.hash);
  });

  test('lists all patches in the series', () => {
    const out = formatPrompt('bugABC', patch1, allPatches, comments);
    expect(out).toContain(patch1.hash);
    expect(out).toContain(patch2.hash);
    expect(out).toContain(patch3.hash);
  });

  test('formats each comment with [YOUR CODE] and [FEEDBACK] labels', () => {
    const out = formatPrompt('bugABC', patch1, allPatches, comments);
    expect(out).toContain('[YOUR CODE] : MOZ_ASSERT(mCtx);');
    expect(out).toContain('[FEEDBACK]  : Add a message string');
    expect(out).toContain('[YOUR CODE] : void Toggle();');
    expect(out).toContain('[FEEDBACK]  : Rename to SetActive');
  });

  test('includes file path and line number for each comment', () => {
    const out = formatPrompt('bugABC', patch1, allPatches, comments);
    expect(out).toContain('dom/media/Foo.cpp : line 42');
    expect(out).toContain('dom/media/Bar.h : line 15');
  });

  test('instructions mention the patch number to scope the fix', () => {
    const out = formatPrompt('bugABC', patch2, allPatches, comments);
    expect(out).toContain('Part 2 only');
  });

  test('works with a single patch in the series', () => {
    const out = formatPrompt('bugXYZ', patch1, [patch1], comments);
    expect(out).toContain('Part 1 of 1');
    // Only one patch — should not list others
    expect(out).not.toContain(patch2.hash);
  });

  test('works with empty comments array', () => {
    const out = formatPrompt('bugABC', patch1, allPatches, []);
    expect(out).toContain('bugABC');
    // Feedback section exists but has no items
    expect(out).toContain('## Reviewer feedback:');
  });
});

// ── submitReview ───────────────────────────────────────────────────────────

describe('submitReview', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxreview-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes REVIEW_FEEDBACK_<hash>.md to the worktree', () => {
    submitReview(tmpDir, 'bugABC', patch1, allPatches, comments);
    const file = path.join(tmpDir, `REVIEW_FEEDBACK_${patch1.hash}.md`);
    expect(fs.existsSync(file)).toBe(true);
  });

  test('written file contains the formatted prompt', () => {
    submitReview(tmpDir, 'bugABC', patch1, allPatches, comments);
    const content = fs.readFileSync(
      path.join(tmpDir, `REVIEW_FEEDBACK_${patch1.hash}.md`),
      'utf8'
    );
    expect(content).toContain('bugABC');
    expect(content).toContain('[YOUR CODE]');
    expect(content).toContain('[FEEDBACK]');
  });

  test('returns the correct feedbackPath', () => {
    const { feedbackPath } = submitReview(tmpDir, 'bugABC', patch1, allPatches, comments);
    expect(feedbackPath).toBe(path.join(tmpDir, `REVIEW_FEEDBACK_${patch1.hash}.md`));
  });

  test('returns a command string referencing the feedback file', () => {
    const { command } = submitReview(tmpDir, 'bugABC', patch1, allPatches, comments);
    expect(typeof command).toBe('string');
    expect(command.length).toBeGreaterThan(0);
    expect(command).toContain(`REVIEW_FEEDBACK_${patch1.hash}.md`);
  });

  test('each patch gets its own file — no clobbering', () => {
    submitReview(tmpDir, 'bugABC', patch1, allPatches, comments);
    submitReview(tmpDir, 'bugABC', patch2, allPatches, comments);
    expect(fs.existsSync(path.join(tmpDir, `REVIEW_FEEDBACK_${patch1.hash}.md`))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, `REVIEW_FEEDBACK_${patch2.hash}.md`))).toBe(true);
  });
});

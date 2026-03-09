'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { formatCombinedPrompt, submitReview } = require('../src/claude');

// ── Fixtures ───────────────────────────────────────────────────────────────

const patch1 = { hash: 'aaa111', message: 'bugABC - Part 1: Add WebIDL' };
const patch2 = { hash: 'bbb222', message: 'bugABC - Part 2: Implement logic' };
const patch3 = { hash: 'ccc333', message: 'bugABC - Part 3: Fire events' };
const allPatches = [patch1, patch2, patch3];

const comments1 = [
  { file: 'dom/media/Foo.cpp', line: 42, lineContent: 'MOZ_ASSERT(mCtx);', text: 'Add a message string' },
  { file: 'dom/media/Bar.h',   line: 15, lineContent: 'void Toggle();',    text: 'Rename to SetActive' },
];
const comments2 = [
  { file: 'dom/media/Baz.cpp', line: 7, lineContent: 'return nullptr;', text: 'Handle the error' },
];

function makeFeedback(overrides = []) {
  const base = [
    { hash: 'aaa111', comments: comments1, generalComment: '' },
    { hash: 'bbb222', comments: [],        generalComment: '' },
    { hash: 'ccc333', comments: [],        generalComment: '' },
  ];
  for (const o of overrides) {
    const entry = base.find((e) => e.hash === o.hash);
    if (entry) Object.assign(entry, o);
  }
  return base;
}

// ── formatCombinedPrompt ───────────────────────────────────────────────────

describe('formatCombinedPrompt', () => {
  test('includes worktree name', () => {
    const out = formatCombinedPrompt('bugABC', allPatches, makeFeedback());
    expect(out).toContain('firefox-bugABC');
  });

  test('lists all patches in the series', () => {
    const out = formatCombinedPrompt('bugABC', allPatches, makeFeedback());
    expect(out).toContain(patch1.hash);
    expect(out).toContain(patch2.hash);
    expect(out).toContain(patch3.hash);
  });

  test('includes feedback section for patches with comments', () => {
    const out = formatCombinedPrompt('bugABC', allPatches, makeFeedback());
    expect(out).toContain('Part 1');
    expect(out).toContain('[YOUR CODE] : MOZ_ASSERT(mCtx);');
    expect(out).toContain('[FEEDBACK]  : Add a message string');
  });

  test('includes file path and line number for each comment', () => {
    const out = formatCombinedPrompt('bugABC', allPatches, makeFeedback());
    expect(out).toContain('dom/media/Foo.cpp : line 42');
    expect(out).toContain('dom/media/Bar.h : line 15');
  });

  test('omits feedback section for patches with no comments and no general comment', () => {
    const out = formatCombinedPrompt('bugABC', allPatches, makeFeedback());
    // patch2 and patch3 have no feedback — their hashes appear only in series list
    const afterSeries = out.slice(out.indexOf('---'));
    expect(afterSeries).not.toContain(`Part 2`);
    expect(afterSeries).not.toContain(`Part 3`);
  });

  test('includes feedback sections for multiple patches when both have comments', () => {
    const feedback = makeFeedback([{ hash: 'bbb222', comments: comments2 }]);
    const out = formatCombinedPrompt('bugABC', allPatches, feedback);
    expect(out).toContain('[FEEDBACK]  : Add a message string');
    expect(out).toContain('[FEEDBACK]  : Handle the error');
  });

  test('includes general feedback section when generalComment is provided', () => {
    const feedback = makeFeedback([{ hash: 'aaa111', generalComment: 'Please use RAII.' }]);
    const out = formatCombinedPrompt('bugABC', allPatches, feedback);
    expect(out).toContain('### General feedback:');
    expect(out).toContain('Please use RAII.');
  });

  test('omits general feedback section when generalComment is empty', () => {
    const out = formatCombinedPrompt('bugABC', allPatches, makeFeedback());
    expect(out).not.toContain('### General feedback:');
  });

  test('marks skipped patches in the series list', () => {
    const out = formatCombinedPrompt('bugABC', allPatches, makeFeedback(), [patch3.hash]);
    const lines = out.split('\n');
    const skippedLine = lines.find((l) => l.includes(patch3.hash));
    expect(skippedLine).toContain('[SKIPPED — not reviewed]');
  });

  test('omits feedback section for skipped patches even if they have comments', () => {
    const feedback = makeFeedback([{ hash: 'bbb222', comments: comments2 }]);
    const out = formatCombinedPrompt('bugABC', allPatches, feedback, [patch2.hash]);
    const afterSeries = out.slice(out.indexOf('---'));
    expect(afterSeries).not.toContain(patch2.hash);
  });

  test('marks approved patches in the series list', () => {
    const out = formatCombinedPrompt('bugABC', allPatches, makeFeedback(), [], [patch3.hash]);
    const lines = out.split('\n');
    const approvedLine = lines.find((l) => l.includes(patch3.hash));
    expect(approvedLine).toContain('[APPROVED — no issues]');
  });

  test('omits feedback section for approved patches', () => {
    const feedback = makeFeedback([{ hash: 'bbb222', comments: comments2 }]);
    const out = formatCombinedPrompt('bugABC', allPatches, feedback, [], [patch2.hash]);
    const afterSeries = out.slice(out.indexOf('---'));
    expect(afterSeries).not.toContain(patch2.hash);
  });

  test('skipped takes priority over approved for the same patch', () => {
    const out = formatCombinedPrompt('bugABC', allPatches, makeFeedback(), [patch3.hash], [patch3.hash]);
    const lines = out.split('\n');
    const line = lines.find((l) => l.includes(patch3.hash));
    expect(line).toContain('[SKIPPED');
    expect(line).not.toContain('[APPROVED');
  });

  test('works with a single patch', () => {
    const feedback = [{ hash: 'aaa111', comments: comments1, generalComment: '' }];
    const out = formatCombinedPrompt('bugXYZ', [patch1], feedback);
    expect(out).toContain(patch1.hash);
    expect(out).toContain('[FEEDBACK]  : Add a message string');
    expect(out).not.toContain(patch2.hash);
  });

  test('instructions section is present', () => {
    const out = formatCombinedPrompt('bugABC', allPatches, makeFeedback());
    expect(out).toContain('## Instructions:');
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

  test('writes REVIEW_FEEDBACK_<worktreeName>.md to the worktree', () => {
    submitReview(tmpDir, 'bugABC', allPatches, makeFeedback());
    const file = path.join(tmpDir, 'REVIEW_FEEDBACK_bugABC.md');
    expect(fs.existsSync(file)).toBe(true);
  });

  test('written file contains the formatted prompt', () => {
    submitReview(tmpDir, 'bugABC', allPatches, makeFeedback());
    const content = fs.readFileSync(path.join(tmpDir, 'REVIEW_FEEDBACK_bugABC.md'), 'utf8');
    expect(content).toContain('firefox-bugABC');
    expect(content).toContain('[YOUR CODE]');
    expect(content).toContain('[FEEDBACK]');
  });

  test('returns the correct feedbackPath', () => {
    const { feedbackPath } = submitReview(tmpDir, 'bugABC', allPatches, makeFeedback());
    expect(feedbackPath).toBe(path.join(tmpDir, 'REVIEW_FEEDBACK_bugABC.md'));
  });

  test('returns a command referencing the feedback file', () => {
    const { command } = submitReview(tmpDir, 'bugABC', allPatches, makeFeedback());
    expect(typeof command).toBe('string');
    expect(command).toContain('REVIEW_FEEDBACK_bugABC.md');
  });

  test('overwrites the same file on successive calls', () => {
    submitReview(tmpDir, 'bugABC', allPatches, makeFeedback());
    const feedback2 = makeFeedback([{ hash: 'aaa111', generalComment: 'Updated feedback.' }]);
    submitReview(tmpDir, 'bugABC', allPatches, feedback2);
    const content = fs.readFileSync(path.join(tmpDir, 'REVIEW_FEEDBACK_bugABC.md'), 'utf8');
    expect(content).toContain('Updated feedback.');
    // only one file exists
    const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith('REVIEW_FEEDBACK'));
    expect(files).toHaveLength(1);
  });

  test('reflects skipped patches in the file', () => {
    submitReview(tmpDir, 'bugABC', allPatches, makeFeedback(), [patch3.hash]);
    const content = fs.readFileSync(path.join(tmpDir, 'REVIEW_FEEDBACK_bugABC.md'), 'utf8');
    expect(content).toContain('[SKIPPED');
  });

  test('reflects approved patches in the file', () => {
    submitReview(tmpDir, 'bugABC', allPatches, makeFeedback(), [], [patch3.hash]);
    const content = fs.readFileSync(path.join(tmpDir, 'REVIEW_FEEDBACK_bugABC.md'), 'utf8');
    expect(content).toContain('[APPROVED — no issues]');
  });
});

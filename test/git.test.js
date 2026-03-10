'use strict';

jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

const { execSync } = require('child_process');
const { getHeadHash, parseDiff, parseWorktreeList, getDiffForCommit, parseCommitBody } = require('../src/git');

// ── Helpers ───────────────────────────────────────────────────────────────

function makeDiff(files) {
  return files.join('\n');
}

// ── parseDiff ─────────────────────────────────────────────────────────────

describe('parseDiff', () => {
  test('returns empty array for empty input', () => {
    expect(parseDiff('')).toEqual([]);
    expect(parseDiff('\n\n')).toEqual([]);
  });

  test('parses a simple added line', () => {
    const diff = `diff --git a/foo.js b/foo.js
--- a/foo.js
+++ b/foo.js
@@ -1,3 +1,4 @@
 line1
+newline
 line2
 line3`;

    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].newPath).toBe('foo.js');
    expect(files[0].oldPath).toBe('foo.js');

    const lines = files[0].hunks[0].lines;
    expect(lines.find(l => l.type === 'added')).toMatchObject({
      type: 'added',
      content: 'newline',
      newLineNum: 2,
      oldLineNum: null,
    });
  });

  test('parses a simple removed line', () => {
    const diff = `diff --git a/foo.js b/foo.js
--- a/foo.js
+++ b/foo.js
@@ -1,3 +1,2 @@
 line1
-removed
 line2`;

    const files = parseDiff(diff);
    const lines = files[0].hunks[0].lines;
    expect(lines.find(l => l.type === 'removed')).toMatchObject({
      type: 'removed',
      content: 'removed',
      newLineNum: null,
      oldLineNum: 2,
    });
  });

  test('assigns correct line numbers across multiple hunks', () => {
    const diff = `diff --git a/foo.cpp b/foo.cpp
--- a/foo.cpp
+++ b/foo.cpp
@@ -1,3 +1,4 @@
 ctx1
+add1
 ctx2
 ctx3
@@ -10,3 +11,2 @@
 ctx4
-rem1
 ctx5`;

    const files = parseDiff(diff);
    expect(files[0].hunks).toHaveLength(2);

    const hunk1Lines = files[0].hunks[0].lines;
    expect(hunk1Lines[0]).toMatchObject({ type: 'context', newLineNum: 1, oldLineNum: 1 });
    expect(hunk1Lines[1]).toMatchObject({ type: 'added',   newLineNum: 2, oldLineNum: null });
    expect(hunk1Lines[2]).toMatchObject({ type: 'context', newLineNum: 3, oldLineNum: 2 });

    const hunk2Lines = files[0].hunks[1].lines;
    expect(hunk2Lines[1]).toMatchObject({ type: 'removed', newLineNum: null, oldLineNum: 11 });
  });

  test('parses multiple files', () => {
    const diff = `diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -1,1 +1,2 @@
 a
+aa
diff --git a/b.js b/b.js
--- a/b.js
+++ b/b.js
@@ -1,2 +1,1 @@
-bb
 b`;

    const files = parseDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[0].newPath).toBe('a.js');
    expect(files[1].newPath).toBe('b.js');
  });

  test('filters out binary files', () => {
    const diff = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
diff --git a/real.js b/real.js
--- a/real.js
+++ b/real.js
@@ -1,1 +1,1 @@
-old
+new`;

    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].newPath).toBe('real.js');
  });

  test('handles new file (no old path)', () => {
    const diff = `diff --git a/new.js b/new.js
--- /dev/null
+++ b/new.js
@@ -0,0 +1,2 @@
+line1
+line2`;

    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].newPath).toBe('new.js');
    expect(files[0].oldPath).toBe('/dev/null');

    const lines = files[0].hunks[0].lines;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: 'added', newLineNum: 1 });
    expect(lines[1]).toMatchObject({ type: 'added', newLineNum: 2 });
  });

  test('handles deleted file (no new path)', () => {
    const diff = `diff --git a/old.js b/old.js
--- a/old.js
+++ /dev/null
@@ -1,2 +0,0 @@
-line1
-line2`;

    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].oldPath).toBe('old.js');

    const lines = files[0].hunks[0].lines;
    expect(lines).toHaveLength(2);
    lines.forEach(l => expect(l.type).toBe('removed'));
  });

  test('ignores commit metadata before first diff --git', () => {
    const diff = `commit abc123
Author: Some Dev
Date: Mon Jan 1 00:00:00 2024

    Commit message

diff --git a/foo.js b/foo.js
--- a/foo.js
+++ b/foo.js
@@ -1,1 +1,1 @@
-old
+new`;

    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
  });

  test('hunk header is preserved', () => {
    const diff = `diff --git a/foo.js b/foo.js
--- a/foo.js
+++ b/foo.js
@@ -10,3 +10,4 @@ function foo() {
 ctx
+add
 ctx2`;

    const files = parseDiff(diff);
    expect(files[0].hunks[0].header).toBe('@@ -10,3 +10,4 @@ function foo() {');
  });

  test('handles hunk with no count (single line, implicit ,1)', () => {

    const diff = `diff --git a/foo.js b/foo.js
--- a/foo.js
+++ b/foo.js
@@ -1 +1 @@
-old
+new`;

    const files = parseDiff(diff);
    expect(files[0].hunks[0].oldCount).toBe(1);
    expect(files[0].hunks[0].newCount).toBe(1);
  });
});

// ── parseWorktreeList ──────────────────────────────────────────────────────

describe('parseWorktreeList', () => {
  const MAIN = '/Users/user/firefox';

  const porcelainOutput = (worktrees) => worktrees
    .map(({ p, branch }) =>
      `worktree ${p}\nHEAD abc123\n${branch ? `branch refs/heads/${branch}` : 'detached'}`
    )
    .join('\n\n');

  test('returns empty array when only the main repo is listed', () => {
    const output = porcelainOutput([{ p: MAIN, branch: 'main' }]);
    expect(parseWorktreeList(output, MAIN)).toEqual([]);
  });

  test('returns a single worktree with extracted worktreeName from path', () => {
    const output = porcelainOutput([
      { p: MAIN,                        branch: 'main' },
      { p: '/Users/user/firefox-bugABC', branch: 'bug-bugABC' },
    ]);
    const result = parseWorktreeList(output, MAIN);
    expect(result).toHaveLength(1);
    expect(result[0].worktreeName).toBe('bugABC');
    expect(result[0].path).toBe('/Users/user/firefox-bugABC');
    expect(result[0].branch).toBe('bug-bugABC');
  });

  test('returns multiple worktrees', () => {
    const output = porcelainOutput([
      { p: MAIN,                        branch: 'main' },
      { p: '/Users/user/firefox-bugABC', branch: 'bug-ABC' },
      { p: '/Users/user/firefox-bugXYZ', branch: 'bug-XYZ' },
    ]);
    const result = parseWorktreeList(output, MAIN);
    expect(result).toHaveLength(2);
    expect(result.map(w => w.worktreeName)).toEqual(['bugABC', 'bugXYZ']);
  });

  test('handles detached HEAD (no branch line)', () => {
    const output = porcelainOutput([
      { p: MAIN,                        branch: 'main' },
      { p: '/Users/user/firefox-bugABC', branch: null },
    ]);
    const result = parseWorktreeList(output, MAIN);
    expect(result[0].branch).toBeNull();
  });

  test('extracts worktreeName for numeric IDs', () => {
    const output = porcelainOutput([
      { p: MAIN,                         branch: 'main' },
      { p: '/Users/user/firefox-1874041', branch: 'bug-1874041' },
    ]);
    const result = parseWorktreeList(output, MAIN);
    expect(result[0].worktreeName).toBe('1874041');
  });

  test('returns empty array for empty output', () => {
    expect(parseWorktreeList('', MAIN)).toEqual([]);
  });
});

// ── getDiffForCommit ───────────────────────────────────────────────────────

describe('getDiffForCommit', () => {
  const WORKTREE = '/fake/worktree';
  const HASH = 'abc1234';

  const SAMPLE_DIFF = `commit abc1234
Author: Dev <dev@example.com>
Date:   Mon Jan 1 00:00:00 2024

    Add foo

diff --git a/foo.js b/foo.js
--- a/foo.js
+++ b/foo.js
@@ -1,1 +1,2 @@
 line1
+line2`;

  beforeEach(() => {
    execSync.mockReset();
  });

  test('calls git show with the correct hash and worktree path', () => {
    execSync.mockReturnValue(SAMPLE_DIFF);
    getDiffForCommit(WORKTREE, HASH);
    expect(execSync).toHaveBeenCalledWith(
      `git -C "${WORKTREE}" show ${HASH}`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
    );
  });

  test('returns parsed files array in the same format as getDiffPerCommit', () => {
    execSync.mockReturnValue(SAMPLE_DIFF);
    const files = getDiffForCommit(WORKTREE, HASH);
    expect(Array.isArray(files)).toBe(true);
    expect(files).toHaveLength(1);
    expect(files[0].newPath).toBe('foo.js');
    expect(files[0].oldPath).toBe('foo.js');
    expect(files[0].hunks).toHaveLength(1);
    const addedLine = files[0].hunks[0].lines.find((l) => l.type === 'added');
    expect(addedLine).toMatchObject({ type: 'added', content: 'line2' });
  });

  test('throws when git returns an error', () => {
    execSync.mockImplementation(() => { throw new Error('unknown revision'); });
    expect(() => getDiffForCommit(WORKTREE, HASH)).toThrow('unknown revision');
  });
});

// ── parseCommitBody ────────────────────────────────────────────────────────

describe('parseCommitBody', () => {
  test('extracts subject-only message', () => {
    const raw = `commit abc1234
Author: Dev <dev@example.com>
Date:   Mon Jan 13 10:00:00 2025 +0000

    Bug 123 - Part 1: Add WebIDL

diff --git a/foo.js b/foo.js
--- a/foo.js
+++ b/foo.js`;
    expect(parseCommitBody(raw)).toBe('Bug 123 - Part 1: Add WebIDL');
  });

  test('extracts subject + body', () => {
    const raw = `commit abc1234
Author: Dev <dev@example.com>
Date:   Mon Jan 13 10:00:00 2025 +0000

    Bug 123 - Part 1: Add WebIDL

    Fire the event when media is encrypted.
    Also expose the IDL attribute.

diff --git a/foo.js b/foo.js`;
    expect(parseCommitBody(raw)).toBe(
      'Bug 123 - Part 1: Add WebIDL\n\nFire the event when media is encrypted.\nAlso expose the IDL attribute.'
    );
  });

  test('trims trailing blank lines', () => {
    const raw = `commit abc1234
Author: Dev <dev@example.com>
Date:   Mon Jan 13 10:00:00 2025 +0000

    Subject only

diff --git a/foo.js b/foo.js`;
    const result = parseCommitBody(raw);
    expect(result).toBe('Subject only');
    expect(result).not.toMatch(/\n$/);
  });
});

// ── getHeadHash ────────────────────────────────────────────────────────────

describe('getHeadHash', () => {
  test('returns trimmed HEAD hash', () => {
    execSync.mockReturnValue('abc1234def5678\n');
    expect(getHeadHash('/path/to/repo')).toBe('abc1234def5678');
    expect(execSync).toHaveBeenCalledWith(
      'git -C "/path/to/repo" rev-parse HEAD',
      { encoding: 'utf8' }
    );
  });
});

// ── getDiffBetweenCommits ──────────────────────────────────────────────────

describe('getDiffBetweenCommits', () => {
  test('calls git diff with from and to hashes and returns parsed files', () => {
    const { getDiffBetweenCommits } = require('../src/git');
    const diffOutput = `diff --git a/foo.cpp b/foo.cpp
--- a/foo.cpp
+++ b/foo.cpp
@@ -1,3 +1,4 @@
 line1
+newline
 line2
 line3`;
    execSync.mockReturnValue(diffOutput);
    const files = getDiffBetweenCommits('/repo', 'abc111', 'def222');
    expect(execSync).toHaveBeenCalledWith(
      'git -C "/repo" diff abc111 def222',
      expect.objectContaining({ encoding: 'utf8' })
    );
    expect(files).toHaveLength(1);
    expect(files[0].newPath).toBe('foo.cpp');
  });
});

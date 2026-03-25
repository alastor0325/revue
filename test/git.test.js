'use strict';

jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

const { execSync } = require('child_process');
const { getHeadHash, getCommits, parseDiff, parseWorktreeList, getDiffForCommit, parseCommitBody, getMergeBase, getDiffPerCommit } = require('../src/git');

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

  test('strips repo-name prefix from worktree basename for any repo name', () => {
    const output = porcelainOutput([
      { p: '/home/user/myrepo',         branch: 'main' },
      { p: '/home/user/myrepo-feature', branch: 'feature' },
    ]);
    const result = parseWorktreeList(output, '/home/user/myrepo');
    expect(result[0].worktreeName).toBe('feature');
  });

  test('uses full basename when worktree does not start with repo prefix', () => {
    const output = porcelainOutput([
      { p: '/home/user/myrepo',    branch: 'main' },
      { p: '/home/user/something', branch: 'feat' },
    ]);
    const result = parseWorktreeList(output, '/home/user/myrepo');
    expect(result[0].worktreeName).toBe('something');
  });

  test('filters main repo when git outputs forward slashes but mainRepoPath uses backslashes (Windows)', () => {
    // Simulate Windows: git outputs C:/Users/user/firefox but mainRepoPath uses backslashes
    const windowsMain = 'C:\\Users\\user\\firefox';
    const output = [
      'worktree C:/Users/user/firefox\nHEAD abc123\nbranch refs/heads/main',
      'worktree C:/Users/user/firefox-bugABC\nHEAD def456\nbranch refs/heads/bug-ABC',
    ].join('\n\n');
    const result = parseWorktreeList(output, windowsMain);
    expect(result).toHaveLength(1);
    expect(result[0].worktreeName).toBe('bugABC');
  });
});

// ── getHeadHash ────────────────────────────────────────────────────────────

describe('getHeadHash', () => {
  test('returns null when repo has no commits (rev-parse HEAD fails)', () => {
    execSync.mockImplementation(() => { throw new Error('fatal: ambiguous argument HEAD'); });
    expect(getHeadHash('/fake/empty-repo')).toBeNull();
  });

  test('returns trimmed HEAD hash and calls correct git command', () => {
    execSync.mockReturnValue('abc1234def5678\n');
    expect(getHeadHash('/path/to/repo')).toBe('abc1234def5678');
    expect(execSync).toHaveBeenCalledWith(
      'git -C "/path/to/repo" rev-parse HEAD',
      { encoding: 'utf8' }
    );
  });
});

// ── getCommits ─────────────────────────────────────────────────────────────

describe('getCommits', () => {
  test('silently skips malformed log lines that have no space', () => {
    // getMergeBase needs 2 calls (rev-parse origin/main, then merge-base HEAD <tip>)
    // getCommits then needs 1 more (git log)
    execSync
      .mockReturnValueOnce('deadbeef\n')  // rev-parse origin/main → mainTip
      .mockReturnValueOnce('baseabc\n')   // merge-base HEAD deadbeef → base
      .mockReturnValueOnce('abc1234 normal commit\nNOSPACE\ndef5678 another commit\n');
    const result = getCommits('/fake/worktree', '/fake/main');
    expect(result).toHaveLength(2);
    expect(result[0].hash).toBe('abc1234');
    expect(result[1].hash).toBe('def5678');
  });
});

// ── getDiffPerCommit — empty repo ──────────────────────────────────────────

describe('getDiffPerCommit empty repo', () => {
  test('returns empty array when worktree has no commits', () => {
    // All git commands fail — simulates a worktree with no commits
    execSync.mockImplementation(() => { throw new Error('fatal: ambiguous argument HEAD'); });
    expect(getDiffPerCommit('/fake/empty', '/fake/main')).toEqual([]);
  });
});

// ── getMergeBase ───────────────────────────────────────────────────────────

describe('getMergeBase', () => {
  const WORKTREE  = '/fake/worktree';
  const MAIN_REPO = '/fake/firefox';

  beforeEach(() => execSync.mockReset());

  test('uses origin/main when available', () => {
    execSync
      .mockReturnValueOnce('origin-main-hash\n') // rev-parse origin/main
      .mockReturnValueOnce('merge-base-hash\n');  // merge-base HEAD origin/main
    const result = getMergeBase(WORKTREE, MAIN_REPO);
    expect(result).toBe('merge-base-hash');
    expect(execSync).toHaveBeenNthCalledWith(
      1,
      `git -C "${WORKTREE}" rev-parse origin/main`,
      { encoding: 'utf8' }
    );
    expect(execSync).toHaveBeenNthCalledWith(
      2,
      `git -C "${WORKTREE}" merge-base HEAD origin-main-hash`,
      { encoding: 'utf8' }
    );
  });

  test('falls back to main repo HEAD when origin/main is not available', () => {
    execSync
      .mockImplementationOnce(() => { throw new Error('unknown revision'); }) // rev-parse origin/main fails
      .mockReturnValueOnce('main-repo-head\n') // rev-parse HEAD on main repo
      .mockReturnValueOnce('merge-base-hash\n');  // merge-base HEAD main-repo-head
    const result = getMergeBase(WORKTREE, MAIN_REPO);
    expect(result).toBe('merge-base-hash');
    expect(execSync).toHaveBeenNthCalledWith(
      2,
      `git -C "${MAIN_REPO}" rev-parse HEAD`,
      { encoding: 'utf8' }
    );
  });

  test('finds patches when main repo HEAD equals worktree HEAD (jj detached scenario)', () => {
    // Simulate the jj scenario: main repo detached at same commit as worktree,
    // but origin/main correctly points to the integration branch.
    const ORIGIN_MAIN = 'f7ae6e84aaa3';
    const WORKTREE_HEAD = 'eef8f9698f21';
    const MERGE_BASE = ORIGIN_MAIN; // worktree diverged from origin/main

    execSync
      .mockReturnValueOnce(`${ORIGIN_MAIN}\n`)   // rev-parse origin/main
      .mockReturnValueOnce(`${MERGE_BASE}\n`);    // merge-base HEAD origin/main

    const result = getMergeBase(WORKTREE, MAIN_REPO);
    expect(result).toBe(MERGE_BASE);
    // merge-base !== worktree HEAD, so getCommits would find commits — no empty patch list
    expect(result).not.toBe(WORKTREE_HEAD);
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

// ── getFileLines ───────────────────────────────────────────────────────────

describe('getFileLines', () => {
  const { getFileLines } = require('../src/git');
  const WORKTREE = '/fake/worktree';
  const HASH = 'abc1234';
  const FILE = 'dom/media/Foo.cpp';

  beforeEach(() => execSync.mockReset());

  test('calls git show with the correct hash:file syntax', () => {
    execSync.mockReturnValue('content\n');
    getFileLines(WORKTREE, HASH, FILE, 1, 1);
    expect(execSync).toHaveBeenCalledWith(
      `git -C "${WORKTREE}" show "${HASH}:${FILE}"`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
  });

  test('returns correct lines for the requested range', () => {
    execSync.mockReturnValue('line1\nline2\nline3\nline4\nline5\n');
    const result = getFileLines(WORKTREE, HASH, FILE, 2, 4);
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0]).toMatchObject({ type: 'context', content: 'line2', newLineNum: 2, oldLineNum: 2 });
    expect(result.lines[1]).toMatchObject({ type: 'context', content: 'line3', newLineNum: 3, oldLineNum: 3 });
    expect(result.lines[2]).toMatchObject({ type: 'context', content: 'line4', newLineNum: 4, oldLineNum: 4 });
  });

  test('returns totalLines count', () => {
    execSync.mockReturnValue('a\nb\nc\n');
    const result = getFileLines(WORKTREE, HASH, FILE, 1, 2);
    expect(result.totalLines).toBe(3);
  });

  test('clamps end to totalLines when end exceeds file length', () => {
    execSync.mockReturnValue('a\nb\nc\n');
    const result = getFileLines(WORKTREE, HASH, FILE, 2, 100);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].content).toBe('b');
    expect(result.lines[1].content).toBe('c');
  });

  test('returns lines from the start of file when start is 1', () => {
    execSync.mockReturnValue('first\nsecond\nthird\n');
    const result = getFileLines(WORKTREE, HASH, FILE, 1, 2);
    expect(result.lines[0]).toMatchObject({ content: 'first', newLineNum: 1 });
    expect(result.lines[1]).toMatchObject({ content: 'second', newLineNum: 2 });
  });

  test('throws when git throws', () => {
    execSync.mockImplementation(() => { throw new Error('not found'); });
    expect(() => getFileLines(WORKTREE, HASH, FILE, 1, 5)).toThrow('not found');
  });
});

// ── getDiffBetweenCommits ──────────────────────────────────────────────────

describe('getDiffBetweenCommits', () => {
  const { getDiffBetweenCommits } = require('../src/git');

  function makeShowOutput(addedLines) {
    const body = addedLines.map((l) => `+${l}`).join('\n');
    return `commit abc\n\n    Subject\n\ndiff --git a/foo.cpp b/foo.cpp\n--- a/foo.cpp\n+++ b/foo.cpp\n@@ -1,3 +1,${3 + addedLines.length} @@\n line1\n${body}\n line2\n line3`;
  }

  test('returns empty array when both patches are identical', () => {
    const show = makeShowOutput(['  MOZ_ASSERT(x);']);
    execSync.mockReturnValue(show); // same for both calls
    const files = getDiffBetweenCommits('/repo', 'abc111', 'def222');
    expect(files).toHaveLength(0);
  });

  test('shows added lines when new patch adds more than old', () => {
    const fromShow = makeShowOutput(['  MOZ_ASSERT(x);']);
    const toShow   = makeShowOutput(['  MOZ_ASSERT(x);', '  newLine();']);
    execSync
      .mockReturnValueOnce(fromShow) // getDiffForCommit(fromHash)
      .mockReturnValueOnce(toShow);  // getDiffForCommit(toHash)
    const files = getDiffBetweenCommits('/repo', 'abc111', 'def222');
    expect(files).toHaveLength(1);
    expect(files[0].newPath).toBe('foo.cpp');
    const lines = files[0].hunks[0].lines;
    expect(lines.find((l) => l.type === 'added'  && l.content === '  newLine();')).toBeTruthy();
    expect(lines.find((l) => l.type === 'context' && l.content === '  MOZ_ASSERT(x);')).toBeTruthy();
  });

  test('shows removed lines when new patch drops a line from the old', () => {
    const fromShow = makeShowOutput(['  MOZ_ASSERT(x);', '  droppedLine();']);
    const toShow   = makeShowOutput(['  MOZ_ASSERT(x);']);
    execSync
      .mockReturnValueOnce(fromShow)
      .mockReturnValueOnce(toShow);
    const files = getDiffBetweenCommits('/repo', 'abc111', 'def222');
    expect(files).toHaveLength(1);
    const lines = files[0].hunks[0].lines;
    expect(lines.find((l) => l.type === 'removed' && l.content === '  droppedLine();')).toBeTruthy();
  });
});

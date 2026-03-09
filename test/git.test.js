'use strict';

const { parseDiff } = require('../src/git');

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

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function normPath(p) {
  return path.normalize(p).replace(/\\/g, '/');
}

/**
 * Return the current HEAD commit hash of the given repo/worktree.
 * Returns null if the repo has no commits yet.
 */
function getHeadHash(worktreePath) {
  try {
    return execSync(`git -C "${worktreePath}" rev-parse HEAD`, {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Find the merge-base between the worktree HEAD and the upstream main branch.
 *
 * Tries remote refs in order: origin/main, origin/master, origin/HEAD.
 * Falls back to the main repo's HEAD only when it is a different path from the
 * worktree — using the same path would yield merge-base HEAD HEAD = HEAD,
 * producing zero commits (the bug that manifests with --repo on a standalone repo).
 */
function getMergeBase(worktreePath, mainRepoPath) {
  const candidates = [
    `git -C "${worktreePath}" rev-parse origin/main`,
    `git -C "${worktreePath}" rev-parse origin/master`,
    `git -C "${worktreePath}" rev-parse origin/HEAD`,
  ];

  if (normPath(mainRepoPath) !== normPath(worktreePath)) {
    candidates.push(`git -C "${mainRepoPath}" rev-parse HEAD`);
  }

  let mainTip;
  for (const cmd of candidates) {
    try {
      mainTip = execSync(cmd, { encoding: 'utf8' }).trim();
      break;
    } catch {
      // continue
    }
  }

  if (!mainTip) {
    throw new Error('Cannot determine base commit: no origin/main, origin/master, or origin/HEAD found');
  }

  return execSync(
    `git -C "${worktreePath}" merge-base HEAD ${mainTip}`,
    { encoding: 'utf8' }
  ).trim();
}

/**
 * Get list of commits ahead of the merge-base.
 * Returns array of { hash, message } objects, oldest first.
 * Returns [] if the worktree has no commits or the merge-base cannot be determined.
 */
function getCommits(worktreePath, mainRepoPath) {
  let base;
  try {
    base = getMergeBase(worktreePath, mainRepoPath);
  } catch {
    return [];
  }
  const output = execSync(
    `git -C "${worktreePath}" log --oneline --reverse ${base}..HEAD`,
    { encoding: 'utf8' }
  ).trim();

  if (!output) return [];

  return output.split('\n').map((line) => {
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) return null;
    return {
      hash: line.slice(0, spaceIdx),
      message: line.slice(spaceIdx + 1),
    };
  }).filter(Boolean);
}

/**
 * Parse a unified diff string into structured data.
 * Returns array of file objects:
 * {
 *   oldPath: string,
 *   newPath: string,
 *   binary: boolean,
 *   hunks: [{
 *     oldStart, oldCount, newStart, newCount,
 *     lines: [{ type: 'context'|'added'|'removed', content: string, newLineNum: number|null, oldLineNum: number|null }]
 *   }]
 * }
 */
function parseDiff(diffText) {
  const files = [];
  const lines = diffText.split('\n');

  let i = 0;
  let currentFile = null;
  let currentHunk = null;
  let oldLineNum = 0;
  let newLineNum = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Start of a new file diff
    if (line.startsWith('diff --git ')) {
      if (currentFile) {
        if (currentHunk) {
          currentFile.hunks.push(currentHunk);
          currentHunk = null;
        }
        files.push(currentFile);
      }
      currentFile = {
        oldPath: null,
        newPath: null,
        binary: false,
        hunks: [],
      };
      i++;
      continue;
    }

    if (!currentFile) {
      i++;
      continue;
    }

    // Binary file notice
    if (line.startsWith('Binary files')) {
      currentFile.binary = true;
      i++;
      continue;
    }

    // Old file path
    if (line.startsWith('--- ')) {
      const p = line.slice(4);
      currentFile.oldPath = p.startsWith('a/') ? p.slice(2) : p;
      i++;
      continue;
    }

    // New file path
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      currentFile.newPath = p.startsWith('b/') ? p.slice(2) : p;
      i++;
      continue;
    }

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    if (line.startsWith('@@ ')) {
      if (currentHunk) {
        currentFile.hunks.push(currentHunk);
      }
      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        oldLineNum = parseInt(match[1], 10);
        newLineNum = parseInt(match[3], 10);
        currentHunk = {
          oldStart: oldLineNum,
          oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
          newStart: newLineNum,
          newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
          header: line,
          lines: [],
        };
      }
      i++;
      continue;
    }

    // Diff content lines
    if (currentHunk) {
      if (line.startsWith('+')) {
        currentHunk.lines.push({
          type: 'added',
          content: line.slice(1),
          newLineNum: newLineNum,
          oldLineNum: null,
        });
        newLineNum++;
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({
          type: 'removed',
          content: line.slice(1),
          newLineNum: null,
          oldLineNum: oldLineNum,
        });
        oldLineNum++;
      } else if (line.startsWith(' ') || line === '') {
        currentHunk.lines.push({
          type: 'context',
          content: line.length > 0 ? line.slice(1) : '',
          newLineNum: newLineNum,
          oldLineNum: oldLineNum,
        });
        oldLineNum++;
        newLineNum++;
      }
      // Lines like "\ No newline at end of file" — skip
    }

    i++;
  }

  // Flush last hunk and file
  if (currentHunk && currentFile) {
    currentFile.hunks.push(currentHunk);
  }
  if (currentFile) {
    files.push(currentFile);
  }

  // Filter out binary files
  return files.filter((f) => !f.binary && (f.oldPath || f.newPath));
}

/**
 * Extract the full commit message body from `git show` output.
 * The output has headers (commit/Author/Date), a blank line, then the
 * message indented with 4 spaces, then the diff starting with "diff --git".
 */
function parseCommitBody(raw) {
  const lines = raw.split('\n');
  let pastHeaders = false;
  const msgLines = [];
  for (const line of lines) {
    if (line.startsWith('diff --git ')) break;
    if (!pastHeaders) {
      if (line === '') pastHeaders = true;
      continue;
    }
    msgLines.push(line.startsWith('    ') ? line.slice(4) : line);
  }
  while (msgLines.length > 0 && msgLines[msgLines.length - 1].trim() === '') {
    msgLines.pop();
  }
  return msgLines.join('\n');
}

/**
 * Collect only the non-context lines (added/removed) from a parsed file diff.
 * These represent what the commit actually changes.
 */
function getPatchLines(file) {
  const lines = [];
  for (const hunk of (file ? file.hunks : [])) {
    for (const line of hunk.lines) {
      if (line.type !== 'context') {
        lines.push({ type: line.type, content: line.content });
      }
    }
  }
  return lines;
}

/**
 * LCS-based diff of two sequences of patch lines.
 * Returns array of { inFrom, inTo, type, content }.
 */
function lcsCompare(fromLines, toLines) {
  const fromKeys = fromLines.map((l) => l.type + ':' + l.content);
  const toKeys   = toLines.map((l) => l.type + ':' + l.content);
  const m = fromKeys.length;
  const n = toKeys.length;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = fromKeys[i - 1] === toKeys[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const result = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && fromKeys[i - 1] === toKeys[j - 1]) {
      result.unshift({ inFrom: true,  inTo: true,  ...fromLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ inFrom: false, inTo: true,  ...toLines[j - 1] });
      j--;
    } else {
      result.unshift({ inFrom: true,  inTo: false, ...fromLines[i - 1] });
      i--;
    }
  }
  return result;
}

/**
 * Compare two revisions of the same patch by diffing what each commit
 * introduces (git show) rather than comparing full tree states.
 * This avoids including changes from other commits in the series.
 *
 * Returns file diffs in the same format as parseDiff, where:
 *   added   = line is new to toHash's patch
 *   removed = line was in fromHash's patch but dropped in toHash's
 *   context = line appears in both patch versions unchanged
 * Line numbers are null (not meaningful across patch versions).
 */
function getDiffBetweenCommits(worktreePath, fromHash, toHash) {
  const fromFiles = getDiffForCommit(worktreePath, fromHash);
  const toFiles   = getDiffForCommit(worktreePath, toHash);

  const fromMap = new Map(fromFiles.map((f) => [f.newPath || f.oldPath, f]));
  const toMap   = new Map(toFiles.map((f)   => [f.newPath || f.oldPath, f]));
  const allPaths = [...new Set([...fromMap.keys(), ...toMap.keys()])];

  const result = [];
  for (const filePath of allPaths) {
    const fromLines = getPatchLines(fromMap.get(filePath));
    const toLines   = getPatchLines(toMap.get(filePath));
    const compared  = lcsCompare(fromLines, toLines);

    if (!compared.some((d) => d.inFrom !== d.inTo)) continue; // no delta

    const lines = compared.map((d) => ({
      type:       d.inFrom && d.inTo ? 'context' : d.inTo ? 'added' : 'removed',
      content:    d.content,
      oldLineNum: null,
      newLineNum: null,
    }));

    result.push({
      oldPath: filePath,
      newPath: filePath,
      binary: false,
      hunks: [{ header: '@@ patch delta @@', oldStart: 1, oldCount: 0, newStart: 1, newCount: 0, lines }],
    });
  }
  return result;
}

/**
 * Get the diff for a single commit by hash.
 * @param {string} worktreePath
 * @param {string} hash
 * @returns {Array} files array (same format as getDiffPerCommit entries)
 */
function getDiffForCommit(worktreePath, hash) {
  const raw = execSync(
    `git -C "${worktreePath}" show ${hash}`,
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
  );
  return parseDiff(raw);
}

/**
 * Get per-commit diffs. Returns an array of patch objects (oldest first):
 * { hash, message, body, files }
 * message — subject line only (first line)
 * body    — full commit message (subject + blank line + body if present)
 */
function getDiffPerCommit(worktreePath, mainRepoPath) {
  const commits = getCommits(worktreePath, mainRepoPath);
  return commits.map((commit) => {
    // git show outputs commit metadata then the diff; parseDiff ignores everything
    // before the first "diff --git" line so this works without extra flags.
    const raw = execSync(
      `git -C "${worktreePath}" show ${commit.hash}`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
    );
    return {
      hash: commit.hash,
      message: commit.message,
      body: parseCommitBody(raw),
      files: parseDiff(raw),
    };
  });
}

/**
 * Parse the output of `git worktree list --porcelain` into an array of
 * { path, branch } objects, excluding the main repo path.
 *
 * The worktreeName is derived from the directory basename. If the basename
 * starts with "<mainRepoBasename>-" (e.g. "firefox-bugABC" for a main repo
 * named "firefox"), that prefix is stripped to produce a shorter name.
 *
 * @param {string} output - stdout from `git worktree list --porcelain`
 * @param {string} mainRepoPath - path to exclude (the main repo itself)
 * @returns {Array<{ path: string, branch: string|null, worktreeName: string }>}
 */
function parseWorktreeList(output, mainRepoPath) {
  const mainBasename = path.basename(mainRepoPath.replace(/\\/g, '/'));
  const prefix = mainBasename + '-';
  const blocks = output.trim().split(/\n\n+/);
  return blocks
    .map((block) => {
      const lines = block.split('\n');
      const pathLine = lines.find((l) => l.startsWith('worktree '));
      const branchLine = lines.find((l) => l.startsWith('branch '));
      if (!pathLine) return null;
      const wtPath = pathLine.slice('worktree '.length).trim();
      const branch = branchLine
        ? branchLine.slice('branch refs/heads/'.length).trim()
        : null;
      return { path: wtPath, branch };
    })
    .filter(Boolean)
    .filter((wt) => normPath(wt.path) !== normPath(mainRepoPath))
    .map((wt) => {
      const basename = path.basename(wt.path);
      const worktreeName = basename.startsWith(prefix) ? basename.slice(prefix.length) : basename;
      return { path: wt.path, branch: wt.branch, worktreeName };
    });
}

/**
 * Discover all worktrees registered with the given repo, excluding the main
 * repo itself.
 *
 * @param {string} mainRepoPath - path to the main repo
 * @returns {Array<{ path: string, branch: string|null, worktreeName: string }>}
 */
function discoverWorktrees(mainRepoPath) {
  // Resolve symlinks so the path matches what git reports in worktree list output.
  // On macOS, os.tmpdir() returns /var/... but git resolves it to /private/var/...
  let resolvedMain = mainRepoPath;
  try { resolvedMain = fs.realpathSync(mainRepoPath); } catch { /* fall back to unresolved */ }
  const output = execSync(`git -C "${mainRepoPath}" worktree list --porcelain`, {
    encoding: 'utf8',
  });
  return parseWorktreeList(output, resolvedMain);
}

/**
 * Fetch a range of lines from a file at a specific commit.
 * Returns { lines: [{type, content, newLineNum, oldLineNum}], totalLines }.
 * Lines are 1-indexed; both start and end are inclusive.
 */
function getFileLines(worktreePath, hash, filePath, start, end) {
  const raw = execSync(
    `git -C "${worktreePath}" show "${hash}:${filePath}"`,
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  const allLines = raw.split('\n');
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();
  const totalLines = allLines.length;
  const lines = [];
  for (let i = start; i <= Math.min(end, totalLines); i++) {
    lines.push({ type: 'context', content: allLines[i - 1], newLineNum: i, oldLineNum: i });
  }
  return { lines, totalLines };
}

module.exports = { getHeadHash, getCommits, getDiffPerCommit, getDiffForCommit, getDiffBetweenCommits, getMergeBase, parseDiff, parseCommitBody, parseWorktreeList, discoverWorktrees, getFileLines, getPatchLines, lcsCompare };

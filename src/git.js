'use strict';

const { execSync } = require('child_process');

/**
 * Find the merge-base between the worktree HEAD and the main repo HEAD.
 */
function getMergeBase(worktreePath, mainRepoPath) {
  const mainHead = execSync(`git -C "${mainRepoPath}" rev-parse HEAD`, {
    encoding: 'utf8',
  }).trim();

  const mergeBase = execSync(
    `git -C "${worktreePath}" merge-base HEAD ${mainHead}`,
    { encoding: 'utf8' }
  ).trim();

  return mergeBase;
}

/**
 * Get list of commits ahead of the merge-base.
 * Returns array of { hash, message } objects, oldest first.
 */
function getCommits(worktreePath, mainRepoPath) {
  const base = getMergeBase(worktreePath, mainRepoPath);
  const output = execSync(
    `git -C "${worktreePath}" log --oneline --reverse ${base}..HEAD`,
    { encoding: 'utf8' }
  ).trim();

  if (!output) return [];

  return output.split('\n').map((line) => {
    const spaceIdx = line.indexOf(' ');
    return {
      hash: line.slice(0, spaceIdx),
      message: line.slice(spaceIdx + 1),
    };
  });
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
 * Get per-commit diffs. Returns an array of patch objects (oldest first):
 * { hash, message, files }
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
      files: parseDiff(raw),
    };
  });
}

module.exports = { getCommits, getDiffPerCommit, getMergeBase, parseDiff };

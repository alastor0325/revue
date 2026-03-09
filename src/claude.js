'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Format the structured review prompt for a single patch.
 *
 * @param {string} worktreeName - name of the worktree (suffix of firefox-<name>)
 * @param {{ hash: string, message: string }} patch  - the specific patch being reviewed
 * @param {Array<{ hash: string, message: string }>} allPatches - all patches in the series
 * @param {Array<{ file: string, line: number, lineContent: string, text: string }>} comments
 * @param {string[]} skippedHashes - hashes of patches the reviewer chose to skip
 * @returns {string}
 */
function formatPrompt(worktreeName, patch, allPatches, comments, skippedHashes = [], generalComment = '') {
  const skipped = new Set(skippedHashes);
  const patchNum = allPatches.findIndex((p) => p.hash === patch.hash) + 1;
  const totalPatches = allPatches.length;

  const seriesList = allPatches
    .map((p) => {
      let suffix = '';
      if (p.hash === patch.hash) suffix = '  ← THIS PATCH';
      else if (skipped.has(p.hash)) suffix = '  [SKIPPED — not reviewed]';
      return `- ${p.hash} ${p.message}${suffix}`;
    })
    .join('\n');

  const generalSection = generalComment.trim()
    ? `## General feedback for Part ${patchNum}:\n\n${generalComment.trim()}\n`
    : '';

  const lineFeedbackItems = comments
    .map((c) => [
      `### ${c.file} : line ${c.line}`,
      `[YOUR CODE] : ${c.lineContent}`,
      `[FEEDBACK]  : ${c.text}`,
    ].join('\n'))
    .join('\n\n');

  const lineSection = lineFeedbackItems
    ? `## Line-level feedback for Part ${patchNum}:\n\n${lineFeedbackItems}\n`
    : '';

  return `You are being asked to revise your implementation in worktree firefox-${worktreeName}.

## Patch under review (Part ${patchNum} of ${totalPatches}):
- ${patch.hash} ${patch.message}

## Full patch series for context:
${seriesList}

${generalSection}${lineSection}
## Instructions:
All feedback above is scoped to Part ${patchNum} only — modify only files changed in that commit unless a fix strictly requires touching other code. After making changes, summarize what you changed for each feedback item.
`;
}

/**
 * Write REVIEW_FEEDBACK_<hash>.md to the worktree and return the command to run.
 *
 * @param {string} worktreePath
 * @param {string} worktreeName
 * @param {{ hash: string, message: string }} patch
 * @param {Array} allPatches
 * @param {Array} comments
 * @param {string[]} skippedHashes
 * @returns {{ feedbackPath: string, command: string }}
 */
function submitReview(worktreePath, worktreeName, patch, allPatches, comments, skippedHashes = [], generalComment = '') {
  const prompt = formatPrompt(worktreeName, patch, allPatches, comments, skippedHashes, generalComment);
  const filename = `REVIEW_FEEDBACK_${patch.hash}.md`;
  const feedbackPath = path.join(worktreePath, filename);
  fs.writeFileSync(feedbackPath, prompt, 'utf8');

  let command;
  if (os.platform() === 'win32') {
    command = `cd /d "${worktreePath}" && powershell -Command "Get-Content '${filename}' -Raw | claude --print -"`;
  } else {
    command = `cd "${worktreePath}" && claude --print "$(cat ${filename})"`;
  }

  return { feedbackPath, command };
}

module.exports = { formatPrompt, submitReview };

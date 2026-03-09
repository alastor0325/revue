'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Format a combined review prompt covering all patches in the series.
 *
 * @param {string} worktreeName
 * @param {Array<{ hash: string, message: string }>} allPatches
 * @param {Array<{ hash: string, comments: Array, generalComment: string }>} allFeedback
 * @param {string[]} skippedHashes
 * @param {string[]} approvedHashes
 * @returns {string}
 */
function formatCombinedPrompt(worktreeName, allPatches, allFeedback, skippedHashes = [], approvedHashes = []) {
  const skipped = new Set(skippedHashes);
  const approved = new Set(approvedHashes);
  const feedbackMap = Object.fromEntries(allFeedback.map((f) => [f.hash, f]));

  const seriesList = allPatches
    .map((p) => {
      let suffix = '';
      if (skipped.has(p.hash)) suffix = '  [SKIPPED — not reviewed]';
      else if (approved.has(p.hash)) suffix = '  [APPROVED — no issues]';
      return `- ${p.hash} ${p.message}${suffix}`;
    })
    .join('\n');

  const feedbackSections = allPatches
    .filter((p) => {
      if (skipped.has(p.hash) || approved.has(p.hash)) return false;
      const fb = feedbackMap[p.hash];
      if (!fb) return false;
      return fb.comments.length > 0 || (fb.generalComment || '').trim().length > 0;
    })
    .map((p) => {
      const patchNum = allPatches.findIndex((x) => x.hash === p.hash) + 1;
      const fb = feedbackMap[p.hash];
      const general = (fb.generalComment || '').trim();

      const generalSection = general
        ? `### General feedback:\n\n${general}\n`
        : '';

      const lineFeedbackItems = fb.comments
        .map((c) => [
          `#### ${c.file} : line ${c.line}`,
          `[YOUR CODE] : ${c.lineContent}`,
          `[FEEDBACK]  : ${c.text}`,
        ].join('\n'))
        .join('\n\n');

      const lineSection = lineFeedbackItems
        ? `### Line-level feedback:\n\n${lineFeedbackItems}\n`
        : '';

      return `## Part ${patchNum} (${p.hash}) — ${p.message}\n\n${generalSection}${lineSection}`;
    })
    .join('\n---\n\n');

  return `You are being asked to revise your implementation in worktree firefox-${worktreeName}.

## Full patch series:
${seriesList}

---

${feedbackSections}## Instructions:
For each part with feedback above, apply changes only to files modified in that commit unless a fix strictly requires touching other code. After making changes, summarize what you changed for each feedback item.
`;
}

/**
 * Write REVIEW_FEEDBACK_<worktreeName>.md and return the command to run.
 *
 * @param {string} worktreePath
 * @param {string} worktreeName
 * @param {Array<{ hash: string, message: string }>} allPatches
 * @param {Array<{ hash: string, comments: Array, generalComment: string }>} allFeedback
 * @param {string[]} skippedHashes
 * @param {string[]} approvedHashes
 * @returns {{ feedbackPath: string, command: string }}
 */
function submitReview(worktreePath, worktreeName, allPatches, allFeedback, skippedHashes = [], approvedHashes = []) {
  const prompt = formatCombinedPrompt(worktreeName, allPatches, allFeedback, skippedHashes, approvedHashes);
  const filename = `REVIEW_FEEDBACK_${worktreeName}.md`;
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

module.exports = { formatCombinedPrompt, submitReview };

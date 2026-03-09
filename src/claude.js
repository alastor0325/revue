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
 * @param {string[]} deniedHashes
 * @returns {string}
 */
function formatCombinedPrompt(worktreeName, allPatches, allFeedback, skippedHashes = [], approvedHashes = [], deniedHashes = []) {
  const skipped = new Set(skippedHashes);
  const approved = new Set(approvedHashes);
  const denied = new Set(deniedHashes);
  const feedbackMap = Object.fromEntries(allFeedback.map((f) => [f.hash, f]));

  const seriesList = allPatches
    .map((p) => {
      let suffix = '';
      if (skipped.has(p.hash)) suffix = '  [SKIPPED — not reviewed]';
      else if (approved.has(p.hash)) suffix = '  [APPROVED — no issues]';
      else if (denied.has(p.hash)) suffix = '  [DENIED — requires significant changes]';
      return `- ${p.hash} ${p.message}${suffix}`;
    })
    .join('\n');

  const feedbackSections = allPatches
    .filter((p) => {
      if (skipped.has(p.hash) || approved.has(p.hash)) return false;
      const fb = feedbackMap[p.hash];
      if (!fb) return false;
      const hasFeedback = fb.comments.length > 0 || (fb.generalComment || '').trim().length > 0;
      return hasFeedback || denied.has(p.hash);
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

      const deniedNote = denied.has(p.hash)
        ? '\n⚠ This patch was denied — it requires significant changes.\n'
        : '';

      return `## Part ${patchNum} (${p.hash}) — ${p.message}\n${deniedNote}\n${generalSection}${lineSection}`;
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
 * Write REVIEW_FEEDBACK_<worktreeName>.md and return the prompt text.
 *
 * @param {string} worktreePath
 * @param {string} worktreeName
 * @param {Array<{ hash: string, message: string }>} allPatches
 * @param {Array<{ hash: string, comments: Array, generalComment: string }>} allFeedback
 * @param {string[]} skippedHashes
 * @param {string[]} approvedHashes
 * @param {string[]} deniedHashes
 * @returns {{ feedbackPath: string, prompt: string }}
 */
function submitReview(worktreePath, worktreeName, allPatches, allFeedback, skippedHashes = [], approvedHashes = [], deniedHashes = []) {
  const fileContent = formatCombinedPrompt(worktreeName, allPatches, allFeedback, skippedHashes, approvedHashes, deniedHashes);
  const filename = `REVIEW_FEEDBACK_${worktreeName}.md`;
  const feedbackPath = path.join(worktreePath, filename);
  fs.writeFileSync(feedbackPath, fileContent, 'utf8');
  const prompt = `Please read the review feedback at ${feedbackPath} and apply all the changes described there to your implementation in worktree firefox-${worktreeName}.`;
  return { feedbackPath, prompt };
}

module.exports = { formatCombinedPrompt, submitReview };

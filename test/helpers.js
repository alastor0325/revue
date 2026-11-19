'use strict';

const { execSync } = require('child_process');
const path = require('path');

function git(cwd, cmd) {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// Where revue persists review state for a worktree: inside its git directory
// (`.git/worktrees/<name>` for a linked worktree, `<repo>/.git` for the main
// repo). Mirrors src/server.js stateFilePath().
function stateFilePathFor(worktreePath) {
  const gitDir = execSync(`git -C "${worktreePath}" rev-parse --absolute-git-dir`, { encoding: 'utf8' }).trim();
  return path.join(gitDir, 'revue-state.json');
}

// Whether the bikeshed CLI is installed (tests that need it are skipped otherwise).
const hasBikeshed = (() => {
  try { require('child_process').execSync('bikeshed --version', { stdio: 'ignore' }); return true; } catch { return false; }
})();

// A minimal Bikeshed spec: metadata (with an ED: address) plus `body` under one section.
function bikeshedSpec({ title = 'T', ed = 'https://example.org/t/', body = 'Hello.' } = {}) {
  return `<pre class=metadata>\nTitle: ${title}\nShortname: t\nLevel: none\nStatus: LS\nED: ${ed}\n`
    + `Editor: A B\nAbstract: x\n</pre>\n\nIntro {#intro}\n=====\n\n${body}\n`;
}

// The worktree bar's markup, taken from public/index.html so jsdom tests use
// the real one.
const WORKTREE_BAR_HTML = (() => {
  const html = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const start = html.indexOf('<div id="worktree-bar"');
  const end = html.indexOf('<!-- ── Update notification banner', start);
  return html.slice(start, end).replace(' style="display:none;"', '');
})();

module.exports = { git, stateFilePathFor, hasBikeshed, bikeshedSpec, WORKTREE_BAR_HTML };

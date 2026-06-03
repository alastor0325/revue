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

module.exports = { git, stateFilePathFor };

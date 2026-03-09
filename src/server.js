'use strict';

const express = require('express');
const path = require('path');
const net = require('net');
const os = require('os');
const { execSync } = require('child_process');
const { getDiffPerCommit } = require('./git');
const { submitReview } = require('./claude');

/**
 * Open the browser in a cross-platform way.
 */
function openBrowser(url) {
  const cmds = {
    win32:  `start "" "${url}"`,
    darwin: `open "${url}"`,
    linux:  `xdg-open "${url}"`,
  };
  const cmd = cmds[os.platform()] || cmds.linux;
  try {
    execSync(cmd);
  } catch {
    console.log(`Open your browser at: ${url}`);
  }
}

/**
 * Find an available port starting from the preferred port.
 */
function findAvailablePort(preferred) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(preferred, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', () => resolve(findAvailablePort(preferred + 1)));
  });
}

/**
 * Create and return the Express app without starting the server.
 * Exported separately so tests can import it without side effects.
 */
function createApp({ bugId, worktreePath, mainRepoPath }) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Cache patches so we only compute once per app instance
  let patchesCache = null;

  function loadData() {
    if (patchesCache) return;
    console.log('Computing git diff...');
    try {
      patchesCache = getDiffPerCommit(worktreePath, mainRepoPath);
      const totalFiles = patchesCache.reduce((n, p) => n + p.files.length, 0);
      console.log(
        `Found ${patchesCache.length} patch(es), ${totalFiles} changed file(s) total.`
      );
    } catch (err) {
      console.error('Error computing diff:', err.message);
      throw err;
    }
  }

  // GET /api/diff — return patches (one per commit) and metadata
  app.get('/api/diff', (req, res) => {
    try {
      loadData();
      res.json({
        bugId,
        worktreePath,
        patches: patchesCache,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/submit — write REVIEW_FEEDBACK_<hash>.md and return the claude command
  app.post('/api/submit', (req, res) => {
    const { patchHash, comments } = req.body;

    if (!patchHash) {
      return res.status(400).json({ error: 'patchHash is required.' });
    }
    if (!comments || !Array.isArray(comments) || comments.length === 0) {
      return res.status(400).json({ error: 'No comments provided.' });
    }

    try {
      loadData();
      const patch = patchesCache.find((p) => p.hash === patchHash);
      if (!patch) {
        return res.status(404).json({ error: `Patch ${patchHash} not found.` });
      }

      const { feedbackPath, command } = submitReview(
        worktreePath,
        bugId,
        patch,
        patchesCache,
        comments
      );
      res.json({ ok: true, feedbackPath, command });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

/**
 * Start the review web server.
 */
async function startServer({ bugId, worktreePath, mainRepoPath }) {
  const app = createApp({ bugId, worktreePath, mainRepoPath });
  const port = await findAvailablePort(7777);

  app.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log(`\nfirefox-review server running at ${url}`);
    console.log(`Reviewing ${bugId} — worktree: ${worktreePath}\n`);
    openBrowser(url);
  });
}

module.exports = { startServer, createApp };

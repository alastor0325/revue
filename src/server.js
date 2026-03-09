'use strict';

const express = require('express');
const path = require('path');
const net = require('net');
const os = require('os');
const fs = require('fs');
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
    server.listen(preferred, '127.0.0.1', () => {
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
function createApp({ worktreeName, worktreePath, mainRepoPath }) {
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
        worktreeName,
        worktreePath,
        patches: patchesCache,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/state — load persisted review state, including existing prompt if available
  app.get('/api/state', (req, res) => {
    const statePath = path.join(worktreePath, `REVIEW_STATE_${worktreeName}.json`);
    const mdPath = path.join(worktreePath, `REVIEW_FEEDBACK_${worktreeName}.md`);
    try {
      const state = fs.existsSync(statePath)
        ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
        : {};
      const prompt = fs.existsSync(mdPath)
        ? fs.readFileSync(mdPath, 'utf8')
        : null;
      res.json({ ...state, prompt });
    } catch {
      res.json({});
    }
  });

  // POST /api/state — persist review state only (never touches the MD file)
  app.post('/api/state', (req, res) => {
    const statePath = path.join(worktreePath, `REVIEW_STATE_${worktreeName}.json`);
    try {
      fs.writeFileSync(statePath, JSON.stringify(req.body, null, 2), 'utf8');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/submit — write REVIEW_FEEDBACK_<worktreeName>.md and return the prompt
  app.post('/api/submit', (req, res) => {
    const { allFeedback } = req.body;

    if (!Array.isArray(allFeedback)) {
      return res.status(400).json({ error: 'allFeedback is required.' });
    }

    const skippedHashes  = Array.isArray(req.body.skippedHashes)  ? req.body.skippedHashes  : [];
    const approvedHashes = Array.isArray(req.body.approvedHashes) ? req.body.approvedHashes : [];
    const deniedHashes   = Array.isArray(req.body.deniedHashes)   ? req.body.deniedHashes   : [];

    const hasActivity =
      skippedHashes.length > 0 ||
      approvedHashes.length > 0 ||
      deniedHashes.length > 0 ||
      allFeedback.some(
        (f) => (Array.isArray(f.comments) && f.comments.length > 0) ||
               (f.generalComment || '').trim().length > 0
      );

    if (!hasActivity) {
      return res.status(400).json({ error: 'No feedback to submit.' });
    }

    try {
      loadData();
      const { feedbackPath, prompt } = submitReview(
        worktreePath,
        worktreeName,
        patchesCache,
        allFeedback,
        skippedHashes,
        approvedHashes,
        deniedHashes
      );
      res.json({ ok: true, feedbackPath, prompt });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

/**
 * Start the review web server.
 */
async function startServer({ worktreeName, worktreePath, mainRepoPath }) {
  const app = createApp({ worktreeName, worktreePath, mainRepoPath });
  const port = await findAvailablePort(7777);

  app.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log(`\nfirefox-review server running at ${url}`);
    console.log(`Reviewing ${worktreeName} — worktree: ${worktreePath}\n`);
    openBrowser(url);
  });
}

module.exports = { startServer, createApp, findAvailablePort };

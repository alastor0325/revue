'use strict';

const SERVER_START = String(Date.now()); // unique token per process — used for browser auto-reload

const express = require('express');
const path = require('path');
const net = require('net');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const { getHeadHash, getDiffPerCommit, getDiffForCommit, getDiffBetweenCommits, getFileLines, discoverWorktrees } = require('./git');
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
function createApp({ worktreeName: initialWorktreeName, worktreePath: initialWorktreePath, mainRepoPath }) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Active worktree — mutable so /api/switch can change them at runtime
  let worktreeName = initialWorktreeName;
  let worktreePath = initialWorktreePath;

  // Cache patches, invalidated automatically when the worktree HEAD changes
  let patchesCache = null;
  let cachedHeadHash = null;

  function loadData() {
    const currentHead = getHeadHash(worktreePath);
    if (patchesCache && cachedHeadHash === currentHead) return;
    console.log('Computing git diff...');
    try {
      patchesCache = getDiffPerCommit(worktreePath, mainRepoPath);
      cachedHeadHash = currentHead;
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

    const approvedHashes = Array.isArray(req.body.approvedHashes) ? req.body.approvedHashes : [];
    const deniedHashes   = Array.isArray(req.body.deniedHashes)   ? req.body.deniedHashes   : [];

    const hasActivity =
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
        approvedHashes,
        deniedHashes
      );
      res.json({ ok: true, feedbackPath, prompt });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/headhash — return current HEAD hash so the client can detect when the codebase changes
  app.get('/api/headhash', (req, res) => {
    try {
      res.json({ hash: getHeadHash(worktreePath) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/reload — SSE endpoint; emits server start token so the browser can detect restarts
  app.get('/api/reload', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`data: ${SERVER_START}\n\n`);
    const interval = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => clearInterval(interval));
  });

  // GET /api/revdiff?from=hash1&to=hash2 — diff between two commit hashes (compare two revisions)
  app.get('/api/revdiff', (req, res) => {
    const { from, to } = req.query;
    const hashRe = /^[0-9a-f]{4,40}$/i;
    if (!from || !to || !hashRe.test(from) || !hashRe.test(to)) {
      return res.status(400).json({ error: 'Invalid hash format.' });
    }
    try {
      const files = getDiffBetweenCommits(worktreePath, from, to);
      res.json({ from, to, files });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/patchdiff/:hash — return diff for a single commit hash (for revision comparison)
  app.get('/api/patchdiff/:hash', (req, res) => {
    const { hash } = req.params;
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) {
      return res.status(400).json({ error: 'Invalid hash format.' });
    }
    try {
      const files = getDiffForCommit(worktreePath, hash);
      res.json({ hash, files });
    } catch (err) {
      res.status(404).json({ error: `Commit ${hash} not found: ${err.message}` });
    }
  });

  // GET /api/worktrees — list all discoverable worktrees and which one is active
  app.get('/api/worktrees', (req, res) => {
    try {
      const others = discoverWorktrees(mainRepoPath);
      const all = [
        { worktreeName: path.basename(mainRepoPath), path: mainRepoPath, isMain: true },
        ...others,
      ];
      res.json({ current: worktreeName, worktrees: all });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/switch — switch the active worktree; clears the patch cache
  app.post('/api/switch', (req, res) => {
    const { worktreeName: newName } = req.body;
    if (!newName || typeof newName !== 'string') {
      return res.status(400).json({ error: 'worktreeName is required.' });
    }
    try {
      const others = discoverWorktrees(mainRepoPath);
      const all = [
        { worktreeName: path.basename(mainRepoPath), path: mainRepoPath },
        ...others,
      ];
      const found = all.find((w) => w.worktreeName === newName);
      if (!found) {
        return res.status(404).json({ error: `Worktree '${newName}' not found.` });
      }
      worktreeName = found.worktreeName;
      worktreePath = found.path;
      patchesCache = null;
      cachedHeadHash = null;
      res.json({ ok: true, worktreeName, worktreePath });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/filecontext?hash=<hash>&file=<path>&start=<n>&end=<n>
  // Returns lines from the new version of a file at the given commit.
  app.get('/api/filecontext', (req, res) => {
    const { hash, file, start, end } = req.query;
    const hashRe = /^[0-9a-f]{4,40}$/i;
    if (!hash || !hashRe.test(hash) || !file || !start || !end) {
      return res.status(400).json({ error: 'Invalid parameters.' });
    }
    const startLine = parseInt(start, 10);
    const endLine   = parseInt(end,   10);
    if (isNaN(startLine) || isNaN(endLine) || startLine < 1 || endLine < startLine) {
      return res.status(400).json({ error: 'Invalid line range.' });
    }
    try {
      const result = getFileLines(worktreePath, hash, file, startLine, endLine);
      res.json(result);
    } catch (err) {
      res.status(404).json({ error: `Could not read file: ${err.message}` });
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

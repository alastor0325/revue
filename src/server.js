'use strict';

const SERVER_START = String(Date.now()); // unique token per process — used for browser auto-reload

const express = require('express');
const path = require('path');
const net = require('net');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const { getHeadHash, getMergeBase, getDiffPerCommit, getDiffForCommit, getDiffBetweenCommits, getFileLines, discoverWorktrees } = require('./git');
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
  // Default 100 KB cap is too small once a worktree accumulates several
  // revisions: each revision carries a `diffFingerprint` per patch, so a
  // dozen patches × a handful of revisions easily exceeds the default and
  // returns 413 on POST /api/state/revisions or the bulk reset.
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Active worktree — mutable so /api/switch can change them at runtime
  let worktreeName = initialWorktreeName;
  let worktreePath = initialWorktreePath;

  // Parsed patches, cached per worktree and invalidated automatically when that
  // worktree's HEAD changes.  Keyed by worktree path so switching away and back
  // to a large worktree doesn't recompute its (expensive) diff — the second
  // visit is served from cache.  patchesCache mirrors the active worktree's
  // entry so the existing callers stay simple.
  let patchesCache = null;
  const diffCache = new Map(); // worktreePath -> { headHash, patches }
  const DIFF_CACHE_MAX = 8;    // bound memory: revue is a long-lived daemon and
                               // each worktree's parsed diff can be several MB

  // ── Per-worktree async mutex ─────────────────────────────────────────────
  // Serialises read-modify-write on the state file so the bulk POST and
  // the delta endpoints cannot interleave within one process.  Keyed by the
  // resolved state-file path so /api/switch starts a fresh lock chain.
  const locks = new Map();
  function withStateLock(statePath, fn) {
    const prev = locks.get(statePath) || Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(statePath, next);
    // Drop slot when settled if no one queued behind us.  .then (not .finally)
    // so the cleanup branch doesn't fork an orphan promise on rejection.
    const cleanup = () => { if (locks.get(statePath) === next) locks.delete(statePath); };
    next.then(cleanup, cleanup);
    return next;
  }

  function readStateFile(statePath) {
    migrateLegacyState();
    if (!fs.existsSync(statePath)) return {};
    try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
    catch { return {}; }
  }

  // Write JSON to a temp file then rename, so a crashed write never leaves a
  // half-file that the next reader would treat as empty.  The temp name is
  // unique per write (pid + counter): withStateLock serialises writes within
  // one process, but a second revue process for the same worktree (e.g. a brief
  // overlap during `--restart`) would otherwise share a fixed `.tmp` path and
  // could interleave into a corrupt file.
  let tmpWriteCounter = 0;
  function atomicWriteStateFile(statePath, obj) {
    const tmp = `${statePath}.${process.pid}.${tmpWriteCounter++}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, statePath);
  }

  // Persisted review state lives in the worktree's own git directory
  // (`.git/worktrees/<name>` for a linked worktree, `<repo>/.git` for the main
  // repo) rather than in the working tree.  Inside .git it never shows up in
  // `git status` — so it can't be mistaken for a stray artifact and deleted —
  // and `git worktree remove` cleans it up automatically (no separate GC).
  // Cached per worktree path to avoid a git spawn on every state access; a
  // worktree switch uses a different path key, so the cache stays correct.
  const gitDirCache = new Map();
  function stateDir() {
    let dir = gitDirCache.get(worktreePath);
    if (dir) return dir;
    try {
      dir = execSync(`git -C "${worktreePath}" rev-parse --absolute-git-dir`, { encoding: 'utf8' }).trim();
    } catch {
      dir = worktreePath; // non-git path: fall back to keeping state alongside it
    }
    gitDirCache.set(worktreePath, dir);
    return dir;
  }

  function stateFilePath() {
    return path.join(stateDir(), 'revue-state.json');
  }

  // The pre-git-dir location: an in-worktree REVIEW_STATE_<name>.json file.
  function legacyStateFilePath() {
    return path.join(worktreePath, `REVIEW_STATE_${worktreeName}.json`);
  }

  // One-time relocation of a legacy in-worktree state file into the git dir.
  // The file is moved as-is (even if corrupt) so the unreadable-file protection
  // still applies at the new location and no saved approvals are dropped.
  function migrateLegacyState() {
    const newPath = stateFilePath();
    if (fs.existsSync(newPath)) return;
    const legacy = legacyStateFilePath();
    if (!fs.existsSync(legacy)) return;
    try {
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      fs.renameSync(legacy, newPath);
    } catch {
      // e.g. cross-device rename — fall back to copy + unlink.
      try { fs.copyFileSync(legacy, newPath); fs.unlinkSync(legacy); }
      catch { /* leave the legacy file in place; nothing is lost */ }
    }
  }

  // Loads (or reuses cached) patches for the current worktree and returns the
  // HEAD hash they were computed at — the client uses it as the baseline for
  // its update-detection poll so the baseline is scoped to the loaded worktree.
  function loadData() {
    const currentHead = getHeadHash(worktreePath);
    // The patch series is base..HEAD, so the cache must track the resolved base
    // too: origin/main or @{u} can move (a fetch, a rebase) while HEAD is
    // unchanged, which shifts the merge-base and changes the series. Keying only
    // on HEAD would then keep serving a stale, truncated patch list. getMergeBase
    // can throw (no base / base too far); treat that as a null base here and let
    // getDiffPerCommit below handle or propagate it as it already does.
    let currentBase = null;
    try { currentBase = getMergeBase(worktreePath, mainRepoPath); } catch { /* unresolved base */ }
    const cached = diffCache.get(worktreePath);
    if (cached && cached.headHash === currentHead && cached.baseHash === currentBase) {
      patchesCache = cached.patches;
      diffCache.delete(worktreePath);                 // re-insert as most-recently-used
      diffCache.set(worktreePath, cached);
      return currentHead;
    }
    console.log('Computing git diff...');
    try {
      patchesCache = getDiffPerCommit(worktreePath, mainRepoPath);
      diffCache.set(worktreePath, { headHash: currentHead, baseHash: currentBase, patches: patchesCache });
      // Evict the least-recently-used worktree once over the cap.
      while (diffCache.size > DIFF_CACHE_MAX) diffCache.delete(diffCache.keys().next().value);
      const totalFiles = patchesCache.reduce((n, p) => n + p.files.length, 0);
      console.log(
        `Found ${patchesCache.length} patch(es), ${totalFiles} changed file(s) total.`
      );
      return currentHead;
    } catch (err) {
      console.error('Error computing diff:', err.message);
      throw err;
    }
  }

  // GET /api/diff — return patches (one per commit) and metadata
  app.get('/api/diff', (req, res) => {
    try {
      const headHash = loadData();
      res.json({
        repoName: path.basename(mainRepoPath),
        worktreeName,
        worktreePath,
        headHash,
        patches: patchesCache,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/state — load persisted review state, including existing prompt if available.
  // Distinguishes "no state file yet" (a clean empty start) from "a state file
  // exists but can't be parsed" (corruption). In the latter case it returns
  // `unreadable: true` so the client refuses to overwrite the file with a fresh
  // baseline — which would turn a recoverable corrupt file into permanent loss
  // of the reviewer's approvals.
  app.get('/api/state', (req, res) => {
    migrateLegacyState();
    const statePath = stateFilePath();
    const mdPath = path.join(worktreePath, `REVIEW_FEEDBACK_${worktreeName}.md`);

    let prompt = null;
    try { prompt = fs.readFileSync(mdPath, 'utf8'); } catch { /* prompt is best-effort */ }

    // existsSync (not a read+catch) is deliberate: only a genuinely absent file
    // is a clean empty start. A read error on an existing file (corruption,
    // permissions) must fall through to `unreadable` so the client won't
    // overwrite recoverable data.
    if (!fs.existsSync(statePath)) {
      return res.json({ prompt });
    }
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      res.json({ ...state, prompt });
    } catch {
      res.json({ unreadable: true, prompt });
    }
  });

  // POST /api/state — bulk write: full replace of the state file.
  // Kept for the submit/reset-on-clear flow.  Goes through the same lock and
  // atomic writer as the delta endpoints so the two paths cannot race.
  app.post('/api/state', async (req, res) => {
    const statePath = stateFilePath();
    try {
      // Relocate any legacy in-worktree file first: this full-replace write
      // doesn't go through readStateFile, so without this a bulk write landing
      // before the first read would orphan the legacy file (and its approvals).
      await withStateLock(statePath, () => { migrateLegacyState(); atomicWriteStateFile(statePath, req.body); });
      publishStateEvent({ kind: 'bulk' }, req);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── State event subscribers (SSE) ────────────────────────────────────────
  // Long-lived /api/state/events streams.  Each subscriber records the
  // worktree it connected for; on /api/switch we silently stop delivering
  // events to the now-stale subscriber, relying on the client side to close
  // and reopen its EventSource inside the next loadAndRender (see
  // public/app.js where initStateChannel runs on every load).
  const stateSubscribers = new Set();
  let versionCounter = 0;

  function publishStateEvent(delta, req) {
    const tabId = String(req.headers['x-tab-id'] || '');
    const seq = parseInt(req.headers['x-tab-seq'], 10) || 0;
    versionCounter++;
    const payload = JSON.stringify({ ...delta, _from: tabId, _seq: seq, _version: versionCounter });
    for (const sub of stateSubscribers) {
      if (sub.worktreeName !== worktreeName) continue;
      try { sub.res.write(`data: ${payload}\n\n`); }
      catch { /* dead stream — removed on its own 'close' */ }
    }
  }

  // GET /api/state/events — SSE: live deltas for the connection's worktree.
  app.get('/api/state/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const sub = { res, worktreeName };
    stateSubscribers.add(sub);
    res.write(`data: ${JSON.stringify({ kind: 'hello', _version: versionCounter })}\n\n`);

    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* dropped */ }
    }, 15000);

    req.on('close', () => {
      stateSubscribers.delete(sub);
      clearInterval(ping);
    });
  });

  // ── Delta endpoints ──────────────────────────────────────────────────────
  // Each mutates one logical entry of the persisted state.  All run under the
  // per-worktree lock so two tabs editing different keys never clobber each
  // other (the bug the bulk POST has when full snapshots collide).

  // POST /api/state/comment — { patchHash, file, key, comment | null }
  // comment === null deletes the entry (and prunes empty parent objects so
  // GET /api/state matches the in-memory shape produced by deleteComment).
  app.post('/api/state/comment', async (req, res) => {
    const { patchHash, file, key, comment } = req.body || {};
    if (typeof patchHash !== 'string' || typeof file !== 'string' || typeof key !== 'string') {
      return res.status(400).json({ error: 'patchHash, file, key are required strings.' });
    }
    if (comment !== null && (typeof comment !== 'object' || Array.isArray(comment))) {
      return res.status(400).json({ error: 'comment must be an object or null.' });
    }
    const statePath = stateFilePath();
    try {
      await withStateLock(statePath, () => {
        const state = readStateFile(statePath);
        if (!state.comments) state.comments = {};
        if (comment === null) {
          const byFile = state.comments[patchHash];
          if (byFile && byFile[file]) {
            delete byFile[file][key];
            if (Object.keys(byFile[file]).length === 0) delete byFile[file];
            if (Object.keys(byFile).length === 0) delete state.comments[patchHash];
          }
        } else {
          if (!state.comments[patchHash]) state.comments[patchHash] = {};
          if (!state.comments[patchHash][file]) state.comments[patchHash][file] = {};
          state.comments[patchHash][file][key] = comment;
        }
        atomicWriteStateFile(statePath, state);
      });
      publishStateEvent({ kind: 'comment', patchHash, file, key, value: comment }, req);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/state/general-comment — { patchHash, text }
  // Empty string is stored as-is; callers wanting to clear can send "".
  app.post('/api/state/general-comment', async (req, res) => {
    const { patchHash, text } = req.body || {};
    if (typeof patchHash !== 'string' || typeof text !== 'string') {
      return res.status(400).json({ error: 'patchHash and text are required strings.' });
    }
    const statePath = stateFilePath();
    try {
      await withStateLock(statePath, () => {
        const state = readStateFile(statePath);
        if (!state.generalComments) state.generalComments = {};
        state.generalComments[patchHash] = text;
        atomicWriteStateFile(statePath, state);
      });
      publishStateEvent({ kind: 'general-comment', patchHash, value: text }, req);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/state/draft — { key, text | null }
  // null (or missing) deletes the draft so a future load doesn't resurrect it.
  app.post('/api/state/draft', async (req, res) => {
    const { key, text } = req.body || {};
    if (typeof key !== 'string') {
      return res.status(400).json({ error: 'key is required string.' });
    }
    if (text != null && typeof text !== 'string') {
      return res.status(400).json({ error: 'text must be a string or null.' });
    }
    const statePath = stateFilePath();
    try {
      await withStateLock(statePath, () => {
        const state = readStateFile(statePath);
        if (!state.drafts) state.drafts = {};
        if (text == null) delete state.drafts[key];
        else state.drafts[key] = text;
        atomicWriteStateFile(statePath, state);
      });
      publishStateEvent({ kind: 'draft', key, value: text }, req);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/state/revisions — { revisions, approved, denied, reapprovalNeeded? }
  // Used by the load-time revision-detection path which records a new revision
  // snapshot AND migrates approved/denied hashes for amended commits.  These
  // fields belong together so they go in one lock-protected write.
  // reapprovalNeeded is optional (older clients omit it) and stored verbatim.
  app.post('/api/state/revisions', async (req, res) => {
    const { revisions, approved, denied, reapprovalNeeded } = req.body || {};
    if (!Array.isArray(revisions) || !Array.isArray(approved) || !Array.isArray(denied)) {
      return res.status(400).json({ error: 'revisions, approved, denied must all be arrays.' });
    }
    if (reapprovalNeeded !== undefined && !Array.isArray(reapprovalNeeded)) {
      return res.status(400).json({ error: 'reapprovalNeeded must be an array when provided.' });
    }
    const statePath = stateFilePath();
    try {
      await withStateLock(statePath, () => {
        const state = readStateFile(statePath);
        state.revisions = revisions;
        state.approved = approved;
        state.denied = denied;
        if (reapprovalNeeded !== undefined) state.reapprovalNeeded = reapprovalNeeded;
        atomicWriteStateFile(statePath, state);
      });
      publishStateEvent({ kind: 'revisions' }, req);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/state/decision — { patchHash, kind: 'approve'|'unapprove'|'deny'|'undeny' }
  // Mirrors the existing state.js mutators one-to-one.
  app.post('/api/state/decision', async (req, res) => {
    const { patchHash, kind } = req.body || {};
    const validKinds = new Set(['approve', 'unapprove', 'deny', 'undeny']);
    if (typeof patchHash !== 'string' || !validKinds.has(kind)) {
      return res.status(400).json({ error: 'patchHash is required; kind must be approve|unapprove|deny|undeny.' });
    }
    const statePath = stateFilePath();
    try {
      await withStateLock(statePath, () => {
        const state = readStateFile(statePath);
        const approved = new Set(state.approved || []);
        const denied = new Set(state.denied || []);
        if (kind === 'approve')   approved.add(patchHash);
        if (kind === 'unapprove') approved.delete(patchHash);
        if (kind === 'deny')      denied.add(patchHash);
        if (kind === 'undeny')    denied.delete(patchHash);
        state.approved = [...approved];
        state.denied = [...denied];
        atomicWriteStateFile(statePath, state);
      });
      publishStateEvent({ kind: 'decision', patchHash, action: kind }, req);
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
      patchesCache = null; // repopulated from diffCache (or recomputed) on next loadData
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
    // A " in the file path breaks shell quoting in git show "${hash}:${file}".
    if (/["\n]/.test(file)) {
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
async function startServer({ worktreeName, worktreePath, mainRepoPath, pidFile, port: preferredPort = 7777, noOpen = false }) {
  const app = createApp({ worktreeName, worktreePath, mainRepoPath });
  const port = await findAvailablePort(preferredPort);

  return new Promise((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => {
      const url = `http://localhost:${port}`;
      if (pidFile) {
        try { fs.writeFileSync(pidFile, `${process.pid}:${port}`); } catch {}
      }
      if (!noOpen) openBrowser(url);
      resolve(server);
    });
  });
}

module.exports = { startServer, createApp, findAvailablePort };

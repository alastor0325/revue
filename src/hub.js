'use strict';

// One revue daemon serves every project on a single port.  Each repo is a
// createApp() instance mounted at /r/<slug>/; a later `revue --repo X` call
// registers X with the running hub (POST /api/hub/projects) instead of
// starting another daemon on the next free port.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { createApp, listen } = require('./server');
const { discoverWorktrees, getMainWorktreeBasename } = require('./git');

function buildEntries(mainRepoPath) {
  const entries = [];
  if (mainRepoPath && fs.existsSync(mainRepoPath)) {
    // Strip the repo-name prefix so a --repo that points at a sibling worktree
    // (e.g. firefox-2044124) is labelled "2044124", not "firefox-2044124".
    const prefix = getMainWorktreeBasename(mainRepoPath) + '-';
    const base = path.basename(mainRepoPath);
    entries.push({
      path: mainRepoPath,
      worktreeName: base.startsWith(prefix) ? base.slice(prefix.length) : base,
      isMain: true,
    });
    try {
      entries.push(...discoverWorktrees(mainRepoPath));
    } catch {
      // ignore
    }
  }
  return entries;
}

/**
 * Pick the default entry to open when no worktree arg is given.
 * Prefers the first registered worktree over the main repo so the user
 * sees actual patches instead of an empty "No patches found" state.
 */
function pickDefaultEntry(entries) {
  return entries.find((e) => !e.isMain) || entries[0];
}

/** Resolve a worktree name (or the default) within a repo; throws with a user-facing message. */
function resolveEntry(repoPath, worktree) {
  const entries = buildEntries(repoPath);
  if (entries.length === 0) throw new Error(`No worktrees found for repo: ${repoPath}`);
  const found = worktree ? entries.find((e) => e.worktreeName === worktree) : pickDefaultEntry(entries);
  if (!found) {
    const names = entries.map((e) => e.worktreeName).join(', ');
    throw new Error(`worktree '${worktree}' not found. Available: ${names}`);
  }
  if (!fs.existsSync(found.path)) throw new Error(`Worktree not found at ${found.path}`);
  return found;
}

/**
 * Collapse a project list to one entry per repo path, keeping the first
 * non-empty worktree seen for each.  Used on --restart so the explicitly
 * requested project stays first and the previously mounted ones follow.
 */
function mergeProjects(list) {
  const byPath = new Map();
  for (const p of list) {
    if (!p || !p.repoPath) continue;
    const prev = byPath.get(p.repoPath);
    if (!prev) byPath.set(p.repoPath, { repoPath: p.repoPath, worktree: p.worktree || null });
    else if (!prev.worktree && p.worktree) prev.worktree = p.worktree;
  }
  return [...byPath.values()];
}

// The hub routes accept or expose absolute filesystem paths, so all of them
// require a loopback Host (blocks DNS rebinding).  Cross-origin pages can't
// read the GET responses (no CORS headers), and revue's own pages send no
// Origin on same-origin GETs.  Registration is CLI-only: the POST handler
// also refuses any request carrying an Origin header, i.e. any browser page.
function isLoopbackHost(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function createHub() {
  const app = express();
  const projects = new Map(); // slug -> { slug, repoPath, app }

  function uniqueSlug(repoPath) {
    const base = path.basename(repoPath).replace(/[^A-Za-z0-9._-]/g, '-') || 'repo';
    let slug = base;
    for (let n = 2; projects.has(slug); n++) slug = `${base}-${n}`;
    return slug;
  }

  /** Mount a repo (or switch an already-mounted one to `worktree`). Returns its slug. */
  function addProject({ repoPath, worktree = null }) {
    const existing = [...projects.values()].find((p) => p.repoPath === repoPath);
    if (existing && !worktree) return existing.slug;
    const entry = resolveEntry(repoPath, worktree);
    if (existing) {
      existing.app.locals.switchWorktree(entry.worktreeName, entry.path);
      return existing.slug;
    }
    const slug = uniqueSlug(repoPath);
    const sub = createApp({ worktreeName: entry.worktreeName, worktreePath: entry.path, mainRepoPath: repoPath });
    projects.set(slug, { slug, repoPath, app: sub });
    return slug;
  }

  function listProjects() {
    return [...projects.values()].map((p) => ({
      slug: p.slug,
      repoPath: p.repoPath,
      worktree: p.app.locals.currentWorktree(),
      path: `/r/${p.slug}/`,
    }));
  }

  app.get('/api/hub/projects', (req, res) => {
    if (!isLoopbackHost(req)) return res.status(403).json({ error: 'Forbidden.' });
    res.json({ projects: listProjects() });
  });

  // Body parser scoped to this route: a hub-wide one would pre-parse every
  // project's POST with the 100 KB default and 413 large state saves.
  app.post('/api/hub/projects', express.json(), (req, res) => {
    if (!isLoopbackHost(req) || req.headers.origin) return res.status(403).json({ error: 'Forbidden.' });
    const { repoPath, worktree } = req.body || {};
    if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) {
      return res.status(400).json({ error: 'repoPath must be an absolute path.' });
    }
    if (worktree != null && typeof worktree !== 'string') {
      return res.status(400).json({ error: 'worktree must be a string.' });
    }
    try {
      const slug = addProject({ repoPath, worktree });
      res.json({ ok: true, slug, path: `/r/${slug}/` });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.use('/r/:slug', (req, res, next) => {
    const project = projects.get(req.params.slug);
    if (!project) return res.status(404).send('Unknown project. See the project list at /.');
    // The UI uses relative URLs (api/diff, app.js), so the project root must
    // end with "/" or they would resolve against /r/ instead of /r/<slug>/.
    if (req.path === '/') {
      const [pathname, query] = req.originalUrl.split('?');
      if (!pathname.endsWith('/')) return res.redirect(301, `${pathname}/${query != null ? `?${query}` : ''}`);
    }
    project.app(req, res, next);
  });

  // Dashboard: every mounted project, always shown (even with just one) so
  // there is one place to see and switch between everything on this port.
  app.get('/', (req, res) => {
    if (!isLoopbackHost(req)) return res.status(403).send('Forbidden.');
    const list = listProjects();
    const cards = list.map((p) => `
      <li class="project-card">
        <a class="project-name" href="${escapeHtml(p.path)}">${escapeHtml(p.slug)}</a>
        <span class="project-worktree" title="Current worktree">${escapeHtml(p.worktree)}</span>
        <code class="project-path">${escapeHtml(p.repoPath)}</code>
      </li>`).join('');
    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Revue — projects</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div id="header">
  <div id="header-left">
    <h1><a href="https://github.com/alastor0325/revue" target="_blank" class="app-name">Revue</a> <span id="bug-id-display">Projects</span></h1>
    <div id="worktree-path">${list.length} project${list.length === 1 ? '' : 's'} on this port</div>
  </div>
</div>
<main class="dashboard-main">
${list.length ? `<ul id="projects">${cards}
</ul>` : '<p class="dashboard-empty">No projects yet.</p>'}
<p class="dashboard-hint">Add a project: <code>revue --repo &lt;path&gt;</code></p>
</main>
</body>
</html>`);
  });

  const publicFile = (name) => (req, res) => res.sendFile(path.join(__dirname, '..', 'public', name));
  app.get('/favicon.svg', publicFile('favicon.svg'));
  app.get('/style.css', publicFile('style.css'));

  return { app, addProject, listProjects };
}

/**
 * Start the hub daemon with the given projects. The first project is the one
 * opened in the browser.  The CLI validates the user's own repo/worktree before
 * forking, so a failure here comes from state a --restart captured that has
 * since gone stale: a vanished worktree falls back to the repo's default one,
 * and a vanished repo after the first is skipped.
 */
async function startHub({ projects, port: preferredPort = 7777, pidFile, noOpen = false }) {
  const hub = createHub();
  const add = (p) => {
    try { return hub.addProject(p); } catch (err) {
      if (!p.worktree) throw err;
      console.error(`${p.repoPath}: ${err.message}; opening the default worktree.`);
      return hub.addProject({ repoPath: p.repoPath });
    }
  };
  const [primary, ...rest] = mergeProjects(projects);
  const primarySlug = add(primary);
  for (const p of rest) {
    try { add(p); } catch (err) { console.error(`Skipping ${p.repoPath}: ${err.message}`); }
  }
  const { server, port } = await listen(hub.app, { port: preferredPort, pidFile, noOpen, openPath: `/r/${primarySlug}/` });
  return { server, hub, port };
}

module.exports = {
  createHub, startHub, mergeProjects, resolveEntry, buildEntries, pickDefaultEntry, isLoopbackHost,
};

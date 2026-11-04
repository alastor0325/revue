'use strict';

// Rendered ("rich") views of documentation files at a commit, for the
// Source | Rendered toggle: Markdown via `marked`, Bikeshed specs (.bs) via
// the locally installed `bikeshed`.  Everything runs asynchronously — one
// revue daemon serves every project, so a slow render must not block the
// others — and results are cached.

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { marked } = require('marked');

const run = (cmd, args, opts = {}) =>
  execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', ...opts }).then((r) => r.stdout);
const succeeds = (p) => p.then(() => true, () => false);

let bikeshedAvailable = null; // memoised promise
function hasBikeshed() {
  if (!bikeshedAvailable) bikeshedAvailable = succeeds(run('bikeshed', ['--version']));
  return bikeshedAvailable;
}

/**
 * The rendered format available for a file: 'markdown', 'bikeshed' (only
 * when bikeshed is installed), or null.  The diff API tags each file with it,
 * so the client shows the Source | Rendered toggle exactly when it works.
 */
async function renderFormat(filePath) {
  if (/\.(md|markdown)$/i.test(filePath)) return 'markdown';
  if (/\.bs$/i.test(filePath) && (await hasBikeshed())) return 'bikeshed';
  return null;
}

/** Set `richFormat` on each file of a diff payload (see renderFormat). */
async function tagRenderableFiles(files) {
  await Promise.all(files.map(async (f) => { f.richFormat = await renderFormat(f.newPath || f.oldPath || ''); }));
  return files;
}

/** Full commit sha for `rev`, or null when it doesn't exist (e.g. the parent of a root commit). */
function resolveCommit(repo, rev) {
  return run('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
    .then((out) => out.trim(), () => null);
}

// A standalone page for rendered Markdown, styled to sit inside the app's
// dark UI.  It is shown in a sandboxed iframe (no scripts), so the HTML that
// `marked` passes through from the source can't run anything.
function markdownPage(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 24px 32px; background: #0b0d10; color: #e7ebef;
    font: 15px/1.6 -apple-system, "Segoe UI", system-ui, sans-serif; max-width: 920px; }
  h1, h2 { border-bottom: 1px solid #232831; padding-bottom: .3em; }
  h1, h2, h3, h4 { line-height: 1.25; margin: 1.5em 0 .6em; }
  a { color: #58a6ff; }
  code, pre { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-size: 13px; }
  code { background: rgba(255,255,255,.08); padding: .15em .35em; border-radius: 4px; }
  pre { background: #13161b; padding: 12px 16px; border-radius: 6px; overflow: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 0; padding: 0 1em; color: #b9c1cc; border-left: 4px solid #363c46; }
  table { border-collapse: collapse; } th, td { border: 1px solid #363c46; padding: 6px 12px; }
  img { max-width: 100%; } hr { border: 0; border-top: 1px solid #363c46; }
</style></head><body>${body}</body></html>`;
}

// null when the file doesn't exist at that commit.
async function renderMarkdown(repo, sha, filePath) {
  let source;
  try { source = await run('git', ['-C', repo, 'show', `${sha}:${filePath}`]); } catch { return null; }
  return markdownPage(marked.parse(source));
}

// Bikeshed resolves includes and local data files relative to the spec, so
// extract the spec's whole directory at that commit and render it there.
// --allow-execute / --allow-nonlocal-files stay off: repo content can't run
// code or read files outside its own directory.
async function renderBikeshed(repo, sha, filePath) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'revue-bs-'));
  try {
    const tarPath = path.join(tmp, 'src.tar');
    try {
      await run('git', ['-C', repo, 'archive', '-o', tarPath, sha, '--', path.posix.dirname(filePath)]);
    } catch { return null; }
    // -m: don't restore mtimes.  Bikeshed dates an Editor's Draft from the
    // file's mtime, which git archive sets to the commit time — so the old and
    // new renders would differ in their date line on every diff.
    await run('tar', ['-xmf', tarPath, '-C', tmp]);
    const input = path.join(tmp, filePath);
    if (!(await succeeds(fs.access(input)))) return null;
    const out = path.join(tmp, 'revue-rendered.html');
    await run('bikeshed', ['--no-update', '--silent', '--die-on=nothing', 'spec', input, out],
      { cwd: path.dirname(input), timeout: 120000 });
    return await fs.readFile(out, 'utf8');
  } finally {
    fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Results by request.  Commits never change, but a Bikeshed render carries the
// day it was made (the Editor's Draft date), so its key includes today's date:
// both sides of a diff are then always rendered on the same day.
const cache = new Map(); // key -> Promise<{ format, old, new }>
const CACHE_MAX = 16;    // a rendered spec pair is ~1 MB

/**
 * Render `filePath` as of commit `hash` and of its parent (`oldPath` there,
 * for renames).  Resolves to { format, old, new } where old/new are HTML
 * pages, or null when the file doesn't exist on that side (added / deleted
 * file).  Rejects with `status` 415 when the file has no rendered view and
 * 404 when the commit doesn't exist.
 */
function renderFileVersions(repo, hash, filePath, oldPath = filePath) {
  const today = new Date().toISOString().slice(0, 10);
  const key = [repo, hash, filePath, oldPath, /\.bs$/i.test(filePath) ? today : ''].join('\0');
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key); cache.set(key, hit); // most recently used
    return hit;
  }
  const p = (async () => {
    const format = await renderFormat(filePath);
    if (!format) throw Object.assign(new Error(`No rendered view for ${filePath}.`), { status: 415 });
    const sha = await resolveCommit(repo, hash);
    if (!sha) throw Object.assign(new Error(`Commit ${hash} not found.`), { status: 404 });
    const parent = await resolveCommit(repo, `${sha}^`);
    const render = format === 'bikeshed' ? renderBikeshed : renderMarkdown;
    const [oldHtml, newHtml] = await Promise.all([
      parent ? render(repo, parent, oldPath) : null,
      render(repo, sha, filePath),
    ]);
    return { format, old: oldHtml, new: newHtml };
  })();
  cache.set(key, p);
  p.catch(() => cache.delete(key)); // don't cache failures
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return p;
}

module.exports = { renderFileVersions, tagRenderableFiles };

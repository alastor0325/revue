// View layout that survives a reload.  Two kinds:
//
// * Preferences, per browser (localStorage): whether the file sidebar is
//   collapsed, which files show the Rendered view (by path, so the choice
//   outlives amended commits), and which file blocks are collapsed (by commit
//   and path, so collapsing a file in one patch can't hide its changes in
//   another).
// * Where this tab is, per tab (sessionStorage): the open patch, the revision
//   or comparison shown for each patch, and the scroll position.  Two tabs on
//   the same worktree can be on different patches; a reload restores its own.
//
// Every hub project is served from one origin, so each project page
// (location.pathname, /r/<project>/) gets its own storage key; within it,
// records are per worktree.  The records are read once and kept in memory:
// lookups run for every file of every render.

const MAX_PATHS = 500;     // per list, oldest dropped first
const MAX_WORKTREES = 50;  // per project, least recently used dropped first

const prefsKey = () => `revue-layout:${location.pathname}`;
const tabKey = () => `revue-tab:${location.pathname}`;

function load(storage, key) {
  try { return JSON.parse(storage.getItem(key)) || {}; } catch { return {}; }
}
function save(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); } catch { /* storage full or disabled */ }
}

let prefs = null;       // { sidebarCollapsed, worktrees: { [name]: { rendered: [], collapsed: [], used } } }
let tab = null;         // { [worktree]: { patch: { hash, idx }, showRevision, compareRevision, scrollY } }
let worktree = '';
let rendered = new Set();
let collapsed = new Set();

function ensureLoaded() {
  if (prefs) return;
  prefs = load(localStorage, prefsKey());
  tab = load(sessionStorage, tabKey());
}

function wtPrefs() {
  ensureLoaded();
  const wts = prefs.worktrees || (prefs.worktrees = {});
  return wts[worktree] || (wts[worktree] = {});
}
function wtTab() {
  ensureLoaded();
  return tab[worktree] || (tab[worktree] = {});
}

function savePrefs() {
  const wts = prefs.worktrees || {};
  const names = Object.keys(wts);
  if (names.length > MAX_WORKTREES) {
    names.sort((a, b) => (wts[a].used || 0) - (wts[b].used || 0))
      .slice(0, names.length - MAX_WORKTREES).forEach((n) => delete wts[n]);
  }
  save(localStorage, prefsKey(), prefs);
}
const saveTab = () => save(sessionStorage, tabKey(), tab);

/** Select the worktree whose layout the accessors below read and write. */
export function setLayoutWorktree(name) {
  ensureLoaded();
  worktree = name || '';
  const wt = wtPrefs();
  wt.used = Date.now();
  rendered = new Set(wt.rendered || []);
  collapsed = new Set(wt.collapsed || []);
  savePrefs();
}

/** Forget the in-memory copy (tests switch location and storage between cases). */
export function resetLayoutCache() { prefs = tab = null; worktree = ''; rendered = new Set(); collapsed = new Set(); }

export function getSidebarCollapsed() { ensureLoaded(); return !!prefs.sidebarCollapsed; }
export function setSidebarCollapsed(on) { ensureLoaded(); prefs.sidebarCollapsed = !!on; savePrefs(); }

function setMember(set, list, key, on) {
  if (set.has(key) === !!on) return; // unchanged: no write
  if (on) set.add(key); else set.delete(key);
  wtPrefs()[list] = [...set].slice(-MAX_PATHS);
  savePrefs();
}

/** Rendered view, by file path. */
export function isRenderedView(path) { return rendered.has(path); }
export function setRenderedView(path, on) { setMember(rendered, 'rendered', path, on); }

/** Collapsed file block, by `${commit}:${path}`. */
export function isFileCollapsed(key) { return collapsed.has(key); }
export function setFileCollapsed(key, on) { setMember(collapsed, 'collapsed', key, on); }

/**
 * Index of the patch tab to open: the saved patch's hash if it is still in
 * `patches`, else its saved position (its commit was amended or rebased),
 * else 0.
 */
export function savedPatchIndex(patches) {
  const saved = wtTab().patch;
  if (!saved || patches.length === 0) return 0;
  const byHash = patches.findIndex((p) => p.hash === saved.hash);
  if (byHash >= 0) return byHash;
  return saved.idx < patches.length ? saved.idx : 0;
}
export function savePatch(hash, idx) {
  const t = wtTab();
  if (t.patch && t.patch.hash === hash && t.patch.idx === idx) return;
  t.patch = { hash, idx };
  saveTab();
}

/** The revision shown / revisions compared per patch index (state.showRevision / compareRevision). */
export function savedRevisionView() {
  const t = wtTab();
  return { showRevision: t.showRevision || {}, compareRevision: t.compareRevision || {} };
}
export function saveRevisionView(showRevision, compareRevision) {
  const t = wtTab();
  t.showRevision = showRevision;
  t.compareRevision = compareRevision;
  saveTab();
}

export function savedScroll() { return wtTab().scrollY || 0; }
export function saveScroll(y) { wtTab().scrollY = y; saveTab(); }

if (typeof module !== 'undefined') {
  module.exports = {
    setLayoutWorktree, resetLayoutCache, getSidebarCollapsed, setSidebarCollapsed,
    isRenderedView, setRenderedView, isFileCollapsed, setFileCollapsed,
    savedPatchIndex, savePatch, savedRevisionView, saveRevisionView, savedScroll, saveScroll,
  };
}

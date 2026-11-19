// State: direct access for orchestration
import {
  state, drafts, draftKey, resetReviewState, replaceDrafts,
  commentsForPatch, getGeneralComment, getComment,
  setComment, deleteComment, setGeneralComment,
  approvePatch, unapprovePatch, denyPatch, undenyPatch,
  COMMIT_FILE, COMMIT_KEY,
} from './state.js';
// Persistence: save/restore + prompt bar
import {
  flushSave, saveStateBulk, cancelPendingSaves,
  updateCurrentPrompt, refreshPromptBar, setSavedPromptText,
  initStateChannel, hasPendingSave, maybeCatchupOnVisible,
} from './persistence.js';
// Revisions: detect changes on load
import { diffFingerprint, migrateApprovals, detectRevisionChanges, getRevisionList } from './revisions.js';
import { loadHighlighter } from './highlight.js';
import { searchWorktrees, markHtml } from './worktreesearch.js';
import { setLayoutWorktree, savedPatchIndex, savedRevisionView, savedScroll, saveScroll } from './layout.js';

// Restore this tab's revision / compare choices if those revisions still exist.
function restoreRevisionView() {
  const { showRevision, compareRevision } = savedRevisionView();
  const has = (idx, hash) => getRevisionList(Number(idx)).some((r) => r.hash === hash);
  for (const [idx, hash] of Object.entries(showRevision)) if (hash && has(idx, hash)) state.showRevision[idx] = hash;
  for (const [idx, c] of Object.entries(compareRevision)) {
    if (c && has(idx, c.from) && has(idx, c.to)) state.compareRevision[idx] = c;
  }
}

// The scroll position is restored on the first load only (not on a worktree
// switch or a reload button), and saved whenever the page is hidden or left.
let scrollRestored = false;

// Resolves once the syntax highlighter has loaded (or failed to).  Already
// resolved when init() didn't run (unit tests import the module directly).
let highlighterReady = Promise.resolve();
// Renderer: all DOM functions + re-exportable items for tests
import {
  patchEls, updateSubmitButton, removeExistingForm, showCommentForm,
  renderDraftDisplay, renderCommentDisplay, renderCommitMessageSection,
  restoreLineDisplay,
  renderFileNav, renderFile, navigateFile,
  renderTabs, switchPatch, buildPatchEl, renderCurrentPatch, initPatchNodes,
  addDragScroll, initTabsDragScroll,
  setupStickySidebarOffset, formatPatchDate,
} from './renderer.js';

// ── DOM helpers ────────────────────────────────────────────────────────────
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return [...(root || document).querySelectorAll(sel)]; }

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let _pollTimer = null;

// ── Submit review ──────────────────────────────────────────────────────────
async function submitReview() {
  const allFeedback = state.patches.map((p) => ({
    hash: p.hash,
    comments: commentsForPatch(p.hash),
    generalComment: getGeneralComment(p.hash).trim(),
  }));

  const btn = $('#btn-submit');
  btn.disabled = true;
  btn.textContent = 'Generating…';

  let submitError = null;
  try {
    const res = await fetch('api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allFeedback,
        approvedHashes: [...state.approved],
        deniedHashes:   [...state.denied],
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Server error');

    $('#result-feedback-path').textContent = json.feedbackPath;
    $('#result-prompt').value = json.prompt;
    $('#result-overlay').classList.add('visible');
    updateCurrentPrompt(json.prompt);

    navigator.clipboard.writeText(json.prompt).then(() => {
      const copyBtn = $('#btn-copy-prompt');
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy prompt'; }, 2000);
    }).catch(() => {});  // silently ignore if clipboard access is denied

    // Refresh must preserve drafts; only "Generate Review Prompt" clears them.
    state.comments = {};
    state.generalComments = {};
    state.denied = new Set();
    replaceDrafts(null);
    // Cancel any in-flight debounced saves first — otherwise a pending draft
    // POST would land after the bulk reset and re-create the cleared value.
    cancelPendingSaves();
    await saveStateBulk({
      comments: state.comments,
      generalComments: state.generalComments,
      approved: [...state.approved],
      denied: [...state.denied],
      // Preserve across the full-replace write: a changed-since-approved patch
      // still needs re-review after generating the prompt.
      reapprovalNeeded: [...state.reapprovalNeeded],
      revisions: state.revisions,
      drafts,
    });

    renderTabs();
    initPatchNodes();
  } catch (err) {
    submitError = err.message;
  } finally {
    btn.textContent = 'Generate Review Prompt';
    updateSubmitButton();
    // Set error AFTER updateSubmitButton so it is not cleared when hasActivity is true
    if (submitError) {
      const warn = $('#submit-warning');
      if (warn) warn.textContent = `Error: ${submitError}`;
    }
  }
}

// ── Worktree switcher ──────────────────────────────────────────────────────
// One row: the worktrees matching the search box on the left, best match
// first (all of them for an empty query, the current one first, then the
// server's order), and the box on the right.  Pills that don't fit are listed
// under "+N".  In the box, ↑/↓ move the highlight, Enter switches to it, Esc
// clears the query and then leaves the box; "/" anywhere else focuses it.
const wtBar = {
  worktrees: [],
  current: null,
  active: -1,      // index of the highlighted option (Enter switches to it)
  width: 0,        // the row's width at the last render
  switching: false,
};
let wtStatusTimer = null;

// The server-side switch; true when it worked.
async function postSwitch(name) {
  const r = await fetch('api/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ worktreeName: name }),
  });
  return r.ok;
}

// { current, worktrees } from the server, or null.
async function fetchWorktrees() {
  const res = await fetch('api/worktrees');
  return res.ok ? res.json() : null;
}

function worktreeOptionHtml({ wt, field, marks }, i) {
  const name = wt.worktreeName;
  const cls = `worktree-pill${name === wtBar.current ? ' active' : ''}`;
  // In the row the branch shows only when the query matched it; the "+N"
  // list has room for it always (style.css); it is always the tooltip.
  const label = field === 'branch'
    ? `${escapeHtml(name)}<span class="worktree-pill-branch"> · ${markHtml(wt.branch, marks, escapeHtml)}</span>`
    : markHtml(name, marks, escapeHtml)
      + (wt.branch ? `<span class="worktree-pill-branch worktree-pill-branch-extra"> · ${escapeHtml(wt.branch)}</span>` : '');
  const title = wt.branch ? ` title="${escapeHtml(wt.branch)}"` : '';
  return `<button type="button" class="${cls}" role="option" tabindex="-1" id="wt-opt-${i}" aria-selected="false" data-name="${escapeHtml(name)}"${title}>${label}</button>`;
}

// Draw the results for the query: pills in the row as far as they fit, the
// rest in the "+N" list.  The highlight goes to the best match, or with
// `keepHighlight` (the list or the width changed, not the query) stays on
// the worktree it was on.
function renderWorktreeResults({ keepHighlight = false } = {}) {
  const pills = $('#worktree-pills');
  const more = $('#worktree-more');
  const list = $('#worktree-more-list');
  const query = $('#worktree-search').value.trim();
  const kept = keepHighlight ? worktreeOptions()[wtBar.active]?.dataset.name : null;
  let results = searchWorktrees(wtBar.worktrees, query);
  if (!query) {
    const cur = results.findIndex((r) => r.wt.worktreeName === wtBar.current);
    if (cur > 0) results = [results[cur], ...results.slice(0, cur), ...results.slice(cur + 1)];
  }

  list.innerHTML = '';
  more.hidden = true;
  if (results.length === 0) {
    pills.innerHTML = `<span class="worktree-empty">No worktree matches “${escapeHtml(query)}”</span>`;
  } else {
    pills.innerHTML = results.map(worktreeOptionHtml).join('');
    // Without layout (hidden bar, tests) every pill counts as fitting.
    const fit = () => {
      const width = pills.clientWidth;
      const all = [...pills.children];
      const n = all.findIndex((el) => el.offsetLeft + el.offsetWidth > width);
      return width > 0 && n >= 0 ? Math.max(n, 1) : all.length;
    };
    const label = (shown) => { more.textContent = `+${results.length - shown} ▾`; };
    let shown = fit();
    if (shown < results.length) {
      more.hidden = false; // takes room from the row, so measure again
      label(shown);
      shown = fit();
      label(shown);
      more.setAttribute('aria-label', `${results.length - shown} more worktrees`);
      for (const el of [...pills.children].slice(shown)) list.appendChild(el);
    }
  }
  wtBar.width = pills.clientWidth;

  const names = results.map((r) => r.wt.worktreeName);
  if (kept && names.includes(kept)) wtBar.active = names.indexOf(kept);
  // For an empty query the current worktree is first: Enter goes to the next.
  else if (!query) wtBar.active = names.findIndex((n) => n !== wtBar.current);
  else wtBar.active = results.length ? 0 : -1;
  setWorktreeListOpen(false);
  updateWorktreeHighlight();

  // Announce the count once typing pauses, not on every keystroke.
  clearTimeout(wtStatusTimer);
  if (query && !keepHighlight) {
    wtStatusTimer = setTimeout(() => {
      const n = results.length;
      $('#worktree-search-status').textContent = `${n} worktree${n === 1 ? '' : 's'} match`;
    }, 400);
  }
}

function worktreeOptions() {
  return [...$('#worktree-pills').querySelectorAll('.worktree-pill'), ...$('#worktree-more-list').children];
}

function setWorktreeListOpen(open) {
  const more = $('#worktree-more');
  const list = $('#worktree-more-list');
  list.hidden = !open || more.hidden;
  more.setAttribute('aria-expanded', String(!list.hidden));
}

function updateWorktreeHighlight() {
  const input = $('#worktree-search');
  const options = worktreeOptions();
  options.forEach((el, i) => {
    el.classList.toggle('highlighted', i === wtBar.active);
    el.setAttribute('aria-selected', String(i === wtBar.active));
  });
  const el = options[wtBar.active];
  if (el) input.setAttribute('aria-activedescendant', el.id);
  else input.removeAttribute('aria-activedescendant');
  if (el && el.parentElement.id === 'worktree-more-list') {
    setWorktreeListOpen(true);
    el.scrollIntoView?.({ block: 'nearest' });
  }
}

// Switch the server to worktree `name` and reload the page's data.
async function switchWorktree(name) {
  if (wtBar.switching || name === wtBar.current) return;
  wtBar.switching = true;
  const busy = worktreeOptions().filter((el) => el.dataset.name === name);
  busy.forEach((el) => { el.classList.add('switching'); el.setAttribute('aria-busy', 'true'); });
  try {
    if (!(await postSwitch(name))) throw new Error('Switch failed');
    wtBar.current = name;
    history.replaceState(null, '', '#' + name);
    // Done searching: clear the box and leave it, so the arrow keys go back
    // to patch and file navigation.
    const input = $('#worktree-search');
    input.value = '';
    input.blur();
    renderWorktreeResults();
    await loadAndRender();
  } catch {
    busy.forEach((el) => { el.classList.remove('switching'); el.removeAttribute('aria-busy'); });
  } finally {
    wtBar.switching = false;
  }
}

function onWorktreeSearchKey(e) {
  const options = worktreeOptions();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (options.length === 0) return;
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    wtBar.active = wtBar.active < 0 ? 0 : Math.max(0, Math.min(options.length - 1, wtBar.active + dir));
    updateWorktreeHighlight();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const el = options[wtBar.active];
    if (el) switchWorktree(el.dataset.name);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (e.target.value) { e.target.value = ''; renderWorktreeResults(); }
    else e.target.blur();
  }
}

// "/" focuses the search box (it replaces Firefox's Quick Find on this page).
function onSlashKey(e) {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || shortcutsPaused(e)) return;
  if ($('#worktree-bar').style.display === 'none') return;
  e.preventDefault();
  $('#worktree-search').focus();
}

function onDocumentClick(e) {
  if (e.target.closest('#worktree-more, #worktree-more-list')) return;
  setWorktreeListOpen(false);
}

// A worktree made after the page loaded shows up when the box is focused.
// The bar is redrawn only if the list changed, so the highlight stays put.
async function refreshWorktreeList() {
  try {
    const data = await fetchWorktrees();
    const worktrees = data?.worktrees;
    if (!Array.isArray(worktrees) || !worktrees.length) return;
    const key = (list) => JSON.stringify(list.map((wt) => [wt.worktreeName, wt.branch]));
    if (key(worktrees) === key(wtBar.worktrees)) return;
    wtBar.worktrees = worktrees;
    renderWorktreeResults({ keepHighlight: true });
  } catch { /* keep the list we have */ }
}

// Redraw when the row's width changes (how many pills fit), not on every resize.
let wtResizeFrame = 0;
function onWindowResize() {
  cancelAnimationFrame(wtResizeFrame);
  wtResizeFrame = requestAnimationFrame(() => {
    const pills = $('#worktree-pills');
    if (pills && pills.clientWidth !== wtBar.width) renderWorktreeResults({ keepHighlight: true });
  });
}

// A hash change after load (e.g. the user edits the address bar) switches.
function onWorktreeHashChange() {
  const name = window.location.hash.slice(1);
  if (name && wtBar.worktrees.some((wt) => wt.worktreeName === name)) return switchWorktree(name);
}

async function initWorktreeBar() {
  try {
    const data = await fetchWorktrees();
    if (!data) return;
    let { current, worktrees } = data;
    if (worktrees.length <= 1) return; // nothing to switch to

    // ── Hash navigation: switch to worktree named in URL hash on load ──
    // (init() renders right after, so this needs only the server's switch.)
    const hashName = window.location.hash.slice(1);
    if (hashName && hashName !== current && worktrees.some((wt) => wt.worktreeName === hashName)) {
      if (await postSwitch(hashName)) current = hashName;
    }

    // Keep URL hash in sync with active worktree
    history.replaceState(null, '', '#' + current);

    Object.assign(wtBar, { worktrees, current });
    $('#worktree-bar').style.display = '';
    renderWorktreeResults();

    const input = $('#worktree-search');
    input.addEventListener('input', () => renderWorktreeResults());
    input.addEventListener('keydown', onWorktreeSearchKey);
    input.addEventListener('focus', refreshWorktreeList);
    const onPick = (e) => {
      const btn = e.target.closest('.worktree-pill');
      if (btn) switchWorktree(btn.dataset.name);
    };
    $('#worktree-pills').addEventListener('click', onPick);
    $('#worktree-more-list').addEventListener('click', onPick);
    $('#worktree-more').addEventListener('click', () => setWorktreeListOpen($('#worktree-more-list').hidden));

    // Window and document handlers read the bar from the DOM, so one of each
    // is enough however often the bar is set up (e.g. in tests).
    for (const [target, type, fn] of [
      [document, 'keydown', onSlashKey], [document, 'click', onDocumentClick],
      [window, 'resize', onWindowResize], [window, 'hashchange', onWorktreeHashChange],
    ]) {
      target.removeEventListener(type, fn);
      target.addEventListener(type, fn);
    }
  } catch { /* non-fatal */ }
}

// ── Boot ───────────────────────────────────────────────────────────────────
// Fetches diff + state from the server and re-renders everything in-place.
// Safe to call multiple times (worktree switch, manual refresh).
async function loadAndRender() {
  // Flush any pending auto-save before resetting state.  If we just cancel
  // the timer, approvals made after the last successful save are silently
  // lost when the user reloads before the 500 ms debounce fires.  Saving
  // first ensures they land on disk and are restored below.
  await flushSave();
  // Reset ephemeral state before loading new worktree data
  resetReviewState();
  state.patches = [];
  state.currentPatchIdx = 0;
  state.revisions = [];
  state.updatedPatches = {};
  state.showRevision = {};
  state.compareRevision = {};

  const loading = $('#loading');
  const errorMsg = $('#error-msg');
  const stateWarning = $('#state-warning');
  const filesChanged = $('#files-changed');

  loading.style.display = '';
  errorMsg.style.display = 'none';
  if (stateWarning) stateWarning.style.display = 'none';
  filesChanged.style.display = 'none';

  try {
    // The highlighter loads in parallel with the diff; wait for it (it never
    // rejects — on failure diffs render as plain text) before rendering.
    const [diffRes, stateRes] = await Promise.all([fetch('api/diff'), fetch('api/state'), highlighterReady]);

    const data = await diffRes.json();
    if (!diffRes.ok) throw new Error(data.error || 'Failed to load diff');

    // Did we actually retrieve the prior review state? If the saved state file
    // exists but couldn't be read (unreadable), we must NOT run revision
    // detection — recording a fresh baseline would overwrite the file and
    // permanently destroy the reviewer's saved approvals. Leave it untouched.
    let stateUnavailable = !stateRes.ok;
    if (stateRes.ok) {
      const saved = await stateRes.json();
      if (saved && saved.unreadable) {
        stateUnavailable = true;
        if (saved.prompt) setSavedPromptText(saved.prompt);
      } else {
        applySavedState(saved);
      }
    }

    state.patches = data.patches || [];
    state.linkRules = data.linkRules || [];
    // Reopen the patch tab this worktree was on before the reload.
    setLayoutWorktree(data.worktreeName);
    state.currentPatchIdx = savedPatchIndex(state.patches);

    // Reset the update-detection baseline to the worktree we just loaded, and
    // clear any stale banner.  Without this, switching worktrees would compare
    // the new worktree's HEAD against the previous one's and falsely report
    // "codebase updated".  The banner should fire only when the *currently
    // viewed* worktree's HEAD changes.
    if (data.headHash != null) lastKnownHead = data.headHash;
    $('#update-banner').style.display = 'none';

    $('#bug-id-display').textContent = data.worktreeName;
    $('#worktree-path').textContent = data.worktreePath;
    if (data.repoName) document.title = `${data.repoName}-${data.worktreeName}`;

    loading.style.display = 'none';
    filesChanged.style.display = '';

    if (stateUnavailable) {
      if (stateWarning) {
        stateWarning.textContent = 'Saved review state could not be read — your approvals and comments are not shown, and the saved file is left untouched so it can be recovered. Reloading will retry.';
        stateWarning.style.display = '';
      }
    } else {
      detectRevisionChanges();
      restoreRevisionView();
    }
    renderTabs();
    initPatchNodes();
    if (!scrollRestored) {
      scrollRestored = true;
      const y = savedScroll();
      if (y) requestAnimationFrame(() => window.scrollTo(0, y));
    }
    updateSubmitButton();
    refreshPromptBar();

    initStateChannel(data.worktreeName, applyRemoteDelta);
  } catch (err) {
    loading.style.display = 'none';
    errorMsg.style.display = '';
    errorMsg.textContent = `Error loading diff: ${err.message}`;
  }
}

function applySavedState(saved) {
  if (!saved) return;
  // Never apply a payload the server flagged as unreadable — it carries no real
  // state, and treating it as such must never clobber what's in memory/on disk.
  if (saved.unreadable) return;
  if (saved.comments) state.comments = saved.comments;
  if (saved.generalComments) state.generalComments = saved.generalComments;
  if (saved.approved) state.approved = new Set(saved.approved);
  if (saved.denied) state.denied = new Set(saved.denied);
  if (saved.reapprovalNeeded) state.reapprovalNeeded = new Set(saved.reapprovalNeeded);
  if (saved.revisions) state.revisions = saved.revisions;
  if (saved.prompt) setSavedPromptText(saved.prompt);
  replaceDrafts(saved.drafts || null);
}

// ── Targeted remote-delta application ──────────────────────────────────────
// When another tab broadcasts a delta, apply only the affected piece of the
// UI in place.  Crucially this leaves open comment forms, focused textareas,
// and in-progress typing untouched — the failure mode the bulk-refresh path
// has.  Unknown kinds and `bulk`/`revisions` fall back to fullRefresh().

function lineObjForKey(key) {
  const num = parseInt(key.slice(1), 10);
  if (key[0] === 'n') return { newLineNum: num, oldLineNum: null, content: '' };
  return { newLineNum: null, oldLineNum: num, content: '' };
}

function findLineTr(patchHash, file, key) {
  const idx = state.patches.findIndex((p) => p.hash === patchHash);
  if (idx < 0) return { idx: -1, tr: null };
  const el = patchEls[idx]?.el;
  if (!el) return { idx, tr: null };
  const tr = el.querySelector(
    `tr[data-file-path="${CSS.escape(file)}"][data-line-key="${CSS.escape(key)}"]`
  );
  return { idx, tr };
}

function lineFormOpen(tr, key) {
  const next = tr && tr.nextElementSibling;
  return !!(next && next.classList.contains('comment-form-row') && next.dataset.lineKey === key);
}

function commitMsgFormOpen(patchIdx) {
  const el = patchEls[patchIdx]?.el;
  if (!el) return false;
  return !!el.querySelector('.commit-msg-block .comment-form-inner');
}

function refreshCommitMessageBlock(patchIdx) {
  const el = patchEls[patchIdx]?.el;
  if (!el) return;
  const block = el.querySelector('.commit-msg-block');
  if (!block) return;
  const patch = state.patches[patchIdx];
  const isApproved = state.approved.has(patch.hash);
  const container = block.parentNode;
  const before = block.nextSibling;
  block.remove();
  const tmp = document.createElement('div');
  renderCommitMessageSection(tmp, patch.hash, patch.body || patch.message, isApproved);
  container.insertBefore(tmp.firstChild, before);
}

function applyRemoteComment({ patchHash, file, key, value }) {
  if (value === null) deleteComment(patchHash, file, key);
  else setComment(patchHash, file, key, value);

  if (file === COMMIT_FILE && key === COMMIT_KEY) {
    const idx = state.patches.findIndex((p) => p.hash === patchHash);
    if (idx < 0) return;
    if (!commitMsgFormOpen(idx)) refreshCommitMessageBlock(idx);
  } else {
    const { tr } = findLineTr(patchHash, file, key);
    if (tr && !lineFormOpen(tr, key)) {
      const line = lineObjForKey(key);
      const next = tr.nextElementSibling;
      if (next
          && (next.classList.contains('comment-display-row') || next.classList.contains('comment-draft-row'))
          && next.dataset.lineKey === key) {
        next.remove();
      }
      if (value === null) restoreLineDisplay(tr, patchHash, file, line, key);
      else renderCommentDisplay(tr, patchHash, file, line, key);
    }
  }
  renderTabs();
  updateSubmitButton();
}

function applyRemoteDraft({ key, value }) {
  // key is "patchHash/filePath/lineKey"
  const slash1 = key.indexOf('/');
  const slash2 = key.lastIndexOf('/');
  if (slash1 < 0 || slash2 <= slash1) return;
  const patchHash = key.slice(0, slash1);
  const filePath  = key.slice(slash1 + 1, slash2);
  const lineKeyStr = key.slice(slash2 + 1);

  if (value == null || value === '') delete drafts[key];
  else drafts[key] = value;

  if (filePath === COMMIT_FILE && lineKeyStr === COMMIT_KEY) {
    const idx = state.patches.findIndex((p) => p.hash === patchHash);
    if (idx >= 0 && !commitMsgFormOpen(idx)) refreshCommitMessageBlock(idx);
    return;
  }

  const { tr } = findLineTr(patchHash, filePath, lineKeyStr);
  if (!tr || lineFormOpen(tr, lineKeyStr)) return;

  // Draft wins over a saved comment on the same line, so a pending edit
  // stays discoverable even when a saved version exists.
  const line = lineObjForKey(lineKeyStr);
  if (value && value.trim()) {
    renderDraftDisplay(tr, patchHash, filePath, line, lineKeyStr);
  } else {
    // Remote cleared the draft.  Fall back to the saved comment row if any.
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('comment-draft-row') && next.dataset.lineKey === lineKeyStr) {
      next.remove();
    }
    restoreLineDisplay(tr, patchHash, filePath, line, lineKeyStr);
  }
}

function applyRemoteDecision({ patchHash, action }) {
  if (action === 'approve')        approvePatch(patchHash);
  else if (action === 'unapprove') unapprovePatch(patchHash);
  else if (action === 'deny')      denyPatch(patchHash);
  else if (action === 'undeny')    undenyPatch(patchHash);
  else return;

  const idx = state.patches.findIndex((p) => p.hash === patchHash);
  if (idx >= 0) {
    const el = patchEls[idx]?.el;
    const isApproved = state.approved.has(patchHash);
    const isDenied   = state.denied.has(patchHash);
    if (el) {
      const heading = el.querySelector('.patch-heading');
      if (heading) {
        heading.className = 'patch-heading'
          + (isApproved ? ' patch-heading-approved' : '')
          + (isDenied  ? ' patch-heading-denied'   : '');
      }
      const approveBtn = el.querySelector('.btn-approve, .btn-unapprove');
      if (approveBtn) {
        approveBtn.className = isApproved ? 'btn-unapprove' : 'btn-approve';
        approveBtn.textContent = isApproved ? 'Approved ✓' : 'Approve';
      }
      const denyBtn = el.querySelector('.btn-deny, .btn-undeny');
      if (denyBtn) {
        denyBtn.className = isDenied ? 'btn-undeny' : 'btn-deny';
        denyBtn.textContent = isDenied ? 'Denied ✗' : 'Deny';
      }
      const ta = el.querySelector('.general-comment-textarea');
      if (ta) ta.disabled = isApproved;

      // Commit-message block captures `disabled` in a closure on render.
      // Re-render it so the showForm gate matches the new approval state —
      // unless a form is currently open (in which case we mustn't yank it).
      if (!commitMsgFormOpen(idx)) refreshCommitMessageBlock(idx);
    }
    const diffWrap = patchEls[idx]?.diffWrap;
    if (diffWrap) diffWrap.classList.toggle('diff-approved-readonly', isApproved);
  }
  renderTabs();
  updateSubmitButton();
  refreshPromptBar();
}

function applyRemoteGeneralComment({ patchHash, value }) {
  setGeneralComment(patchHash, value || '');
  const idx = state.patches.findIndex((p) => p.hash === patchHash);
  if (idx < 0) return;
  const el = patchEls[idx]?.el;
  if (!el) return;
  const ta = el.querySelector('.general-comment-textarea');
  if (!ta) return;
  if (document.activeElement === ta) return; // don't stomp the user's typing
  ta.value = value || '';
  updateSubmitButton();
}

function applyRemoteDelta(delta) {
  if (!delta || delta.kind === 'bulk' || delta.kind === 'revisions' || delta.kind === 'catchup') {
    return fullRefresh();
  }
  try {
    switch (delta.kind) {
      case 'comment':         applyRemoteComment(delta); break;
      case 'draft':           applyRemoteDraft(delta); break;
      case 'decision':        applyRemoteDecision(delta); break;
      case 'general-comment': applyRemoteGeneralComment(delta); break;
      default: return fullRefresh();
    }
  } catch {
    fullRefresh();
  }
}

// Full state refetch + re-render — the safety net for unknown deltas, bulk
// resets, revision migrations, and SSE-reconnect catchups.  If we currently
// have debounced typed text in flight, defer the refresh so we don't yank
// the user's open form away mid-typing; retry shortly.
let _refreshDeferred = false;
async function fullRefresh() {
  if (hasPendingSave()) {
    if (!_refreshDeferred) {
      _refreshDeferred = true;
      setTimeout(() => { _refreshDeferred = false; fullRefresh(); }, 800);
    }
    return;
  }
  try {
    const res = await fetch('api/state');
    if (!res.ok) return;
    applySavedState(await res.json());
    renderTabs();
    initPatchNodes();
    updateSubmitButton();
    refreshPromptBar();
  } catch { /* network blip — next broadcast will retry */ }
}

// ── Keyboard shortcuts ───────────────────────────────────────────────────────
// Page-wide keys stand down while a text field has the focus (they keep their
// native meaning there) or the result overlay is open.
function shortcutsPaused(e) {
  const t = e.target;
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return true;
  return !!$('#result-overlay')?.classList.contains('visible');
}

// Left/Right arrows move between patch tabs; Up/Down arrows move between files
// in the current patch.  Ignored while a text field is focused or the result
// overlay is open, so the keys keep their native behavior there.
function handleArrowKeys(e) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  // Bail on the common case (any non-arrow key) before touching the DOM, so
  // ordinary typing never pays for the focus/overlay checks below.
  const horizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
  const vertical   = e.key === 'ArrowUp'   || e.key === 'ArrowDown';
  if (!horizontal && !vertical) return;

  if (shortcutsPaused(e)) return;

  if (horizontal) {
    const n = state.patches.length;
    if (n <= 1) return;
    const dir = e.key === 'ArrowLeft' ? -1 : 1;
    const idx = Math.max(0, Math.min(n - 1, state.currentPatchIdx + dir));
    if (idx === state.currentPatchIdx) return;
    e.preventDefault();
    switchPatch(idx);
  } else {
    if (navigateFile(e.key === 'ArrowUp' ? -1 : 1)) e.preventDefault();
  }
}

// ── Back-to-top button ───────────────────────────────────────────────────────
// Shows a floating "↑ Top" button once the page is scrolled past one viewport
// (i.e. the reader is deep in / at the end of a long diff) and jumps back up.
function initBackToTop() {
  const btn = $('#btn-back-to-top');
  if (!btn) return;
  let visible = false;
  const sync = () => {
    const show = window.scrollY > window.innerHeight;
    if (show === visible) return; // only touch the DOM when it actually flips
    visible = show;
    btn.classList.toggle('visible', show);
  };
  window.addEventListener('scroll', sync, { passive: true });
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  sync(); // handle a reload that restored a scrolled position
}

// ── Project switcher ─────────────────────────────────────────────────────────
// Under the hub every project has its own path on one port.  Fill the header
// dropdown with the mounted projects (plus the dashboard at /) so the reviewer
// can jump between them.  Stays hidden when this page isn't one of the hub's
// projects (e.g. served standalone, where the hub endpoint doesn't exist).
export async function initProjectSwitcher() {
  const sel = $('#project-switcher');
  if (!sel) return;
  let projects;
  try {
    const res = await fetch('/api/hub/projects'); // hub root, not this project
    if (!res.ok) return;
    ({ projects } = await res.json());
  } catch { return; }
  const here = window.location.pathname;
  if (!Array.isArray(projects) || !projects.some((p) => p.path === here)) return;
  sel.replaceChildren(
    ...projects.map((p) => new Option(p.slug, p.path, false, p.path === here)),
    new Option('All projects…', '/'),
  );
  sel.hidden = false;
  sel.addEventListener('change', () => { window.location.href = sel.value; });
}

async function init() {
  highlighterReady = loadHighlighter(); // awaited by loadAndRender, next to the diff fetch
  setupStickySidebarOffset();
  updateSubmitButton();

  $('#btn-submit').addEventListener('click', submitReview);
  document.addEventListener('keydown', handleArrowKeys);
  initBackToTop();
  initTabsDragScroll();
  initProjectSwitcher();

  $('#btn-copy-prompt').addEventListener('click', () => {
    const prompt = $('#result-prompt').value;
    navigator.clipboard.writeText(prompt).then(() => {
      $('#btn-copy-prompt').textContent = 'Copied!';
      setTimeout(() => { $('#btn-copy-prompt').textContent = 'Copy prompt'; }, 2000);
    });
  });

  $('#btn-copy-current-prompt').addEventListener('click', () => {
    const bar = $('#current-prompt-bar');
    const prompt = bar && bar.dataset.prompt;
    if (!prompt) return;
    navigator.clipboard.writeText(prompt).then(() => {
      $('#btn-copy-current-prompt').textContent = 'Copied!';
      setTimeout(() => { $('#btn-copy-current-prompt').textContent = 'Copy current prompt'; }, 2000);
    });
  });

  $('#btn-close-modal').addEventListener('click', () => {
    $('#result-overlay').classList.remove('visible');
  });

  $('#result-overlay').addEventListener('click', (e) => {
    if (e.target === $('#result-overlay')) {
      $('#result-overlay').classList.remove('visible');
    }
  });

  $('#btn-reload-page').addEventListener('click', async () => {
    $('#update-banner').style.display = 'none';
    await loadAndRender();
  });

  // Tab background suspension can throttle EventSource delivery on some
  // browsers.  If the SSE saw an error while we were hidden, reconcile when
  // the tab is shown again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') maybeCatchupOnVisible();
    else saveScroll(window.scrollY);
  });
  window.addEventListener('pagehide', () => saveScroll(window.scrollY));

  await initWorktreeBar(); // awaited so hash-based switch completes before first render
  await loadAndRender();
}

// ── Update detection ───────────────────────────────────────────────────────
// HEAD hash of the worktree currently loaded in this tab.  loadAndRender sets
// it from /api/diff on every load/switch so the poll's baseline tracks the
// viewed worktree — switching worktrees never looks like an "update".
let lastKnownHead = null;

// Polls /api/headhash every 5 seconds; shows a reload banner when the currently
// viewed worktree's HEAD changes (i.e. commits were amended or added).
function startUpdatePolling() {
  _pollTimer = setInterval(async () => {
    try {
      const res = await fetch('api/headhash');
      if (!res.ok) return;
      const { hash } = await res.json();
      if (lastKnownHead == null) { lastKnownHead = hash; return; } // not loaded yet
      if (hash !== lastKnownHead) {
        lastKnownHead = hash;
        $('#update-banner').style.display = '';
      }
    } catch { /* ignore network errors (e.g. demo mode) */ }
  }, 5000);
}

document.addEventListener('DOMContentLoaded', () => {
  init();
  startUpdatePolling();
});

// Allow unit tests to import pure helpers without loading the full browser app.
if (typeof module !== 'undefined') {
  module.exports = {
    // state.js re-exports (for test backward compat)
    state, drafts, draftKey,
    // revisions.js re-exports (for test backward compat)
    diffFingerprint, migrateApprovals,
    // renderer.js re-exports (for test backward compat)
    renderDraftDisplay, removeExistingForm, showCommentForm,
    renderFileNav, renderFile,
    renderCommitMessageSection,
    buildPatchEl,
    initPatchNodes,
    renderTabs,
    switchPatch,
    patchEls,
    addDragScroll,
    formatPatchDate,
    // app.js exports
    submitReview,
    loadAndRender,
    init,
    initWorktreeBar,
    onWorktreeHashChange,
    getPollTimer: () => _pollTimer,
  };
}


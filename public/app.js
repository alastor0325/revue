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
import { diffFingerprint, migrateApprovals, detectRevisionChanges } from './revisions.js';
// Renderer: all DOM functions + re-exportable items for tests
import {
  patchEls, updateSubmitButton, removeExistingForm, showCommentForm,
  renderDraftDisplay, renderCommentDisplay, renderCommitMessageSection,
  restoreLineDisplay,
  renderFileNav, renderFile, navigateFile,
  renderTabs, switchPatch, buildPatchEl, renderCurrentPatch, initPatchNodes,
  addDragScroll, initTabsDragScroll, getFileNavCollapsed, setFileNavCollapsed,
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
    const res = await fetch('/api/submit', {
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

    // Announce that a prompt was generated so integrations (e.g. fx-dev-hub's
    // "run it in Claude") can act without revue depending on them.
    if (typeof document.dispatchEvent === 'function') {
      document.dispatchEvent(
        new CustomEvent('revue:prompt-generated', { detail: { prompt: json.prompt } }),
      );
    }

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
    // Restore the idle label. An integration may repurpose this button (e.g.
    // fx-dev-hub sets data-idle-label to "Generate & Run in Claude"); honor it.
    btn.textContent = btn.dataset.idleLabel || 'Generate Review Prompt';
    updateSubmitButton();
    // Set error AFTER updateSubmitButton so it is not cleared when hasActivity is true
    if (submitError) {
      const warn = $('#submit-warning');
      if (warn) warn.textContent = `Error: ${submitError}`;
    }
  }
}

// ── Worktree switcher ──────────────────────────────────────────────────────
async function initWorktreeBar() {
  try {
    const res = await fetch('/api/worktrees');
    if (!res.ok) return;
    let { current, worktrees } = await res.json();
    if (worktrees.length <= 1) return; // nothing to switch to

    // ── Hash navigation: switch to worktree named in URL hash on load ──
    const hashName = window.location.hash.slice(1);
    if (hashName && hashName !== current) {
      const target = worktrees.find((wt) => wt.worktreeName === hashName);
      if (target) {
        const r = await fetch('/api/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreeName: hashName }),
        });
        if (r.ok) current = hashName;
      }
    }

    // Keep URL hash in sync with active worktree
    history.replaceState(null, '', '#' + current);

    const bar = $('#worktree-bar');
    const pills = $('#worktree-pills');
    const btnLeft = $('#worktree-scroll-left');
    const btnRight = $('#worktree-scroll-right');

    pills.innerHTML = worktrees.map((wt) =>
      `<button class="worktree-pill${wt.worktreeName === current ? ' active' : ''}" data-name="${escapeHtml(wt.worktreeName)}">${escapeHtml(wt.worktreeName)}</button>`
    ).join('');

    // Drag to scroll the bar left/right, same as the patch-tabs bar.
    addDragScroll(pills);

    // Scroll arrow logic
    function updateScrollBtns() {
      const atLeft = pills.scrollLeft <= 0;
      const atRight = pills.scrollLeft + pills.clientWidth >= pills.scrollWidth - 1;
      btnLeft.disabled = atLeft;
      btnRight.disabled = atRight;
      btnLeft.style.display = pills.scrollWidth <= pills.clientWidth ? 'none' : '';
      btnRight.style.display = pills.scrollWidth <= pills.clientWidth ? 'none' : '';
    }
    const SCROLL_STEP = 160;
    btnLeft.addEventListener('click', () => { pills.scrollBy({ left: -SCROLL_STEP, behavior: 'smooth' }); });
    btnRight.addEventListener('click', () => { pills.scrollBy({ left: SCROLL_STEP, behavior: 'smooth' }); });
    pills.addEventListener('scroll', updateScrollBtns, { passive: true });
    // Re-check after layout (fonts/widths may not be ready yet)
    setTimeout(updateScrollBtns, 50);

    pills.addEventListener('click', async (e) => {
      const btn = e.target.closest('.worktree-pill');
      if (!btn || btn.classList.contains('active')) return;
      const name = btn.dataset.name;
      btn.textContent = 'Switching…';
      btn.disabled = true;
      try {
        const r = await fetch('/api/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreeName: name }),
        });
        if (!r.ok) throw new Error('Switch failed');
        history.replaceState(null, '', '#' + name);
        // Update active pill
        pills.querySelectorAll('.worktree-pill').forEach((p) => {
          p.classList.toggle('active', p.dataset.name === name);
          p.disabled = false;
          p.textContent = p.dataset.name;
        });
        await loadAndRender();
      } catch {
        btn.textContent = name;
        btn.disabled = false;
      }
    });

    bar.style.display = '';

    // Handle hash changes after page load (e.g. user edits hash in address bar).
    // Remove any previous listener before adding a new one so re-initialisation
    // (e.g. in tests) never accumulates duplicate handlers.
    if (initWorktreeBar._hashHandler) {
      window.removeEventListener('hashchange', initWorktreeBar._hashHandler);
    }
    initWorktreeBar._hashHandler = async () => {
      const name = window.location.hash.slice(1);
      if (!name) return;
      const active = pills.querySelector('.worktree-pill.active');
      if (active && active.dataset.name === name) return; // already on it
      const target = worktrees.find((wt) => wt.worktreeName === name);
      if (!target) return;
      pills.querySelectorAll('.worktree-pill').forEach((p) => {
        p.disabled = p.dataset.name !== name;
        if (p.dataset.name === name) p.textContent = 'Switching…';
      });
      try {
        const r = await fetch('/api/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreeName: name }),
        });
        if (!r.ok) throw new Error('Switch failed');
        pills.querySelectorAll('.worktree-pill').forEach((p) => {
          p.classList.toggle('active', p.dataset.name === name);
          p.disabled = false;
          p.textContent = p.dataset.name;
        });
        await loadAndRender();
      } catch {
        pills.querySelectorAll('.worktree-pill').forEach((p) => {
          p.disabled = false;
          p.textContent = p.dataset.name;
        });
      }
    };
    window.addEventListener('hashchange', initWorktreeBar._hashHandler);
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
    const [diffRes, stateRes] = await Promise.all([fetch('/api/diff'), fetch('/api/state')]);

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
    state.currentPatchIdx = 0;

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
    }
    renderTabs();
    initPatchNodes();
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
    const res = await fetch('/api/state');
    if (!res.ok) return;
    applySavedState(await res.json());
    renderTabs();
    initPatchNodes();
    updateSubmitButton();
    refreshPromptBar();
  } catch { /* network blip — next broadcast will retry */ }
}

// ── Keyboard shortcuts ───────────────────────────────────────────────────────
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

  const t = e.target;
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if ($('#result-overlay').classList.contains('visible')) return;

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

async function init() {
  setupStickySidebarOffset();
  updateSubmitButton();

  $('#btn-submit').addEventListener('click', submitReview);
  document.addEventListener('keydown', handleArrowKeys);
  initBackToTop();
  initTabsDragScroll();

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
  });

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
      const res = await fetch('/api/headhash');
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
    getFileNavCollapsed, setFileNavCollapsed,
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
    getPollTimer: () => _pollTimer,
  };
}


import {
  state, drafts, draftKey, lineKey,
  getComment, setComment, deleteComment, commentsForPatch,
  getGeneralComment, setGeneralComment,
  approvePatch, unapprovePatch, denyPatch, undenyPatch,
  COMMIT_FILE, COMMIT_KEY,
} from './state.js';
import {
  saveCommentNow, saveDecisionNow,
  scheduleDraftSave, saveDraftNow, scheduleGeneralCommentSave,
  refreshPromptBar,
} from './persistence.js';
import { getRevisionList } from './revisions.js';

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

// Pre-rendered patch elements. Each entry: { el, diffWrap, navItemsEl }.
// All are kept in #files-changed; only the active one is visible (display:'').
export const patchEls = [];

// ── Submit button state ────────────────────────────────────────────────────
export function updateSubmitButton() {
  const btn = $('#btn-submit');
  const warn = $('#submit-warning');

  const hasActivity =
    state.approved.size > 0 ||
    state.denied.size > 0 ||
    state.patches.some((p) =>
      commentsForPatch(p.hash).length > 0 ||
      getGeneralComment(p.hash).trim().length > 0
    );

  if (hasActivity) {
    btn.disabled = false;
    warn.textContent = '';
  } else {
    btn.disabled = true;
    warn.textContent = 'Review at least one patch before generating the prompt';
  }
}

// ── Inline comment form ────────────────────────────────────────────────────
// When a form closes (cancel, click elsewhere, click same line again), the
// line needs to fall back to whatever indicator best reflects current state.
// Draft wins so a pending edit of a saved comment is still discoverable —
// otherwise both the saved-comment-display row (removed when the form
// opened) AND the draft row would be invisible and the user has no idea
// where their unsaved typing went.
export function restoreLineDisplay(trLine, patchHash, filePath, line, key) {
  const dk = draftKey(patchHash, filePath, key);
  const draftText = drafts[dk];
  if (draftText && draftText.trim()) {
    renderDraftDisplay(trLine, patchHash, filePath, line, key);
  } else if (getComment(patchHash, filePath, key)) {
    renderCommentDisplay(trLine, patchHash, filePath, line, key);
  }
}

export function removeExistingForm() {
  const existing = $('.comment-form-row');
  if (existing) {
    const ctx = existing._draftContext;
    existing.remove();
    if (ctx) restoreLineDisplay(ctx.tr, ctx.patchHash, ctx.filePath, ctx.line, ctx.key);
  }
}

export function showCommentForm(tr, patchHash, filePath, line, key) {
  removeExistingForm();

  const formRow = document.createElement('tr');
  formRow.className = 'comment-form-row';
  formRow.innerHTML = `
    <td colspan="3">
      <div class="comment-form-inner">
        <textarea placeholder="Leave a comment on this line…" autofocus></textarea>
        <div class="comment-actions">
          <button class="btn-cancel">Cancel</button>
          <button class="btn-discard">Discard draft</button>
          <button class="btn-save">Save comment</button>
        </div>
      </div>
    </td>`;

  tr.after(formRow);
  formRow._draftContext = { tr, patchHash, filePath, line, key };

  const textarea = formRow.querySelector('textarea');
  const dk = draftKey(patchHash, filePath, key);
  const existing = getComment(patchHash, filePath, key);
  textarea.value = existing ? existing.text : (drafts[dk] || '');
  textarea.focus();

  textarea.addEventListener('input', () => {
    drafts[dk] = textarea.value;
    scheduleDraftSave(dk, textarea.value);
  });

  formRow.querySelector('.btn-cancel').addEventListener('click', () => {
    formRow.remove();
    restoreLineDisplay(tr, patchHash, filePath, line, key);
  });

  formRow.querySelector('.btn-discard').addEventListener('click', () => {
    delete drafts[dk];
    saveDraftNow(dk, null);
    formRow.remove();
  });

  formRow.querySelector('.btn-save').addEventListener('click', () => {
    const text = textarea.value.trim();
    if (!text) return;
    delete drafts[dk];
    const commentObj = {
      patchHash,
      file: filePath,
      line: line.newLineNum != null ? line.newLineNum : line.oldLineNum,
      lineContent: line.content,
      text,
    };
    setComment(patchHash, filePath, key, commentObj);
    // Drop the now-stale draft from disk in the same flush so a reload doesn't
    // resurrect it after the comment has been saved.
    saveDraftNow(dk, null);
    saveCommentNow(patchHash, filePath, key, commentObj);
    updateSubmitButton();
    formRow.remove();
    renderCommentDisplay(tr, patchHash, filePath, line, key);
  });
}

export function renderCommentDisplay(trLine, patchHash, filePath, line, key) {
  const next = trLine.nextElementSibling;
  if (next && next.classList.contains('comment-display-row') && next.dataset.lineKey === key) {
    next.remove();
  }

  const comment = getComment(patchHash, filePath, key);
  if (!comment) return;

  const lineNum = line.newLineNum != null ? line.newLineNum : line.oldLineNum;
  const displayRow = document.createElement('tr');
  displayRow.className = 'comment-display-row';
  displayRow.dataset.lineKey = key;
  displayRow.innerHTML = `
    <td colspan="3">
      <div class="comment-display-inner">
        <div style="flex:1">
          <div class="comment-meta">Line ${lineNum} · ${escapeHtml(filePath)}</div>
          <div class="comment-body">${escapeHtml(comment.text)}</div>
        </div>
        <button class="btn-delete-comment" title="Delete comment">×</button>
      </div>
    </td>`;

  trLine.after(displayRow);

  displayRow.querySelector('.btn-delete-comment').addEventListener('click', () => {
    deleteComment(patchHash, filePath, key);
    saveCommentNow(patchHash, filePath, key, null);
    updateSubmitButton();
    displayRow.remove();
  });

  displayRow.querySelector('.comment-body').style.cursor = 'pointer';
  displayRow.querySelector('.comment-body').addEventListener('click', () => {
    displayRow.remove();
    showCommentForm(trLine, patchHash, filePath, line, key);
  });
}

export function renderDraftDisplay(trLine, patchHash, filePath, line, key) {
  // Remove any existing draft row OR (stale) comment-display row for this
  // line first.  The draft row always replaces them because draft text
  // represents the user's latest unsaved intent — including unsaved edits
  // of a previously saved comment.
  const next = trLine.nextElementSibling;
  if (next && (next.classList.contains('comment-draft-row') || next.classList.contains('comment-display-row')) && next.dataset.lineKey === key) {
    next.remove();
  }

  const dk = draftKey(patchHash, filePath, key);
  const text = drafts[dk];
  if (!text || !text.trim()) return;

  const lineNum = line.newLineNum != null ? line.newLineNum : line.oldLineNum;
  const displayRow = document.createElement('tr');
  displayRow.className = 'comment-draft-row';
  displayRow.dataset.lineKey = key;
  displayRow.innerHTML = `
    <td colspan="3">
      <div class="comment-draft-inner">
        <div style="flex:1">
          <div class="comment-meta"><span class="draft-badge">Draft</span> Line ${lineNum} · ${escapeHtml(filePath)}</div>
          <div class="comment-body comment-draft-body">${escapeHtml(text)}</div>
        </div>
      </div>
    </td>`;

  trLine.after(displayRow);

  displayRow.querySelector('.comment-draft-inner').addEventListener('click', () => {
    displayRow.remove();
    showCommentForm(trLine, patchHash, filePath, line, key);
  });
}

// ── Commit message comment section ─────────────────────────────────────────
export function renderCommitMessageSection(container, patchHash, commitMessage, disabled) {
  const box = document.createElement('div');
  box.className = 'commit-msg-block';

  const header = document.createElement('div');
  header.className = 'commit-msg-header';
  header.textContent = 'Commit message';
  box.appendChild(header);

  const firstNewline = commitMessage.indexOf('\n');
  const subject = firstNewline >= 0 ? commitMessage.slice(0, firstNewline).trim() : commitMessage;
  const bodyText = firstNewline >= 0 ? commitMessage.slice(firstNewline).trim() : '';

  const subjectEl = document.createElement('div');
  subjectEl.className = 'commit-msg-subject';
  subjectEl.textContent = subject;
  box.appendChild(subjectEl);

  const msgEl = document.createElement('div');
  msgEl.className = 'commit-msg-text' + (bodyText ? '' : ' commit-msg-text-empty');
  if (bodyText) {
    msgEl.textContent = bodyText;
  }
  box.appendChild(msgEl);

  const commentEl = document.createElement('div');
  box.appendChild(commentEl);

  const formEl = document.createElement('div');
  box.appendChild(formEl);

  function refreshComment() {
    commentEl.innerHTML = '';
    commentEl.className = '';
    // Draft wins: a pending edit of an already-saved commit-message comment
    // must stay discoverable, otherwise opening the form to tweak it and
    // clicking away looks like the typing was thrown away.
    const draftText = drafts[draftKey(patchHash, COMMIT_FILE, COMMIT_KEY)];
    const c = getComment(patchHash, COMMIT_FILE, COMMIT_KEY);
    if (draftText && draftText.trim()) {
      commentEl.className = 'comment-draft-row';
      commentEl.innerHTML = `
        <div class="comment-draft-inner" style="cursor:pointer">
          <div style="flex:1">
            <div class="comment-meta"><span class="draft-badge">Draft</span> Commit message</div>
            <div class="comment-body comment-draft-body">${escapeHtml(draftText)}</div>
          </div>
        </div>`;
      commentEl.querySelector('.comment-draft-inner').addEventListener('click', showForm);
      return;
    }
    if (!c) return;
    commentEl.className = 'comment-display-row';
    commentEl.innerHTML = `
      <div class="comment-display-inner">
        <div style="flex:1">
          <div class="comment-meta">Commit message</div>
          <div class="comment-body">${escapeHtml(c.text)}</div>
        </div>
        <button class="btn-delete-comment" title="Delete comment">×</button>
      </div>`;
    commentEl.querySelector('.btn-delete-comment').addEventListener('click', () => {
      deleteComment(patchHash, COMMIT_FILE, COMMIT_KEY);
      saveCommentNow(patchHash, COMMIT_FILE, COMMIT_KEY, null);
      updateSubmitButton();
      refreshComment();
    });
    const body = commentEl.querySelector('.comment-body');
    body.style.cursor = 'pointer';
    body.addEventListener('click', showForm);
  }

  function showForm() {
    if (disabled) return;
    if (window.getSelection().toString().length > 0) return;
    formEl.innerHTML = `
      <div class="comment-form-inner">
        <textarea placeholder="Leave feedback on this commit message…" autofocus></textarea>
        <div class="comment-actions">
          <button class="btn-cancel">Cancel</button>
          <button class="btn-discard">Discard draft</button>
          <button class="btn-save">Save comment</button>
        </div>
      </div>`;
    const dk = draftKey(patchHash, COMMIT_FILE, COMMIT_KEY);
    const existing = getComment(patchHash, COMMIT_FILE, COMMIT_KEY);
    const ta = formEl.querySelector('textarea');
    ta.value = existing ? existing.text : (drafts[dk] || '');
    ta.focus();
    ta.addEventListener('input', () => {
      drafts[dk] = ta.value;
      scheduleDraftSave(dk, ta.value);
    });
    formEl.querySelector('.btn-cancel').addEventListener('click', () => { formEl.innerHTML = ''; refreshComment(); });
    formEl.querySelector('.btn-discard').addEventListener('click', () => {
      delete drafts[dk];
      saveDraftNow(dk, null);
      formEl.innerHTML = '';
      refreshComment();
    });
    formEl.querySelector('.btn-save').addEventListener('click', () => {
      const text = ta.value.trim();
      if (!text) return;
      delete drafts[dk];
      const commentObj = {
        patchHash, file: COMMIT_FILE, line: 0, lineContent: commitMessage, text,
      };
      setComment(patchHash, COMMIT_FILE, COMMIT_KEY, commentObj);
      saveDraftNow(dk, null);
      saveCommentNow(patchHash, COMMIT_FILE, COMMIT_KEY, commentObj);
      updateSubmitButton();
      formEl.innerHTML = '';
      refreshComment();
    });
  }

  if (!disabled) {
    for (const el of [subjectEl, msgEl]) {
      el.style.cursor = 'pointer';
      el.title = 'Click to leave feedback on this commit message';
      el.addEventListener('click', showForm);
    }
  }

  refreshComment();
  container.appendChild(box);
}

// ── Diff rendering ─────────────────────────────────────────────────────────

/**
 * Insert an expand-context row into `table` before `insertBeforeEl` (or at
 * the end if null).  Manages its own hidden-line range and re-renders its
 * buttons after each expansion click.
 *
 * hiddenEnd may be null when the file length is not yet known (after-last-
 * hunk case); it is updated from the server's totalLines response.
 */
export function renderExpandRow(table, patchHash, filePath, hiddenStart, hiddenEnd, insertBeforeEl) {
  if (hiddenEnd !== null && hiddenStart > hiddenEnd) return;

  const CHUNK = 20;
  let curStart = hiddenStart;
  let curEnd   = hiddenEnd; // null = unknown (after last hunk)

  // Whether this row sits before the first hunk or after the last hunk
  const isFileTop    = hiddenStart === 1 && insertBeforeEl !== null;
  const isFileBottom = insertBeforeEl === null;

  const tr = document.createElement('tr');
  tr.className = 'expand-context-row';

  // Single delegated listener on tr — survives all tr.innerHTML replacements
  tr.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    // 'up'   — show lines just above the hunk below (near curEnd), insert below bar → curEnd retreats
    // 'down' — between hunks: show lines just below the hunk above (near curStart), insert above bar → curStart advances
    //          after last hunk: advance curStart forward, insert above bar (bar stays at bottom)
    if (action === 'up') {
      const end = curEnd ?? curStart + CHUNK - 1;
      load(Math.max(end - CHUNK + 1, curStart), end, false);
    } else if (action === 'down' && isFileBottom) {
      load(curStart, Math.min(curStart + CHUNK - 1, curEnd ?? curStart + CHUNK - 1), true);
    } else if (action === 'down') {
      load(curStart, Math.min(curStart + CHUNK - 1, curEnd), true);
    } else if (action === 'small') {
      load(curStart, curEnd, true);
    }
  });

  function rebuild() {
    const count = curEnd !== null ? curEnd - curStart + 1 : null;
    let btns = '';
    if (count !== null && count <= CHUNK) {
      btns = `<button class="btn-exp" data-action="small">↕ ${count} Line${count === 1 ? '' : 's'}</button>`;
    } else if (isFileTop) {
      btns = `<button class="btn-exp" data-action="up">↑ 20 Lines</button>`;
    } else if (isFileBottom) {
      btns = `<button class="btn-exp" data-action="down">↓ 20 Lines</button>`;
    } else {
      btns = `<button class="btn-exp" data-action="up">↑ 20 Lines</button>`;
      btns += `<button class="btn-exp" data-action="down">↓ 20 Lines</button>`;
    }
    tr.innerHTML = `<td colspan="3"><div class="expand-context-btns">${btns}</div></td>`;
  }

  async function load(fetchStart, fetchEnd, fromTop) {
    const parent = tr.parentNode;
    if (!parent) return;

    tr.innerHTML = `<td colspan="3"><div class="expand-context-btns"><span class="expander-loading">Loading…</span></div></td>`;

    try {
      const resp = await fetch(
        `/api/filecontext?hash=${encodeURIComponent(patchHash)}&file=${encodeURIComponent(filePath)}&start=${fetchStart}&end=${fetchEnd}`
      );
      if (!resp.ok) {
        console.error(`filecontext: HTTP ${resp.status} for ${filePath}`);
        rebuild();
        return;
      }
      const data = await resp.json();

      if (curEnd === null && data.totalLines != null) curEnd = data.totalLines;

      if (!Array.isArray(data.lines) || data.lines.length === 0) {
        if (curEnd !== null && curStart > curEnd) tr.remove();
        else rebuild();
        return;
      }

      // fromTop=true  → insert before tr (rows appear above the expand bar)
      // fromTop=false → insert before tr.nextSibling (rows appear below the bar)
      const anchor = fromTop ? tr : tr.nextSibling;
      for (const line of data.lines) {
        const row = document.createElement('tr');
        row.className = 'line-context line-context-expanded';
        row.innerHTML = `
          <td class="ln-old">${line.oldLineNum != null ? line.oldLineNum : ''}</td>
          <td class="ln-new">${line.newLineNum != null ? line.newLineNum : ''}</td>
          <td class="ln-content">${escapeHtml(' ' + line.content)}</td>`;
        parent.insertBefore(row, anchor);
      }

      if (fromTop) curStart = fetchEnd + 1;
      else         curEnd   = fetchStart - 1;

      if (curEnd !== null && curStart > curEnd) tr.remove();
      else rebuild();
    } catch (err) {
      console.error('Failed to load context lines:', err);
      rebuild();
    }
  }

  rebuild();
  if (insertBeforeEl) table.insertBefore(tr, insertBeforeEl);
  else                table.appendChild(tr);
}

export function countStats(hunks) {
  let added = 0, removed = 0;
  for (const hunk of hunks) {
    for (const l of hunk.lines) {
      if (l.type === 'added') added++;
      else if (l.type === 'removed') removed++;
    }
  }
  return { added, removed };
}

export function renderFile(fileData, patchHash) {
  const filePath = fileData.newPath || fileData.oldPath || '(unknown)';
  const { added, removed } = countStats(fileData.hunks);

  const block = document.createElement('div');
  block.className = 'file-block';

  const header = document.createElement('div');
  header.className = 'file-header';
  header.innerHTML = `
    <span class="file-toggle">▼</span>
    <span class="file-path">${escapeHtml(filePath)}</span>
    <span class="file-stats">
      <span class="stat-add">+${added}</span>
      <span class="stat-del">-${removed}</span>
    </span>`;
  block.appendChild(header);

  const body = document.createElement('div');
  body.className = 'diff-body';
  const table = document.createElement('table');
  table.className = 'diff-table';

  for (let hi = 0; hi < fileData.hunks.length; hi++) {
    const hunk = fileData.hunks[hi];

    // Compute the hidden line range above this hunk
    let gapStart, gapEnd;
    if (hi === 0) {
      gapStart = 1;
      gapEnd   = hunk.newStart - 1;
    } else {
      const prev = fileData.hunks[hi - 1];
      gapStart = prev.newStart + prev.newCount; // first line after prev hunk
      gapEnd   = hunk.newStart - 1;             // last line before this hunk
    }

    const hunkTr = document.createElement('tr');
    hunkTr.className = 'hunk-header';
    hunkTr.innerHTML = `<td colspan="3">${escapeHtml(hunk.header)}</td>`;
    table.appendChild(hunkTr);

    // Insert expand row before the @@ header
    if (gapStart <= gapEnd) {
      renderExpandRow(table, patchHash, filePath, gapStart, gapEnd, hunkTr);
    }

    for (const line of hunk.lines) {
      const tr = document.createElement('tr');
      const typeClass =
        line.type === 'added' ? 'line-added' :
        line.type === 'removed' ? 'line-removed' : 'line-context';
      tr.className = typeClass;

      const prefix =
        line.type === 'added' ? '+' :
        line.type === 'removed' ? '-' : ' ';

      const oldNum = line.oldLineNum != null ? line.oldLineNum : '';
      const newNum = line.newLineNum != null ? line.newLineNum : '';

      tr.innerHTML = `
        <td class="ln-old">${escapeHtml(String(oldNum))}</td>
        <td class="ln-new">${escapeHtml(String(newNum))}</td>
        <td class="ln-content"><span class="line-icon">＋</span>${escapeHtml(prefix + line.content)}</td>`;

      const key = lineKey(line);
      tr.dataset.filePath = filePath;
      tr.dataset.lineKey = key;
      tr.querySelector('.ln-content').addEventListener('click', () => {
        if (window.getSelection().toString().length > 0) return;
        const next = tr.nextElementSibling;
        if (next && next.classList.contains('comment-form-row')) {
          const ctx = next._draftContext;
          next.remove();
          if (ctx) restoreLineDisplay(ctx.tr, ctx.patchHash, ctx.filePath, ctx.line, ctx.key);
          return;
        }
        removeExistingForm();
        showCommentForm(tr, patchHash, filePath, line, key);
      });

      table.appendChild(tr);

      // Initial render — draft wins so reloading the page never hides a
      // pending edit behind the older saved-comment row.
      restoreLineDisplay(tr, patchHash, filePath, line, key);
    }

    // After the last hunk: expand row for remaining lines to end of file
    if (hi === fileData.hunks.length - 1 && hunk.newCount > 0) {
      renderExpandRow(table, patchHash, filePath, hunk.newStart + hunk.newCount, null, null);
    }
  }

  body.appendChild(table);
  block.appendChild(body);

  let collapsed = false;
  header.addEventListener('click', () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : '';
    header.querySelector('.file-toggle').classList.toggle('collapsed', collapsed);
  });

  return block;
}

// ── Patch tab rendering ─────────────────────────────────────────────────────
export function renderTabs() {
  const tabsBar = $('#patch-tabs-bar');
  const tabsEl = $('#patch-tabs');

  if (state.patches.length <= 1) {
    tabsBar.style.display = 'none';
    tabsEl.replaceChildren();
    return;
  }

  tabsBar.style.display = '';

  const existingBtns = tabsEl.querySelectorAll('.patch-tab');
  const needRebuild = existingBtns.length !== state.patches.length;

  if (needRebuild) {
    // First render or patch count changed — build all tab buttons from scratch
    const frag = document.createDocumentFragment();
    state.patches.forEach((patch, idx) => {
      const tab = document.createElement('button');
      tab.className = 'patch-tab';
      tab.addEventListener('click', () => switchPatch(idx));
      frag.appendChild(tab);
    });
    tabsEl.replaceChildren(frag);
  }

  // Update each tab button's class and content in-place
  const btns = tabsEl.querySelectorAll('.patch-tab');
  state.patches.forEach((patch, idx) => {
    const isApproved = state.approved.has(patch.hash);
    const isDenied = state.denied.has(patch.hash);
    const commentCount = commentsForPatch(patch.hash).length;

    const tab = btns[idx];
    tab.className = 'patch-tab' +
      (idx === state.currentPatchIdx ? ' active' : '') +
      (isApproved ? ' approved' : '') +
      (isDenied ? ' denied' : '') +
      (state.updatedPatches[idx] ? ' updated' : '');

    const badge = commentCount > 0 && !isApproved
      ? ` <span class="tab-badge">${commentCount}</span>`
      : '';
    const approvedIcon = isApproved ? ' <span class="tab-approved-icon">✓</span>' : '';
    const deniedIcon = isDenied ? ' <span class="tab-denied-icon">✗</span>' : '';
    const updatedIcon = state.updatedPatches[idx]
      ? ' <span class="tab-updated-icon">↑</span>'
      : '';

    tab.innerHTML = `<span class="tab-part">Part ${idx + 1}</span><span class="tab-msg">${escapeHtml(patch.message)}${badge}${approvedIcon}${deniedIcon}${updatedIcon}</span>`;
  });
}

export function switchPatch(idx) {
  removeExistingForm();
  if (patchEls[state.currentPatchIdx]) patchEls[state.currentPatchIdx].el.style.display = 'none';
  state.currentPatchIdx = idx;
  const entry = patchEls[idx];
  if (entry) {
    entry.el.style.display = '';
    activateFileNav(entry.navItemsEl, entry.diffWrap);
  }
  // Update active tab in-place — no DOM rebuild on switch
  const tabs = document.querySelectorAll('#patch-tabs .patch-tab');
  tabs.forEach((btn, i) => {
    btn.classList.toggle('active', i === idx);
  });
  // Keep the active tab visible: when the tab bar overflows the page width the
  // newly-selected tab may sit off-screen (e.g. after an arrow-key switch), so
  // scroll the bar just enough to bring it into view.
  scrollTabIntoView(tabs[idx]);
  updateSubmitButton();
}

// Horizontally scroll #patch-tabs-bar so `tab` is fully visible, nudging only
// when the tab is clipped past either edge.
function scrollTabIntoView(tab) {
  const bar = $('#patch-tabs-bar');
  if (!bar || !tab) return;
  const barRect = bar.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  if (tabRect.left < barRect.left) {
    bar.scrollBy({ left: tabRect.left - barRect.left - 8, behavior: 'smooth' });
  } else if (tabRect.right > barRect.right) {
    bar.scrollBy({ left: tabRect.right - barRect.right + 8, behavior: 'smooth' });
  }
}

// ── File navigation sidebar ─────────────────────────────────────────────────
const TOP_BAR_HEIGHT_VAR = '--top-bar-height';
let fileNavScrollHandler = null;
let fileNavCollapsed = false;
let _stickyOffsetSetup = false;
let _topBarHeight = 0;

// Why this exists: web-font swap-in (Space Grotesk) and dynamic top-bar
// children (update banner, prompt bar) change #top-bar's height after first
// paint. The sidebar's sticky offset (style.css) tracks the resulting value
// via --top-bar-height, and updateActive() reads the cached _topBarHeight to
// avoid forcing layout on every scroll event.
export function setupStickySidebarOffset() {
  if (_stickyOffsetSetup) return;
  _stickyOffsetSetup = true;

  const topBar = $('#top-bar');
  if (!topBar) return;

  const sync = () => {
    const h = Math.ceil(topBar.getBoundingClientRect().height);
    if (h === _topBarHeight) return;
    _topBarHeight = h;
    document.documentElement.style.setProperty(TOP_BAR_HEIGHT_VAR, h + 'px');
  };

  sync();

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(sync).observe(topBar);
  }
  document.fonts?.ready?.then(sync);
}

// Builds the file-nav items element for a patch. Pure DOM construction,
// no layout reads — safe to call while the patch is still detached / hidden.
// Returns the itemsEl div (with _navItems and _blocks attached) or null.
export function buildNavItemsEl(files, diffWrap) {
  if (!files || files.length === 0 || !diffWrap) return null;

  const blocks = Array.from(diffWrap.querySelectorAll('.file-block'));
  const itemsEl = document.createElement('div');
  itemsEl.className = 'file-nav-items';
  const navItems = [];

  files.forEach((fileData, idx) => {
    const filePath = fileData.newPath || fileData.oldPath || '(unknown)';
    const { added, removed } = countStats(fileData.hunks);

    const lastSlash = filePath.lastIndexOf('/');
    const filename = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
    const dirPath  = lastSlash >= 0 ? filePath.slice(0, lastSlash + 1) : '';

    const block = blocks[idx] || null;
    const item = document.createElement('div');
    item.className = 'file-nav-item';
    item.title = filePath;

    const filenameRow = document.createElement('div');
    filenameRow.className = 'file-nav-filename-row';

    const filenameSpan = document.createElement('span');
    filenameSpan.className = 'file-nav-filename';
    filenameSpan.textContent = filename;
    filenameRow.appendChild(filenameSpan);
    item.appendChild(filenameRow);

    if (dirPath) {
      const dirSpan = document.createElement('div');
      dirSpan.className = 'file-nav-dir';
      dirSpan.textContent = dirPath;
      item.appendChild(dirSpan);
    }

    const statsSpan = document.createElement('div');
    statsSpan.className = 'file-nav-stats';
    statsSpan.innerHTML = `<span class="stat-add">+${added}</span><span class="stat-del">-${removed}</span>`;
    item.appendChild(statsSpan);

    // Click handler reads getBoundingClientRect at click time (element is visible then).
    // Immediately update the active class so the highlight reflects the click even
    // when no scroll occurs (e.g. the target block is already in the viewport).
    item.addEventListener('click', () => {
      if (!block) return;
      navItems.forEach((ni, i) => ni.classList.toggle('active', i === idx));
      const y = block.getBoundingClientRect().top + window.scrollY - _topBarHeight - 8;
      window.scrollTo({ top: y, behavior: 'smooth' });
    });

    itemsEl.appendChild(item);
    navItems.push(item);
  });

  itemsEl._navItems = navItems;
  itemsEl._blocks = blocks;
  return itemsEl;
}

// Activates the file nav for the current patch: swaps in the pre-built items,
// sets up position/sizing, and attaches the scroll highlight handler.
// Called on tab switch — all work is O(1) DOM ops.
export function activateFileNav(navItemsEl, diffWrap) {
  const nav = $('#file-nav');
  if (!nav) return;

  if (fileNavScrollHandler) {
    window.removeEventListener('scroll', fileNavScrollHandler, { passive: true });
    fileNavScrollHandler = null;
  }

  if (!navItemsEl) {
    nav.style.display = 'none';
    return;
  }

  // Build or reuse nav header
  let header = nav.querySelector('.file-nav-header');
  if (!header) {
    header = document.createElement('div');
    header.className = 'file-nav-header';

    const label = document.createElement('span');
    label.className = 'file-nav-label';
    label.textContent = 'Files changed';
    header.appendChild(label);

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'file-nav-toggle';
    header.appendChild(toggleBtn);
    toggleBtn.addEventListener('click', () => {
      fileNavCollapsed = !fileNavCollapsed;
      nav.classList.toggle('collapsed', fileNavCollapsed);
      toggleBtn.textContent = fileNavCollapsed ? '▶' : '◀';
      toggleBtn.title = fileNavCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
    });
  }
  const toggleBtn = header.querySelector('.file-nav-toggle');
  toggleBtn.textContent = fileNavCollapsed ? '▶' : '◀';
  toggleBtn.title = fileNavCollapsed ? 'Expand sidebar' : 'Collapse sidebar';

  // Atomically swap to: header + new items
  nav.replaceChildren(header, navItemsEl);
  nav.style.display = '';
  nav.classList.toggle('collapsed', fileNavCollapsed);

  const navItems = navItemsEl._navItems || [];
  const blocks   = navItemsEl._blocks   || [];

  function updateActive() {
    let activeIdx = 0;
    for (let i = 0; i < blocks.length; i++) {
      const rect = blocks[i].getBoundingClientRect();
      if (rect.top <= _topBarHeight + 32) activeIdx = i;
    }
    navItems.forEach((item, i) => item.classList.toggle('active', i === activeIdx));
    const activeItem = navItems[activeIdx];
    if (activeItem) {
      const itemRect = activeItem.getBoundingClientRect();
      const navRect = nav.getBoundingClientRect();
      if (itemRect.top < navRect.top || itemRect.bottom > navRect.bottom) {
        activeItem.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  fileNavScrollHandler = updateActive;
  window.addEventListener('scroll', fileNavScrollHandler, { passive: true });
  updateActive();
}

// Kept for backward compat — builds and activates in one call.
export function renderFileNav(files, diffWrap) {
  activateFileNav(buildNavItemsEl(files, diffWrap), diffWrap);
}

// Move the file-nav selection to the adjacent file in the current patch:
// dir=-1 selects the previous file, dir=+1 the next.  Reuses each nav item's
// click handler so the diff block scrolls into view and the highlight updates
// exactly as a manual click would.  Returns true when the selection moved.
export function navigateFile(dir) {
  const nav = $('#file-nav');
  if (!nav || nav.style.display === 'none') return false;
  const items = $$('.file-nav-item', nav);
  if (items.length === 0) return false;
  let activeIdx = items.findIndex((it) => it.classList.contains('active'));
  if (activeIdx < 0) activeIdx = 0;
  const next = Math.max(0, Math.min(items.length - 1, activeIdx + dir));
  if (next === activeIdx) return false;
  items[next].click();
  return true;
}

// ── Build a patch element (detached) ────────────────────────────────────────
// Returns { el, diffWrap, navItemsEl } for the given patch index. The element
// is not yet inserted into the DOM; the caller is responsible for placement.
export function buildPatchEl(idx) {
  const patch = state.patches[idx];
  const el = document.createElement('div');
  let diffWrap = null;

  if (!patch) {
    const p = document.createElement('p');
    p.style.cssText = 'color:#8b949e;padding:16px 24px;';
    p.textContent = 'No patches found.';
    el.appendChild(p);
    return { el, diffWrap };
  }

  const isApproved = state.approved.has(patch.hash);
  const isDenied = state.denied.has(patch.hash);
  const patchNum = idx + 1;
  const total = state.patches.length;

  // Patch heading row
  const heading = document.createElement('div');
  heading.className = 'patch-heading' +
    (isApproved ? ' patch-heading-approved' : '') +
    (isDenied ? ' patch-heading-denied' : '');
  heading.innerHTML = `
    <span class="patch-heading-label">Part ${patchNum}${total > 1 ? ` of ${total}` : ''}</span>
    <span class="patch-heading-msg">${escapeHtml(patch.message)}</span>
    <span class="patch-heading-hash">${escapeHtml(patch.hash)}</span>`;

  // Approve + Skip buttons grouped at the right
  const btnGroup = document.createElement('div');
  btnGroup.className = 'patch-heading-actions';

  const approveBtn = document.createElement('button');
  approveBtn.className = isApproved ? 'btn-unapprove' : 'btn-approve';
  approveBtn.textContent = isApproved ? 'Approved ✓' : 'Approve';
  approveBtn.addEventListener('click', () => {
    const wasApproved = state.approved.has(patch.hash);
    if (wasApproved) unapprovePatch(patch.hash); else approvePatch(patch.hash);
    saveDecisionNow(patch.hash, wasApproved ? 'unapprove' : 'approve');
    renderTabs();
    renderCurrentPatch();
    updateSubmitButton();
    refreshPromptBar();
  });

  const denyBtn = document.createElement('button');
  denyBtn.className = isDenied ? 'btn-undeny' : 'btn-deny';
  denyBtn.textContent = isDenied ? 'Denied ✗' : 'Deny';
  denyBtn.addEventListener('click', () => {
    const wasDenied = state.denied.has(patch.hash);
    if (wasDenied) undenyPatch(patch.hash); else denyPatch(patch.hash);
    saveDecisionNow(patch.hash, wasDenied ? 'undeny' : 'deny');
    renderTabs();
    renderCurrentPatch();
    updateSubmitButton();
    refreshPromptBar();
  });

  btnGroup.appendChild(approveBtn);
  btnGroup.appendChild(denyBtn);
  heading.appendChild(btnGroup);
  el.appendChild(heading);

  // Revision toggle bar — shown when this patch has multiple recorded revisions
  const revList = getRevisionList(idx);
  const patchIdx = idx;
  const compareRev = state.compareRevision[patchIdx] ?? null;
  const isCompareMode = compareRev !== null;
  const selectedHash = state.showRevision[patchIdx] ?? null;
  const effectiveHash = isCompareMode ? patch.hash : (selectedHash ?? patch.hash);

  if (revList.length > 1) {
    const currentRevHash = revList[revList.length - 1].hash;

    const makeRevBarEl = (labelText, activeHash, onSelect) => {
      const bar = document.createElement('div');
      bar.className = 'revision-toggle-bar';

      const label = document.createElement('span');
      label.className = 'revision-toggle-label';
      label.textContent = labelText;
      bar.appendChild(label);

      // Buttons live in a separate inner scroll container so the label
      // is never covered and buttons fade in cleanly from the left edge.
      const scroll = document.createElement('div');
      scroll.className = 'revision-toggle-scroll';
      [...revList].reverse().forEach((rev, i) => {
        const originalIdx = revList.length - 1 - i;
        const isCurrent = (i === 0);
        const btn = document.createElement('button');
        btn.className = 'btn-toggle-revision' + (rev.hash === activeHash ? ' active' : '');
        const dateStr = rev.savedAt
          ? new Date(rev.savedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : '';
        btn.innerHTML = `<span class="rev-btn-label">Rev ${originalIdx + 1}${isCurrent ? ' · current' : ''}</span>${dateStr ? `<span class="rev-btn-date">${escapeHtml(dateStr)}</span>` : ''}`;
        btn.title = rev.hash;
        btn.addEventListener('click', () => onSelect(rev.hash));
        scroll.appendChild(btn);
      });
      bar.appendChild(scroll);
      addDragScroll(scroll);
      const updateMask = () => {
        scroll.style.maskImage = scroll.scrollLeft > 0
          ? 'linear-gradient(to right, transparent 0px, black 28px)'
          : '';
      };
      scroll.addEventListener('scroll', updateMask, { passive: true });
      updateMask();
      return bar;
    };

    if (isCompareMode) {
      const exitBtn = document.createElement('button');
      exitBtn.className = 'btn-compare-toggle active';
      exitBtn.title = 'Exit compare mode';
      exitBtn.textContent = '⇄';
      exitBtn.addEventListener('click', () => {
        delete state.compareRevision[patchIdx];
        renderCurrentPatch();
      });

      const fromIdx = revList.findIndex((r) => r.hash === compareRev.from);
      const toIdx   = revList.findIndex((r) => r.hash === compareRev.to);
      const fromLabelText = `From: Rev ${fromIdx + 1} ·`;
      const toLabelText   = `To: Rev ${toIdx + 1}${toIdx === revList.length - 1 ? ' · current' : ''} ·`;

      const fromBar = makeRevBarEl(fromLabelText, compareRev.from, (hash) => {
        state.compareRevision[patchIdx] = { from: hash, to: state.compareRevision[patchIdx].to };
        renderCurrentPatch();
      });
      fromBar.insertBefore(exitBtn, fromBar.querySelector('.revision-toggle-scroll'));

      const toBar = makeRevBarEl(toLabelText, compareRev.to, (hash) => {
        state.compareRevision[patchIdx] = { from: state.compareRevision[patchIdx].from, to: hash };
        renderCurrentPatch();
      });

      el.appendChild(fromBar);
      el.appendChild(toBar);
    } else {
      const compareBtn = document.createElement('button');
      compareBtn.className = 'btn-compare-toggle';
      compareBtn.title = 'Compare two revisions';
      compareBtn.textContent = '⇄';
      compareBtn.addEventListener('click', () => {
        state.compareRevision[patchIdx] = { from: revList[0].hash, to: currentRevHash };
        renderCurrentPatch();
      });

      const revBar = makeRevBarEl('Revision:', effectiveHash, (hash) => {
        state.showRevision[patchIdx] = (hash === currentRevHash) ? null : hash;
        renderCurrentPatch();
        renderTabs();
      });
      revBar.insertBefore(compareBtn, revBar.querySelector('.revision-toggle-scroll'));
      el.appendChild(revBar);
    }
  }

  // Commit message section — always shown, disabled when approved
  renderCommitMessageSection(el, patch.hash, patch.body || patch.message, isApproved);

  // General comment box (always shown so user can read it even when skipped/approved)
  const generalBox = document.createElement('div');
  generalBox.className = 'general-comment-box';
  generalBox.innerHTML = `
    <div class="general-comment-label">
      General feedback for Part ${patchNum}
      <span class="general-comment-hint">Feedback here is scoped to this patch only. Use this for overall concerns not tied to a specific line.</span>
    </div>
    <textarea class="general-comment-textarea" placeholder="e.g. This approach should use RAII. Please refactor the error handling throughout this patch…">${escapeHtml(getGeneralComment(patch.hash))}</textarea>`;
  el.appendChild(generalBox);

  const textarea = generalBox.querySelector('textarea');
  if (isApproved) textarea.disabled = true;
  textarea.addEventListener('input', () => {
    setGeneralComment(patch.hash, textarea.value);
    scheduleGeneralCommentSave(patch.hash, textarea.value);
    updateSubmitButton();
  });

  // Comments summary — lists all line-level and commit-message comments with scroll-to links
  const patchCommentsByFile = state.comments[patch.hash] || {};
  const allLineComments = [];
  for (const [filePath, byKey] of Object.entries(patchCommentsByFile)) {
    if (filePath === COMMIT_FILE) continue;
    for (const [key, commentObj] of Object.entries(byKey)) {
      allLineComments.push({ key, ...commentObj });
    }
  }
  const commitComment = getComment(patch.hash, COMMIT_FILE, COMMIT_KEY);
  const totalCommentCount = allLineComments.length + (commitComment ? 1 : 0);

  if (totalCommentCount > 0) {
    const summaryBox = document.createElement('div');
    summaryBox.className = 'comments-summary-box';

    const summaryLabel = document.createElement('div');
    summaryLabel.className = 'comments-summary-label';
    summaryLabel.textContent = `Your comments (${totalCommentCount})`;
    summaryBox.appendChild(summaryLabel);

    const summaryList = document.createElement('ul');
    summaryList.className = 'comments-summary-list';

    if (commitComment) {
      const item = document.createElement('li');
      item.className = 'comments-summary-item';
      item.innerHTML = `
        <span class="comments-summary-location">Commit message</span>
        <span class="comments-summary-text">${escapeHtml(commitComment.text)}</span>`;
      item.addEventListener('click', () => {
        const block = el.querySelector('.commit-msg-block');
        if (block) block.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      summaryList.appendChild(item);
    }

    for (const c of allLineComments) {
      const shortFile = c.file.split('/').pop();
      const item = document.createElement('li');
      item.className = 'comments-summary-item';
      item.innerHTML = `
        <span class="comments-summary-location">${escapeHtml(shortFile)}:${c.line}</span>
        <span class="comments-summary-text">${escapeHtml(c.text)}</span>`;
      item.addEventListener('click', () => {
        const allTrs = el.querySelectorAll('tr[data-line-key]');
        const tr = Array.from(allTrs).find(
          (r) => r.dataset.filePath === c.file && r.dataset.lineKey === c.key
        );
        if (!tr) return;
        const next = tr.nextElementSibling;
        const target = (next && next.classList.contains('comment-display-row')) ? next : tr;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('comment-scroll-highlight');
        setTimeout(() => target.classList.remove('comment-scroll-highlight'), 1500);
      });
      summaryList.appendChild(item);
    }

    summaryBox.appendChild(summaryList);
    el.appendChild(summaryBox);
  }

  // Deny notice — show below general comment box but before diff
  if (isDenied) {
    const denyNotice = document.createElement('div');
    denyNotice.className = 'deny-notice';
    denyNotice.innerHTML = `
      <span class="deny-notice-icon">✗</span>
      <span>This patch was denied — it requires significant changes. Add comments above to explain.</span>`;
    el.appendChild(denyNotice);
  }

  // Approved notice — shown above the diff (diff still visible but read-only)
  if (isApproved) {
    const notice = document.createElement('div');
    notice.className = 'approve-notice';
    notice.innerHTML = `
      <span class="approve-notice-icon">✓</span>
      <span>This patch was approved — no issues found. Click <strong>Approved ✓</strong> to undo.</span>`;
    el.appendChild(notice);
  }

  if (isCompareMode) {
    const fromIdx = revList.findIndex((r) => r.hash === compareRev.from);
    const toIdx   = revList.findIndex((r) => r.hash === compareRev.to);
    const fromLabel = fromIdx >= 0 ? `Rev ${fromIdx + 1}` : compareRev.from;
    const toLabel   = toIdx   >= 0 ? `Rev ${toIdx   + 1}` : compareRev.to;

    const compareHeader = document.createElement('div');
    compareHeader.className = 'diff-revision-header diff-revision-compare';
    compareHeader.textContent = `Comparing ${fromLabel} → ${toLabel}`;
    el.appendChild(compareHeader);

    const placeholder = document.createElement('div');
    placeholder.className = 'diff-revision-loading';
    placeholder.textContent = 'Loading comparison…';
    el.appendChild(placeholder);

    fetch(`/api/revdiff?from=${compareRev.from}&to=${compareRev.to}`)
      .then((r) => r.json())
      .then((data) => {
        placeholder.remove();
        if (data.error) {
          const err = document.createElement('p');
          err.style.cssText = 'color:#f85149;padding:8px 24px;';
          err.textContent = `Could not load comparison: ${data.error}`;
          el.appendChild(err);
          return;
        }
        if ((data.files || []).length === 0) {
          const msg = document.createElement('p');
          msg.style.cssText = 'color:#8b949e;padding:16px 24px;';
          msg.textContent = 'No differences between these revisions.';
          el.appendChild(msg);
          return;
        }
        const wrap = document.createElement('div');
        wrap.className = 'diff-compare-readonly';
        for (const fileData of data.files) {
          wrap.appendChild(renderFile(fileData, `compare:${compareRev.from}:${compareRev.to}`));
        }
        el.appendChild(wrap);
      })
      .catch(() => {
        placeholder.textContent = 'Failed to load comparison.';
      });
  } else if (effectiveHash !== patch.hash) {
    const revIdx = revList.findIndex((r) => r.hash === effectiveHash);
    const revLabel = revIdx >= 0 ? `Rev ${revIdx + 1}` : 'Previous revision';
    const prevHeader = document.createElement('div');
    prevHeader.className = 'diff-revision-header diff-revision-previous';
    prevHeader.textContent = `${revLabel} — ${effectiveHash}`;
    el.appendChild(prevHeader);

    const placeholder = document.createElement('div');
    placeholder.className = 'diff-revision-loading';
    placeholder.textContent = 'Loading revision…';
    el.appendChild(placeholder);

    fetch(`/api/patchdiff/${effectiveHash}`)
      .then((r) => r.json())
      .then((data) => {
        placeholder.remove();
        if (data.error) {
          const err = document.createElement('p');
          err.style.cssText = 'color:#f85149;padding:8px 24px;';
          err.textContent = `Could not load revision: ${data.error}`;
          el.appendChild(err);
          return;
        }
        for (const fileData of (data.files || [])) {
          const block = renderFile(fileData, effectiveHash);
          block.classList.add('diff-previous-revision');
          el.appendChild(block);
        }
      })
      .catch(() => {
        placeholder.textContent = 'Failed to load revision.';
      });
  } else {
    if (patch.files.length === 0) {
      const msg = document.createElement('p');
      msg.style.cssText = 'color:#8b949e;padding:8px 0;';
      msg.textContent = 'No changed files in this patch.';
      el.appendChild(msg);
    } else {
      diffWrap = document.createElement('div');
      if (isApproved) diffWrap.className = 'diff-approved-readonly';
      for (const fileData of patch.files) {
        diffWrap.appendChild(renderFile(fileData, patch.hash));
      }
      el.appendChild(diffWrap);
    }
  }

  const navItemsEl = buildNavItemsEl(patch.files, diffWrap);
  return { el, diffWrap, navItemsEl };
}

// Re-render the current patch in-place (called when approve/deny/comment state changes).
export function renderCurrentPatch() {
  const idx = state.currentPatchIdx;
  const { el, diffWrap, navItemsEl } = buildPatchEl(idx);
  const existing = patchEls[idx];
  patchEls[idx] = { el, diffWrap, navItemsEl };
  if (existing) {
    existing.el.replaceWith(el);
  } else {
    $('#files-changed').appendChild(el);
  }
  activateFileNav(navItemsEl, diffWrap);
}

// Build all patch elements and insert them into #files-changed.
// Called once after the initial diff load; tab switches use show/hide after this.
export function initPatchNodes() {
  const container = $('#files-changed');
  patchEls.length = 0;

  if (state.patches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-worktree';
    empty.innerHTML = `
      <div class="empty-worktree-icon">○</div>
      <p class="empty-worktree-title">No changes</p>
      <p class="empty-worktree-subtitle">This worktree has no patches to review.</p>`;
    container.replaceChildren(empty);
    activateFileNav(null, null);
    return;
  }

  const frag = document.createDocumentFragment();
  for (let i = 0; i < state.patches.length; i++) {
    const { el, diffWrap, navItemsEl } = buildPatchEl(i);
    el.style.display = i === state.currentPatchIdx ? '' : 'none';
    patchEls.push({ el, diffWrap, navItemsEl });
    frag.appendChild(el);
  }
  container.replaceChildren(frag);
  const cur = patchEls[state.currentPatchIdx];
  activateFileNav(cur?.navItemsEl || null, cur?.diffWrap || null);
}

// ── Drag-to-scroll (shared) ─────────────────────────────────────────────────
export function addDragScroll(el) {
  let dragging = false;
  let startX = 0;
  let startScroll = 0;

  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startScroll = el.scrollLeft;
    el.style.cursor = 'grabbing';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging || !el.isConnected) { dragging = false; return; }
    el.scrollLeft = startScroll - (e.clientX - startX);
  });

  document.addEventListener('mouseup', () => {
    if (!dragging || !el.isConnected) { dragging = false; return; }
    dragging = false;
    el.style.cursor = '';
  });
}

export function initTabsDragScroll() {
  const bar = $('#patch-tabs-bar');
  if (bar) addDragScroll(bar);
}

export function getFileNavCollapsed() { return fileNavCollapsed; }
export function setFileNavCollapsed(v) { fileNavCollapsed = v; }

// Allow unit tests to import without a full browser environment.
if (typeof module !== 'undefined') {
  module.exports = {
    patchEls, updateSubmitButton, removeExistingForm, showCommentForm,
    renderCommentDisplay, renderDraftDisplay, restoreLineDisplay,
    renderCommitMessageSection,
    renderExpandRow, countStats, renderFile,
    renderTabs, switchPatch,
    buildNavItemsEl, activateFileNav, renderFileNav, navigateFile,
    buildPatchEl, renderCurrentPatch, initPatchNodes,
    addDragScroll, initTabsDragScroll,
    getFileNavCollapsed, setFileNavCollapsed,
    setupStickySidebarOffset,
  };
}

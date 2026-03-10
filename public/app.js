'use strict';

// ── State ──────────────────────────────────────────────────────────────────
// comments[patchHash][filePath][lineKey] = { file, line, lineContent, text, patchHash }
// generalComments[patchHash] = string
const state = {
  comments: {},
  generalComments: {},  // free-form patch-level feedback, keyed by patchHash
  approved: new Set(),  // patchHashes the reviewer approved
  denied: new Set(),    // patchHashes the reviewer denied
  patches: [],
  currentPatchIdx: 0,
  revisions: [],        // [{ savedAt, patches: [{hash, message}] }] — persisted
  updatedPatches: {},   // { patchIdx: { oldHash, oldMessage } } — computed on init, not persisted
  showRevision: {},     // { patchIdx: hash | null } — null means current; ephemeral toggle state
  compareRevision: {},  // { patchIdx: { from: hash, to: hash } | absent } — compare mode
};

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

// ── Comment draft cache ────────────────────────────────────────────────────
// Keyed by "patchHash/filePath/lineKey". Drafts survive form close/cancel
// and are cleared only when the comment is saved.
const drafts = {};

function draftKey(patchHash, filePath, key) {
  return `${patchHash}/${filePath}/${key}`;
}

// ── Auto-save ──────────────────────────────────────────────────────────────
let saveTimer = null;
let savedPromptText = null;

function scheduleAutoSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 500);
}

async function saveState() {
  const indicator = $('#autosave-status');
  if (indicator) indicator.textContent = 'Saving…';
  try {
    await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        comments: state.comments,
        generalComments: state.generalComments,
        approved: [...state.approved],
        denied: [...state.denied],
        revisions: state.revisions,
      }),
    });
    if (indicator) {
      indicator.textContent = 'Saved';
      setTimeout(() => { if (indicator) indicator.textContent = ''; }, 2000);
    }
  } catch {
    if (indicator) indicator.textContent = 'Save failed';
  }
}

function allPatchesFinished() {
  return state.patches.length > 0 && state.patches.every(
    (p) => state.approved.has(p.hash) || state.denied.has(p.hash)
  );
}

function updateCurrentPrompt(prompt) {
  savedPromptText = prompt;
  refreshPromptBar();
}

function refreshPromptBar() {
  const bar = $('#current-prompt-bar');
  if (!bar) return;
  if (savedPromptText && allPatchesFinished()) {
    bar.dataset.prompt = savedPromptText;
    bar.style.display = '';
  } else {
    bar.style.display = 'none';
  }
}

// ── Comment management ─────────────────────────────────────────────────────
function lineKey(line) {
  return line.newLineNum != null ? `n${line.newLineNum}` : `r${line.oldLineNum}`;
}

function getComment(patchHash, filePath, key) {
  return ((state.comments[patchHash] || {})[filePath] || {})[key] || null;
}

function setComment(patchHash, filePath, key, commentObj) {
  if (!state.comments[patchHash]) state.comments[patchHash] = {};
  if (!state.comments[patchHash][filePath]) state.comments[patchHash][filePath] = {};
  state.comments[patchHash][filePath][key] = commentObj;
  updateSubmitButton();
  scheduleAutoSave();
}

function deleteComment(patchHash, filePath, key) {
  const byFile = (state.comments[patchHash] || {});
  if (byFile[filePath]) {
    delete byFile[filePath][key];
    if (Object.keys(byFile[filePath]).length === 0) delete byFile[filePath];
  }
  updateSubmitButton();
  scheduleAutoSave();
}

function commentsForPatch(patchHash) {
  const list = [];
  const byFile = state.comments[patchHash] || {};
  for (const filePath of Object.keys(byFile)) {
    for (const key of Object.keys(byFile[filePath])) {
      list.push(byFile[filePath][key]);
    }
  }
  return list;
}

function currentPatch() {
  return state.patches[state.currentPatchIdx] || null;
}

function getGeneralComment(patchHash) {
  return state.generalComments[patchHash] || '';
}

function setGeneralComment(patchHash, text) {
  state.generalComments[patchHash] = text;
  updateSubmitButton();
  scheduleAutoSave();
}

// ── Deny management ────────────────────────────────────────────────────────
function denyPatch(hash) {
  state.denied.add(hash);
  renderTabs();
  renderCurrentPatch();
  updateSubmitButton();
  refreshPromptBar();
  scheduleAutoSave();
}

function undenyPatch(hash) {
  state.denied.delete(hash);
  renderTabs();
  renderCurrentPatch();
  updateSubmitButton();
  refreshPromptBar();
  scheduleAutoSave();
}

// ── Approve management ─────────────────────────────────────────────────────
function approvePatch(hash) {
  state.approved.add(hash);
  renderTabs();
  renderCurrentPatch();
  updateSubmitButton();
  refreshPromptBar();
  scheduleAutoSave();
}

function unapprovePatch(hash) {
  state.approved.delete(hash);
  renderTabs();
  renderCurrentPatch();
  updateSubmitButton();
  refreshPromptBar();
  scheduleAutoSave();
}

// ── Submit button state ────────────────────────────────────────────────────
function updateSubmitButton() {
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
function removeExistingForm() {
  const existing = $('.comment-form-row');
  if (existing) existing.remove();
}

function showCommentForm(tr, patchHash, filePath, line, key) {
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

  const textarea = formRow.querySelector('textarea');
  const dk = draftKey(patchHash, filePath, key);
  const existing = getComment(patchHash, filePath, key);
  textarea.value = existing ? existing.text : (drafts[dk] || '');
  textarea.focus();

  textarea.addEventListener('input', () => { drafts[dk] = textarea.value; });

  formRow.querySelector('.btn-cancel').addEventListener('click', () => formRow.remove());

  formRow.querySelector('.btn-discard').addEventListener('click', () => {
    delete drafts[dk];
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
    formRow.remove();
    renderCommentDisplay(tr, patchHash, filePath, line, key);
  });
}

function renderCommentDisplay(trLine, patchHash, filePath, line, key) {
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
    displayRow.remove();
  });

  displayRow.querySelector('.comment-body').style.cursor = 'pointer';
  displayRow.querySelector('.comment-body').addEventListener('click', () => {
    displayRow.remove();
    showCommentForm(trLine, patchHash, filePath, line, key);
  });
}

// ── Commit message comment section ─────────────────────────────────────────
const COMMIT_FILE = '__commit__';
const COMMIT_KEY  = 'msg';

function renderCommitMessageSection(container, patchHash, commitMessage, disabled) {
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
    const c = getComment(patchHash, COMMIT_FILE, COMMIT_KEY);
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
      refreshComment();
    });
    const body = commentEl.querySelector('.comment-body');
    body.style.cursor = 'pointer';
    body.addEventListener('click', showForm);
  }

  function showForm() {
    if (disabled) return;
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
    ta.addEventListener('input', () => { drafts[dk] = ta.value; });
    formEl.querySelector('.btn-cancel').addEventListener('click', () => { formEl.innerHTML = ''; });
    formEl.querySelector('.btn-discard').addEventListener('click', () => { delete drafts[dk]; formEl.innerHTML = ''; });
    formEl.querySelector('.btn-save').addEventListener('click', () => {
      const text = ta.value.trim();
      if (!text) return;
      delete drafts[dk];
      setComment(patchHash, COMMIT_FILE, COMMIT_KEY, {
        patchHash, file: COMMIT_FILE, line: 0, lineContent: commitMessage, text,
      });
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
function countStats(hunks) {
  let added = 0, removed = 0;
  for (const hunk of hunks) {
    for (const l of hunk.lines) {
      if (l.type === 'added') added++;
      else if (l.type === 'removed') removed++;
    }
  }
  return { added, removed };
}

function renderFile(fileData, patchHash) {
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

  for (const hunk of fileData.hunks) {
    const hunkTr = document.createElement('tr');
    hunkTr.className = 'hunk-header';
    hunkTr.innerHTML = `<td colspan="3">${escapeHtml(hunk.header)}</td>`;
    table.appendChild(hunkTr);

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
      tr.querySelector('.ln-content').addEventListener('click', () => {
        const next = tr.nextElementSibling;
        if (next && next.classList.contains('comment-form-row')) {
          next.remove();
          return;
        }
        removeExistingForm();
        showCommentForm(tr, patchHash, filePath, line, key);
      });

      table.appendChild(tr);

      if (getComment(patchHash, filePath, key)) {
        renderCommentDisplay(tr, patchHash, filePath, line, key);
      }
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

// ── Revision detection ─────────────────────────────────────────────────────
function detectRevisionChanges() {
  if (state.patches.length === 0) return;

  const lastRevision = state.revisions[state.revisions.length - 1];
  const currentSnapshot = state.patches.map((p) => ({ hash: p.hash, message: p.message }));

  if (!lastRevision) {
    // First time — record baseline, nothing to compare against
    state.revisions.push({ savedAt: new Date().toISOString(), patches: currentSnapshot });
    scheduleAutoSave();
    return;
  }

  let hasChanges = false;
  const prevPatches = lastRevision.patches;
  for (let i = 0; i < Math.max(state.patches.length, prevPatches.length); i++) {
    const curr = state.patches[i];
    const prev = prevPatches[i];
    if (!curr || !prev || curr.hash !== prev.hash) {
      if (curr && prev) {
        state.updatedPatches[i] = { oldHash: prev.hash, oldMessage: prev.message };
      }
      hasChanges = true;
    }
  }

  if (hasChanges) {
    state.revisions.push({ savedAt: new Date().toISOString(), patches: currentSnapshot });
    if (state.revisions.length > 10) state.revisions = state.revisions.slice(-10);
    scheduleAutoSave();
  }
}

// Returns [{hash, savedAt}] ordered oldest-to-newest for the given patch position.
// The last entry is always the current revision.
function getRevisionList(patchIdx) {
  const seen = new Set();
  const list = [];
  for (const rev of state.revisions) {
    const p = rev.patches[patchIdx];
    if (p && !seen.has(p.hash)) {
      seen.add(p.hash);
      list.push({ hash: p.hash, savedAt: rev.savedAt });
    }
  }
  return list;
}

// ── Patch tab rendering ─────────────────────────────────────────────────────
function renderTabs() {
  const tabsBar = $('#patch-tabs-bar');
  const tabsEl = $('#patch-tabs');
  tabsEl.innerHTML = '';

  if (state.patches.length <= 1) {
    tabsBar.style.display = 'none';
    return;
  }

  tabsBar.style.display = '';

  state.patches.forEach((patch, idx) => {
    const isApproved = state.approved.has(patch.hash);
    const isDenied = state.denied.has(patch.hash);
    const commentCount = commentsForPatch(patch.hash).length;

    const tab = document.createElement('button');
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
    tab.addEventListener('click', () => switchPatch(idx));
    tabsEl.appendChild(tab);
  });
}

function switchPatch(idx) {
  removeExistingForm();
  state.currentPatchIdx = idx;
  renderCurrentPatch();
  renderTabs();
  updateSubmitButton();
}

function renderCurrentPatch() {
  const patch = currentPatch();
  const container = $('#files-changed');
  container.innerHTML = '';

  if (!patch) {
    container.innerHTML = '<p style="color:#8b949e;padding:16px 24px;">No patches found.</p>';
    return;
  }

  const isApproved = state.approved.has(patch.hash);
  const isDenied = state.denied.has(patch.hash);
  const patchNum = state.currentPatchIdx + 1;
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
    if (state.approved.has(patch.hash)) {
      unapprovePatch(patch.hash);
    } else {
      approvePatch(patch.hash);
    }
  });

  const denyBtn = document.createElement('button');
  denyBtn.className = isDenied ? 'btn-undeny' : 'btn-deny';
  denyBtn.textContent = isDenied ? 'Denied ✗' : 'Deny';
  denyBtn.addEventListener('click', () => {
    if (state.denied.has(patch.hash)) {
      undenyPatch(patch.hash);
    } else {
      denyPatch(patch.hash);
    }
  });

  btnGroup.appendChild(approveBtn);
  btnGroup.appendChild(denyBtn);
  heading.appendChild(btnGroup);
  container.appendChild(heading);

  // Revision toggle bar — shown when this patch has multiple recorded revisions
  const revList = getRevisionList(state.currentPatchIdx);
  const patchIdx = state.currentPatchIdx;
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
      revList.forEach((rev, i) => {
        const isCurrent = (i === revList.length - 1);
        const btn = document.createElement('button');
        btn.className = 'btn-toggle-revision' + (rev.hash === activeHash ? ' active' : '');
        const dateStr = rev.savedAt
          ? new Date(rev.savedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : '';
        btn.innerHTML = `<span class="rev-btn-label">Rev ${i + 1}${isCurrent ? ' · current' : ''}</span>${dateStr ? `<span class="rev-btn-date">${escapeHtml(dateStr)}</span>` : ''}`;
        btn.title = rev.hash;
        btn.addEventListener('click', () => onSelect(rev.hash));
        scroll.appendChild(btn);
      });
      bar.appendChild(scroll);
      addDragScroll(scroll);
      requestAnimationFrame(() => { scroll.scrollLeft = scroll.scrollWidth; });
      bar._scroll = scroll; // expose scroll container for extra button appends
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
      fromBar._scroll.appendChild(exitBtn);

      const toBar = makeRevBarEl(toLabelText, compareRev.to, (hash) => {
        state.compareRevision[patchIdx] = { from: state.compareRevision[patchIdx].from, to: hash };
        renderCurrentPatch();
      });

      container.appendChild(fromBar);
      container.appendChild(toBar);
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
      revBar._scroll.appendChild(compareBtn);
      container.appendChild(revBar);
    }
  }

  // Commit message section — always shown, disabled when approved
  renderCommitMessageSection(container, patch.hash, patch.body || patch.message, isApproved);

  // General comment box (always shown so user can read it even when skipped/approved)
  const generalBox = document.createElement('div');
  generalBox.className = 'general-comment-box';
  generalBox.innerHTML = `
    <div class="general-comment-label">
      General feedback for Part ${patchNum}
      <span class="general-comment-hint">Feedback here is scoped to this patch only. Use this for overall concerns not tied to a specific line.</span>
    </div>
    <textarea class="general-comment-textarea" placeholder="e.g. This approach should use RAII. Please refactor the error handling throughout this patch…">${escapeHtml(getGeneralComment(patch.hash))}</textarea>`;
  container.appendChild(generalBox);

  const textarea = generalBox.querySelector('textarea');
  if (isApproved) textarea.disabled = true;
  textarea.addEventListener('input', () => setGeneralComment(patch.hash, textarea.value));

  // Deny notice — show below general comment box but before diff
  if (isDenied) {
    const denyNotice = document.createElement('div');
    denyNotice.className = 'deny-notice';
    denyNotice.innerHTML = `
      <span class="deny-notice-icon">✗</span>
      <span>This patch was denied — it requires significant changes. Add comments above to explain.</span>`;
    container.appendChild(denyNotice);
  }

  // Approved notice — shown above the diff (diff still visible but read-only)
  if (isApproved) {
    const notice = document.createElement('div');
    notice.className = 'approve-notice';
    notice.innerHTML = `
      <span class="approve-notice-icon">✓</span>
      <span>This patch was approved — no issues found. Click <strong>Approved ✓</strong> to undo.</span>`;
    container.appendChild(notice);
  }

  if (isCompareMode) {
    const fromIdx = revList.findIndex((r) => r.hash === compareRev.from);
    const toIdx   = revList.findIndex((r) => r.hash === compareRev.to);
    const fromLabel = fromIdx >= 0 ? `Rev ${fromIdx + 1}` : compareRev.from;
    const toLabel   = toIdx   >= 0 ? `Rev ${toIdx   + 1}` : compareRev.to;

    const compareHeader = document.createElement('div');
    compareHeader.className = 'diff-revision-header diff-revision-compare';
    compareHeader.textContent = `Comparing ${fromLabel} → ${toLabel}`;
    container.appendChild(compareHeader);

    const placeholder = document.createElement('div');
    placeholder.className = 'diff-revision-loading';
    placeholder.textContent = 'Loading comparison…';
    container.appendChild(placeholder);

    fetch(`/api/revdiff?from=${compareRev.from}&to=${compareRev.to}`)
      .then((r) => r.json())
      .then((data) => {
        placeholder.remove();
        if (data.error) {
          const err = document.createElement('p');
          err.style.cssText = 'color:#f85149;padding:8px 24px;';
          err.textContent = `Could not load comparison: ${data.error}`;
          container.appendChild(err);
          return;
        }
        if ((data.files || []).length === 0) {
          const msg = document.createElement('p');
          msg.style.cssText = 'color:#8b949e;padding:16px 24px;';
          msg.textContent = 'No differences between these revisions.';
          container.appendChild(msg);
          return;
        }
        const wrap = document.createElement('div');
        wrap.className = 'diff-compare-readonly';
        for (const fileData of data.files) {
          wrap.appendChild(renderFile(fileData, `compare:${compareRev.from}:${compareRev.to}`));
        }
        container.appendChild(wrap);
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
    container.appendChild(prevHeader);

    const placeholder = document.createElement('div');
    placeholder.className = 'diff-revision-loading';
    placeholder.textContent = 'Loading revision…';
    container.appendChild(placeholder);

    fetch(`/api/patchdiff/${effectiveHash}`)
      .then((r) => r.json())
      .then((data) => {
        placeholder.remove();
        if (data.error) {
          const err = document.createElement('p');
          err.style.cssText = 'color:#f85149;padding:8px 24px;';
          err.textContent = `Could not load revision: ${data.error}`;
          container.appendChild(err);
          return;
        }
        for (const fileData of (data.files || [])) {
          const block = renderFile(fileData, effectiveHash);
          block.classList.add('diff-previous-revision');
          container.appendChild(block);
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
      container.appendChild(msg);
    } else {
      const diffWrap = document.createElement('div');
      if (isApproved) diffWrap.className = 'diff-approved-readonly';
      for (const fileData of patch.files) {
        diffWrap.appendChild(renderFile(fileData, patch.hash));
      }
      container.appendChild(diffWrap);
    }
  }
}

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

    renderTabs();
  } catch (err) {
    const warn = $('#submit-warning');
    if (warn) warn.textContent = `Error: ${err.message}`;
  } finally {
    btn.textContent = 'Generate Review Prompt';
    updateSubmitButton();
  }
}

// ── Drag-to-scroll (shared) ─────────────────────────────────────────────────
function addDragScroll(el) {
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
    if (!dragging) return;
    el.scrollLeft = startScroll - (e.clientX - startX);
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    el.style.cursor = '';
  });
}

function initTabsDragScroll() {
  const bar = $('#patch-tabs-bar');
  if (bar) addDragScroll(bar);
}

// ── Boot ───────────────────────────────────────────────────────────────────
async function init() {
  updateSubmitButton();

  $('#btn-submit').addEventListener('click', submitReview);
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

  const loading = $('#loading');
  const errorMsg = $('#error-msg');
  const filesChanged = $('#files-changed');

  try {
    const [diffRes, stateRes] = await Promise.all([fetch('/api/diff'), fetch('/api/state')]);

    const data = await diffRes.json();
    if (!diffRes.ok) throw new Error(data.error || 'Failed to load diff');

    if (stateRes.ok) {
      const saved = await stateRes.json();
      if (saved.comments) state.comments = saved.comments;
      if (saved.generalComments) state.generalComments = saved.generalComments;
      if (saved.approved) state.approved = new Set(saved.approved);
      if (saved.denied) state.denied = new Set(saved.denied);
      if (saved.prompt) savedPromptText = saved.prompt;
      if (saved.revisions) state.revisions = saved.revisions;
    }

    state.patches = data.patches || [];
    state.currentPatchIdx = 0;

    $('#bug-id-display').textContent = data.worktreeName;
    $('#worktree-path').textContent = data.worktreePath;

    loading.style.display = 'none';
    filesChanged.style.display = '';

    detectRevisionChanges();
    renderTabs();
    renderCurrentPatch();
    updateSubmitButton();
    refreshPromptBar();
  } catch (err) {
    loading.style.display = 'none';
    errorMsg.style.display = '';
    errorMsg.textContent = `Error loading diff: ${err.message}`;
  }
}

// ── Update detection ───────────────────────────────────────────────────────
// Polls /api/headhash every 5 seconds; shows a reload banner when the
// worktree HEAD changes (i.e. commits were amended or added).
async function startUpdatePolling() {
  let initialHash = null;
  try {
    const res = await fetch('/api/headhash');
    if (!res.ok) return;
    ({ hash: initialHash } = await res.json());
  } catch {
    return; // endpoint unavailable (e.g. demo mode) — silently skip
  }

  setInterval(async () => {
    try {
      const res = await fetch('/api/headhash');
      if (!res.ok) return;
      const { hash } = await res.json();
      if (hash !== initialHash) {
        $('#update-banner').style.display = '';
      }
    } catch { /* ignore network errors */ }
  }, 5000);
}

document.addEventListener('DOMContentLoaded', () => {
  init();
  startUpdatePolling();
  $('#btn-reload-page').addEventListener('click', () => location.reload());
});


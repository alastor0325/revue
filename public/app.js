'use strict';

// ── State ──────────────────────────────────────────────────────────────────
// comments[patchHash][filePath][lineKey] = { file, line, lineContent, text, patchHash }
// generalComments[patchHash] = string
const state = {
  comments: {},
  generalComments: {},  // free-form patch-level feedback, keyed by patchHash
  skipped: new Set(),   // patchHashes the reviewer chose to skip
  approved: new Set(),  // patchHashes the reviewer approved
  denied: new Set(),    // patchHashes the reviewer denied
  patches: [],
  currentPatchIdx: 0,
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

// ── Auto-save ──────────────────────────────────────────────────────────────
let saveTimer = null;

function scheduleAutoSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 500);
}

async function saveState() {
  const indicator = $('#autosave-status');
  if (indicator) indicator.textContent = 'Saving…';
  try {
    const res = await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        comments: state.comments,
        generalComments: state.generalComments,
        skipped: [...state.skipped],
        approved: [...state.approved],
        denied: [...state.denied],
      }),
    });
    const data = await res.json();
    if (data.prompt) updateCurrentPrompt(data.prompt);
    if (indicator) {
      indicator.textContent = 'Saved';
      setTimeout(() => { if (indicator) indicator.textContent = ''; }, 2000);
    }
  } catch {
    if (indicator) indicator.textContent = 'Save failed';
  }
}

function updateCurrentPrompt(prompt) {
  const bar = $('#current-prompt-bar');
  if (!bar) return;
  bar.dataset.prompt = prompt;
  bar.style.display = '';
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

// ── Skip management ────────────────────────────────────────────────────────
function skipPatch(hash) {
  state.skipped.add(hash);
  renderTabs();
  renderCurrentPatch();
  updateSubmitButton();
  scheduleAutoSave();
}

function unskipPatch(hash) {
  state.skipped.delete(hash);
  renderTabs();
  renderCurrentPatch();
  updateSubmitButton();
  scheduleAutoSave();
}

// ── Deny management ────────────────────────────────────────────────────────
function denyPatch(hash) {
  state.denied.add(hash);
  renderTabs();
  renderCurrentPatch();
  updateSubmitButton();
  scheduleAutoSave();
}

function undenyPatch(hash) {
  state.denied.delete(hash);
  renderTabs();
  renderCurrentPatch();
  updateSubmitButton();
  scheduleAutoSave();
}

// ── Approve management ─────────────────────────────────────────────────────
function approvePatch(hash) {
  state.approved.add(hash);
  renderTabs();
  renderCurrentPatch();
  updateSubmitButton();
  scheduleAutoSave();
}

function unapprovePatch(hash) {
  state.approved.delete(hash);
  renderTabs();
  renderCurrentPatch();
  updateSubmitButton();
  scheduleAutoSave();
}

// ── Submit button state ────────────────────────────────────────────────────
function updateSubmitButton() {
  const btn = $('#btn-submit');
  const warn = $('#submit-warning');
  const patch = currentPatch();
  if (!patch) return;

  const isSkipped = state.skipped.has(patch.hash);
  const isApproved = state.approved.has(patch.hash);
  const isDenied = state.denied.has(patch.hash);
  const count = commentsForPatch(patch.hash).length;
  const patchLabel = state.patches.length > 1 ? ` for Part ${state.currentPatchIdx + 1}` : '';

  btn.textContent = `Submit Review${patchLabel} to Claude`;

  const generalComment = getGeneralComment(patch.hash).trim();
  const hasFeedback = count > 0 || generalComment.length > 0;

  if (isSkipped) {
    btn.disabled = true;
    warn.textContent = 'Patch skipped — no review to submit';
  } else if (isApproved) {
    btn.disabled = true;
    warn.textContent = 'Patch approved — no issues to submit';
  } else if (isDenied && !hasFeedback) {
    btn.disabled = true;
    warn.textContent = 'Patch denied — add comments to explain';
  } else if (isDenied && hasFeedback) {
    btn.disabled = false;
    const parts = [];
    if (generalComment) parts.push('general feedback');
    if (count > 0) parts.push(`${count} line comment${count !== 1 ? 's' : ''}`);
    warn.textContent = parts.join(' + ') + ' ready (denied)';
  } else if (!hasFeedback) {
    btn.disabled = true;
    warn.textContent = 'Add a general comment or click a line to comment';
  } else {
    btn.disabled = false;
    const parts = [];
    if (generalComment) parts.push('general feedback');
    if (count > 0) parts.push(`${count} line comment${count !== 1 ? 's' : ''}`);
    warn.textContent = parts.join(' + ') + ' ready';
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
          <button class="btn-save">Save comment</button>
        </div>
      </div>
    </td>`;

  tr.after(formRow);

  const textarea = formRow.querySelector('textarea');
  const existing = getComment(patchHash, filePath, key);
  if (existing) textarea.value = existing.text;
  textarea.focus();

  formRow.querySelector('.btn-cancel').addEventListener('click', () => formRow.remove());

  formRow.querySelector('.btn-save').addEventListener('click', () => {
    const text = textarea.value.trim();
    if (!text) return;
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
    const isSkipped = state.skipped.has(patch.hash);
    const isApproved = state.approved.has(patch.hash);
    const isDenied = state.denied.has(patch.hash);
    const commentCount = commentsForPatch(patch.hash).length;

    const tab = document.createElement('button');
    tab.className = 'patch-tab' +
      (idx === state.currentPatchIdx ? ' active' : '') +
      (isSkipped ? ' skipped' : '') +
      (isApproved ? ' approved' : '') +
      (isDenied ? ' denied' : '');

    const badge = commentCount > 0 && !isSkipped && !isApproved
      ? ` <span class="tab-badge">${commentCount}</span>`
      : '';
    const skippedIcon = isSkipped ? ' <span class="tab-skipped-icon">⊘</span>' : '';
    const approvedIcon = isApproved ? ' <span class="tab-approved-icon">✓</span>' : '';
    const deniedIcon = isDenied ? ' <span class="tab-denied-icon">✗</span>' : '';

    tab.innerHTML = `<span class="tab-part">Part ${idx + 1}</span><span class="tab-msg">${escapeHtml(patch.message)}${badge}${skippedIcon}${approvedIcon}${deniedIcon}</span>`;
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

  const isSkipped = state.skipped.has(patch.hash);
  const isApproved = state.approved.has(patch.hash);
  const isDenied = state.denied.has(patch.hash);
  const patchNum = state.currentPatchIdx + 1;
  const total = state.patches.length;

  // Patch heading row
  const heading = document.createElement('div');
  heading.className = 'patch-heading' +
    (isSkipped ? ' patch-heading-skipped' : '') +
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

  const skipBtn = document.createElement('button');
  skipBtn.className = isSkipped ? 'btn-unskip' : 'btn-skip';
  skipBtn.textContent = isSkipped ? 'Undo skip' : 'Skip';
  skipBtn.addEventListener('click', () => {
    if (state.skipped.has(patch.hash)) {
      unskipPatch(patch.hash);
    } else {
      skipPatch(patch.hash);
    }
  });

  btnGroup.appendChild(approveBtn);
  btnGroup.appendChild(denyBtn);
  btnGroup.appendChild(skipBtn);
  heading.appendChild(btnGroup);
  container.appendChild(heading);

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
  if (isSkipped || isApproved) textarea.disabled = true;
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

  // Approved notice — show instead of diff
  if (isApproved) {
    const notice = document.createElement('div');
    notice.className = 'approve-notice';
    notice.innerHTML = `
      <span class="approve-notice-icon">✓</span>
      <span>This patch was approved — no issues found. Click <strong>Approved ✓</strong> to undo.</span>`;
    container.appendChild(notice);
    return;
  }

  // Skip notice — show instead of diff
  if (isSkipped) {
    const notice = document.createElement('div');
    notice.className = 'skip-notice';
    notice.innerHTML = `
      <span class="skip-notice-icon">⊘</span>
      <span>This patch was skipped and will not be reviewed. Click <strong>Undo skip</strong> to review it.</span>`;
    container.appendChild(notice);
    return;
  }

  if (patch.files.length === 0) {
    const msg = document.createElement('p');
    msg.style.cssText = 'color:#8b949e;padding:8px 0;';
    msg.textContent = 'No changed files in this patch.';
    container.appendChild(msg);
    return;
  }

  for (const fileData of patch.files) {
    container.appendChild(renderFile(fileData, patch.hash));
  }
}

// ── Submit review ──────────────────────────────────────────────────────────
async function submitReview() {
  const patch = currentPatch();
  const comments = patch ? commentsForPatch(patch.hash) : [];
  const generalComment = patch ? getGeneralComment(patch.hash).trim() : '';
  if (comments.length === 0 && !generalComment) return;

  const allFeedback = state.patches.map((p) => ({
    hash: p.hash,
    comments: commentsForPatch(p.hash),
    generalComment: getGeneralComment(p.hash).trim(),
  }));

  const btn = $('#btn-submit');
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  try {
    const res = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patchHash: patch.hash,
        allFeedback,
        skippedHashes: [...state.skipped],
        approvedHashes: [...state.approved],
        deniedHashes: [...state.denied],
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Server error');

    $('#result-feedback-path').textContent = json.feedbackPath;
    $('#result-prompt').value = json.prompt;
    $('#result-overlay').classList.add('visible');

    renderTabs();
  } catch (err) {
    alert(`Error submitting review: ${err.message}`);
  } finally {
    updateSubmitButton();
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────
async function init() {
  updateSubmitButton();

  $('#btn-submit').addEventListener('click', submitReview);

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
      if (saved.skipped) state.skipped = new Set(saved.skipped);
      if (saved.approved) state.approved = new Set(saved.approved);
      if (saved.denied) state.denied = new Set(saved.denied);
      if (saved.prompt) updateCurrentPrompt(saved.prompt);
    }

    state.patches = data.patches || [];
    state.currentPatchIdx = 0;

    $('#bug-id-display').textContent = data.bugId;
    $('#worktree-path').textContent = data.worktreePath;

    loading.style.display = 'none';
    filesChanged.style.display = '';

    renderTabs();
    renderCurrentPatch();
    updateSubmitButton();
  } catch (err) {
    loading.style.display = 'none';
    errorMsg.style.display = '';
    errorMsg.textContent = `Error loading diff: ${err.message}`;
  }
}

document.addEventListener('DOMContentLoaded', init);

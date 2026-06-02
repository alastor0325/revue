'use strict';

// ── State ──────────────────────────────────────────────────────────────────
// comments[patchHash][filePath][lineKey] = { file, line, lineContent, text, patchHash }
// generalComments[patchHash] = string
export const state = {
  comments: {},
  generalComments: {},  // free-form patch-level feedback, keyed by patchHash
  approved: new Set(),  // patchHashes the reviewer approved
  denied: new Set(),    // patchHashes the reviewer denied
  // patchHashes that were approved but whose own diff changed in a newer
  // revision — the approval was cleared and the patch needs re-review. Persisted.
  reapprovalNeeded: new Set(),
  patches: [],
  currentPatchIdx: 0,
  revisions: [],        // [{ savedAt, patches: [{hash, message}] }] — persisted
  updatedPatches: {},   // { patchIdx: { oldHash, oldMessage } } — computed on init, not persisted
  showRevision: {},     // { patchIdx: hash | null } — null means current; ephemeral toggle state
  compareRevision: {},  // { patchIdx: { from: hash, to: hash } | absent } — compare mode
};

// ── Comment draft cache ────────────────────────────────────────────────────
// Keyed by "patchHash/filePath/lineKey". Drafts survive form close/cancel
// and are cleared only when the comment is saved.
export const drafts = {};

export function draftKey(patchHash, filePath, key) {
  return `${patchHash}/${filePath}/${key}`;
}

// Replace drafts in-place — module-level identity must be preserved so other
// modules holding the import keep seeing live updates.
export function replaceDrafts(next) {
  for (const k of Object.keys(drafts)) delete drafts[k];
  if (next) Object.assign(drafts, next);
}

export function resetReviewState() {
  state.comments = {};
  state.generalComments = {};
  state.approved = new Set();
  state.denied = new Set();
  state.reapprovalNeeded = new Set();
}

export function allPatchesFinished() {
  return state.patches.length > 0 && state.patches.every(
    (p) => state.approved.has(p.hash) || state.denied.has(p.hash)
  );
}

// ── Comment management ─────────────────────────────────────────────────────
export function lineKey(line) {
  return line.newLineNum != null ? `n${line.newLineNum}` : `r${line.oldLineNum}`;
}

export function getComment(patchHash, filePath, key) {
  return ((state.comments[patchHash] || {})[filePath] || {})[key] || null;
}

// Pure mutator — caller is responsible for calling saveCommentNow().
export function setComment(patchHash, filePath, key, commentObj) {
  if (!state.comments[patchHash]) state.comments[patchHash] = {};
  if (!state.comments[patchHash][filePath]) state.comments[patchHash][filePath] = {};
  state.comments[patchHash][filePath][key] = commentObj;
}

// Pure mutator — caller is responsible for calling saveCommentNow() with null.
export function deleteComment(patchHash, filePath, key) {
  const byFile = (state.comments[patchHash] || {});
  if (byFile[filePath]) {
    delete byFile[filePath][key];
    if (Object.keys(byFile[filePath]).length === 0) delete byFile[filePath];
  }
}

export function commentsForPatch(patchHash) {
  const list = [];
  const byFile = state.comments[patchHash] || {};
  for (const filePath of Object.keys(byFile)) {
    for (const key of Object.keys(byFile[filePath])) {
      list.push(byFile[filePath][key]);
    }
  }
  return list;
}

export function currentPatch() {
  return state.patches[state.currentPatchIdx] || null;
}

export function getGeneralComment(patchHash) {
  return state.generalComments[patchHash] || '';
}

// Pure mutator — caller is responsible for calling scheduleGeneralCommentSave().
export function setGeneralComment(patchHash, text) {
  state.generalComments[patchHash] = text;
}

// ── Deny management ────────────────────────────────────────────────────────
// Pure mutators — callers are responsible for calling saveDecisionNow() and triggering re-renders.
export function denyPatch(hash) {
  state.denied.add(hash);
}

export function undenyPatch(hash) {
  state.denied.delete(hash);
}

// ── Approve management ─────────────────────────────────────────────────────
// Pure mutators — callers are responsible for calling saveDecisionNow() and triggering re-renders.
export function approvePatch(hash) {
  state.approved.add(hash);
}

export function unapprovePatch(hash) {
  state.approved.delete(hash);
}

// ── Commit comment constants ───────────────────────────────────────────────
export const COMMIT_FILE = '__commit__';
export const COMMIT_KEY  = 'msg';

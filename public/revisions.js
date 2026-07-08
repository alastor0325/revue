import { state } from './state.js';
import { saveRevisionsNow } from './persistence.js';

// ── Revision detection ─────────────────────────────────────────────────────

// FNV-1a 32-bit, returned as 8 lowercase hex chars.  We only ever compare
// fingerprints for equality (migrateApprovals), so a small non-cryptographic
// hash is sufficient — and storing 8 bytes instead of every added/removed
// line keeps REVIEW_STATE_*.json from blowing past Express's body-parser
// limit on worktrees with many large patches.
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const FP_HASH_RE = /^[0-9a-f]{8}$/;

// Pre-hash format kept added/removed lines verbatim.  When migrating from a
// state file written by older versions, re-hash on read so the comparison
// against newly-computed (hashed) fingerprints stays correct and approvals
// are not spuriously cleared.
export function normalizeFingerprint(fp) {
  if (typeof fp !== 'string') return fp;
  if (FP_HASH_RE.test(fp)) return fp;
  return fnv1a32(fp);
}

/**
 * Compute a fingerprint of a patch's actual changed lines (added/removed only,
 * not context).  Two patches with identical fingerprints have the same net code
 * change even if the commit hash or message differs.
 */
export function diffFingerprint(patch) {
  const lines = [];
  for (const file of (patch.files || [])) {
    for (const hunk of (file.hunks || [])) {
      for (const line of hunk.lines) {
        if (line.type !== 'context') lines.push(line.type[0] + line.content);
      }
    }
  }
  return fnv1a32(lines.join('\n'));
}

/**
 * Migrate approved/denied hashes when patches at the same position are
 * amended (i.e. same slot, different hash).  This preserves review decisions
 * across rebases so the reviewer doesn't lose previously recorded approvals.
 *
 * Pure function — returns new Sets, does not mutate the inputs.
 */
export function migrateApprovals(prevPatches, currPatches, approved, denied) {
  const newApproved = new Set(approved);
  const newDenied   = new Set(denied);
  // New (current) hashes whose approval was just dropped because the patch's
  // own diff changed — the reviewer should be told to re-review these.
  const reapprovalNeeded = new Set();
  for (let i = 0; i < Math.min(prevPatches.length, currPatches.length); i++) {
    const prev = prevPatches[i];
    const curr = currPatches[i];
    if (prev.hash === curr.hash) continue;

    // When both snapshots carry a diff fingerprint, use it to decide whether
    // the actual code changed.  If only hashes differ (e.g. a commit-message
    // amend or a rebase that didn't touch this patch) keep the decision.
    // If both fingerprints are absent (old state file) fall back to the same
    // keep-decision behaviour so we don't silently drop existing approvals.
    const hasFp = prev.diffFingerprint !== undefined && curr.diffFingerprint !== undefined;
    // Normalize prev to the new hash format so legacy state files still
    // produce the right comparison after upgrade.
    const diffChanged = hasFp && normalizeFingerprint(prev.diffFingerprint) !== curr.diffFingerprint;

    if (diffChanged) {
      // Actual code changed — reviewer must re-evaluate. If they had approved
      // this patch, flag the new revision so they know to re-review it.
      if (newApproved.has(prev.hash)) reapprovalNeeded.add(curr.hash);
      newApproved.delete(prev.hash);
      newDenied.delete(prev.hash);
    } else {
      // Same diff (or no fingerprint to compare) — carry the decision forward
      if (newApproved.has(prev.hash)) {
        newApproved.delete(prev.hash);
        newApproved.add(curr.hash);
      }
      if (newDenied.has(prev.hash)) {
        newDenied.delete(prev.hash);
        newDenied.add(curr.hash);
      }
    }
  }
  return { approved: newApproved, denied: newDenied, reapprovalNeeded };
}

// Merge two comment trees ({ filePath: { lineKey: commentObj } }) for the same
// patch.  `newer` wins on collisions: a comment freshly made on the new
// revision must not be overwritten by one carried forward from the old hash.
function mergeCommentTrees(newer, older) {
  if (!newer) return older;
  if (!older) return newer;
  const out = {};
  const files = new Set([...Object.keys(older), ...Object.keys(newer)]);
  for (const file of files) {
    out[file] = { ...(older[file] || {}), ...(newer[file] || {}) };
  }
  return out;
}

/**
 * Re-key review feedback (line comments and the patch-level general comment)
 * from each patch's previous hash to its new hash when an amend/rebase changed
 * the hash at the same position.  Feedback is keyed by patch hash; without this
 * remap it would be orphaned under the old hash and silently vanish from the UI
 * even though the reviewer never drained it.
 *
 * Unlike approvals (which a diff change invalidates), feedback is carried
 * forward UNCONDITIONALLY — it is cleared only by submitting/draining the
 * review, never by the code changing underneath it.
 *
 * Pure function — returns new objects, does not mutate the inputs.  `remap` is
 * an iterable of [oldHash, newHash] pairs.
 */
export function remapFeedbackHashes(comments, generalComments, remap) {
  const nextComments = { ...(comments || {}) };
  const nextGeneral  = { ...(generalComments || {}) };
  for (const [oldHash, newHash] of remap) {
    if (oldHash === newHash) continue;
    if (nextComments[oldHash] !== undefined) {
      nextComments[newHash] = mergeCommentTrees(nextComments[newHash], nextComments[oldHash]);
      delete nextComments[oldHash];
    }
    if (nextGeneral[oldHash] !== undefined) {
      // Keep any general comment already written on the new revision; otherwise
      // carry the old one forward.
      if (!nextGeneral[newHash]) nextGeneral[newHash] = nextGeneral[oldHash];
      delete nextGeneral[oldHash];
    }
  }
  return { comments: nextComments, generalComments: nextGeneral };
}

export function detectRevisionChanges() {
  if (state.patches.length === 0) return;

  const lastRevision = state.revisions[state.revisions.length - 1];
  const currentSnapshot = state.patches.map((p) => ({
    hash: p.hash,
    message: p.message,
    date: p.date,
    diffFingerprint: diffFingerprint(p),
  }));

  if (!lastRevision) {
    // First time — record baseline, nothing to compare against.
    // approved/denied are passed along too; migrateApprovals is deterministic
    // given the same prev/curr snapshots, so two tabs racing this write end
    // up writing the same sets.
    state.revisions.push({ savedAt: new Date().toISOString(), patches: currentSnapshot });
    saveRevisionsNow(state.revisions, [...state.approved], [...state.denied], [...state.reapprovalNeeded]);
    return;
  }

  let hasChanges = false;
  const prevPatches = lastRevision.patches;
  // [oldHash, newHash] pairs for positions whose commit hash changed — used to
  // carry review feedback forward onto the amended patch (see remapFeedbackHashes).
  const feedbackRemap = [];
  for (let i = 0; i < Math.max(state.patches.length, prevPatches.length); i++) {
    const curr = state.patches[i];
    const prev = prevPatches[i];
    if (!curr || !prev || curr.hash !== prev.hash) {
      if (curr && prev) {
        state.updatedPatches[i] = { oldHash: prev.hash, oldMessage: prev.message };
        feedbackRemap.push([prev.hash, curr.hash]);
      }
      hasChanges = true;
    }
  }

  if (hasChanges) {
    const migrated = migrateApprovals(prevPatches, currentSnapshot, state.approved, state.denied);
    state.approved = migrated.approved;
    state.denied   = migrated.denied;
    // Accumulate newly-invalidated approvals, then prune to patches that still
    // exist so stale hashes (e.g. a dropped patch) don't linger on disk.
    for (const h of migrated.reapprovalNeeded) state.reapprovalNeeded.add(h);
    const currentHashes = new Set(state.patches.map((p) => p.hash));
    state.reapprovalNeeded = new Set([...state.reapprovalNeeded].filter((h) => currentHashes.has(h)));
    // Carry undrained review feedback onto the amended patches so it survives
    // the hash change instead of being orphaned under the old hash.
    const remapped = remapFeedbackHashes(state.comments, state.generalComments, feedbackRemap);
    state.comments        = remapped.comments;
    state.generalComments = remapped.generalComments;
    state.revisions.push({ savedAt: new Date().toISOString(), patches: currentSnapshot });
    if (state.revisions.length > 10) state.revisions = state.revisions.slice(-10);
    saveRevisionsNow(
      state.revisions, [...state.approved], [...state.denied], [...state.reapprovalNeeded],
      state.comments, state.generalComments,
    );
  }
}

// Returns [{hash, savedAt, date}] ordered oldest-to-newest for the given patch
// position. `date` is the commit's committer date (matching the patch heading);
// it is undefined for snapshots recorded before the field existed, in which
// case the UI falls back to savedAt. The last entry is always the current revision.
export function getRevisionList(patchIdx) {
  const seen = new Set();
  const list = [];
  for (const rev of state.revisions) {
    const p = rev.patches[patchIdx];
    if (p && !seen.has(p.hash)) {
      seen.add(p.hash);
      list.push({ hash: p.hash, savedAt: rev.savedAt, date: p.date });
    }
  }
  return list;
}

// Allow unit tests to import without a full browser environment.
if (typeof module !== 'undefined') {
  module.exports = { diffFingerprint, normalizeFingerprint, migrateApprovals, remapFeedbackHashes, detectRevisionChanges, getRevisionList };
}

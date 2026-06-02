import { state, allPatchesFinished } from './state.js';

// ── Cross-tab sync ─────────────────────────────────────────────────────────
// Every save POST carries the X-Tab-Id header.  The server processes the
// write, then pushes a delta event to all GET /api/state/events SSE
// subscribers for the same worktree.  Each subscriber filters out events
// whose `_from` matches its own TAB_ID so the originator doesn't replay
// the event it just authored.
//
// Each event also carries `_version` — a monotonic per-server-lifetime
// counter.  On SSE reconnect the server sends a fresh `hello` event with
// its current `_version`; if the client missed events during the drop
// (or the server restarted, resetting to 0), the client emits a synthetic
// `catchup` delta so the app refetches `/api/state` and reconciles.
let stateEvents = null;
let stateEventsCallback = null;
const TAB_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// Visibility-driven catchup state: shared across the lifetime of one
// EventSource because EventSource handles its own auto-reconnect without
// calling us back, so we record any error and act on visibility change.
let sawDisconnect = false;

export function initStateChannel(worktreeName, onRemoteDelta) {
  closeStateChannel();
  if (typeof EventSource === 'undefined') return null;
  stateEventsCallback = onRemoteDelta;
  stateEvents = new EventSource('/api/state/events');
  let sawHello = false;
  let lastSeenVersion = 0;
  stateEvents.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    if (!data) return;
    if (data.kind === 'hello') {
      // Reconnect: if the server has advanced past our last seen version,
      // or rolled back (restart), we may have missed events — catch up.
      // Skip on the very first hello of this page load.
      if (sawHello && data._version !== lastSeenVersion) {
        onRemoteDelta({ kind: 'catchup' });
      }
      sawHello = true;
      lastSeenVersion = data._version || 0;
      sawDisconnect = false;
      return;
    }
    // Own writes still advance the server counter — track them too so the
    // next hello's comparison is against the true last-seen version.
    if (data._version && data._version > lastSeenVersion) lastSeenVersion = data._version;
    if (data._from === TAB_ID) return;
    onRemoteDelta(data);
  };
  stateEvents.onerror = () => { sawDisconnect = true; };
  return stateEvents;
}

export function closeStateChannel() {
  if (stateEvents) { stateEvents.close(); stateEvents = null; }
  stateEventsCallback = null;
  sawDisconnect = false;
}

// Called from app.js visibility handler.  If the EventSource was ever in an
// error state while the tab was hidden, defensively trigger a catchup —
// browsers may throttle background EventSource delivery so events could have
// been silently dropped.
export function maybeCatchupOnVisible() {
  if (sawDisconnect && stateEventsCallback) {
    sawDisconnect = false;
    stateEventsCallback({ kind: 'catchup' });
  }
}

// ── Save-status indicator ──────────────────────────────────────────────────
let pendingSaves = 0;
function indicator() { return document.querySelector('#autosave-status'); }
function showSaving() {
  pendingSaves++;
  const el = indicator();
  if (el) el.textContent = 'Saving…';
}
function showSaved() {
  pendingSaves = Math.max(0, pendingSaves - 1);
  const el = indicator();
  if (!el) return;
  if (pendingSaves === 0) {
    el.textContent = 'Saved';
    setTimeout(() => { if (el && pendingSaves === 0) el.textContent = ''; }, 2000);
  }
}
function showFailed() {
  pendingSaves = Math.max(0, pendingSaves - 1);
  const el = indicator();
  if (el) el.textContent = 'Save failed';
}

async function postJson(url, body) {
  showSaving();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tab-Id': TAB_ID },
      body: JSON.stringify(body),
    });
    if (!res.ok) { showFailed(); return false; }
    showSaved();
    return true;
  } catch {
    showFailed();
    return false;
  }
}

// ── Delta saves ────────────────────────────────────────────────────────────
// Each save targets one logical entry of the persisted state.  Two tabs
// editing different entries cannot clobber each other because the server
// serialises read-modify-write under a per-worktree lock.

export function saveCommentNow(patchHash, file, key, comment) {
  return postJson('/api/state/comment', { patchHash, file, key, comment });
}

export function saveDecisionNow(patchHash, kind) {
  return postJson('/api/state/decision', { patchHash, kind });
}

export function saveRevisionsNow(revisions, approved, denied, reapprovalNeeded = []) {
  return postJson('/api/state/revisions', { revisions, approved, denied, reapprovalNeeded });
}

// ── Debounced saves for typed text ─────────────────────────────────────────
// Drafts and general-comment text are typed character-by-character.  Debounce
// so we hit the server once per ~500 ms of typing per key.  Track per-key
// timers in a Map so quickly switching between two drafts doesn't lose either.
const DEBOUNCE_MS = 500;

function makeDebouncedSaver(url, buildBody) {
  const pending = new Map(); // key -> { payload, timer }
  function fire(key, payload) {
    return postJson(url, buildBody(key, payload));
  }
  return {
    schedule(key, payload) {
      const prev = pending.get(key);
      if (prev) clearTimeout(prev.timer);
      const timer = setTimeout(() => {
        pending.delete(key);
        fire(key, payload);
      }, DEBOUNCE_MS);
      pending.set(key, { payload, timer });
    },
    cancelKey(key) {
      const prev = pending.get(key);
      if (prev) { clearTimeout(prev.timer); pending.delete(key); }
    },
    flushAll() {
      const all = [];
      for (const [key, { payload, timer }] of pending) {
        clearTimeout(timer);
        all.push(fire(key, payload));
      }
      pending.clear();
      return Promise.all(all);
    },
    cancelAll() {
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
    },
    hasPending() { return pending.size > 0; },
  };
}

const draftSaver = makeDebouncedSaver(
  '/api/state/draft',
  (key, text) => ({ key, text }),
);
const gcSaver = makeDebouncedSaver(
  '/api/state/general-comment',
  (patchHash, text) => ({ patchHash, text }),
);

export function scheduleDraftSave(key, text) { draftSaver.schedule(key, text); }
export function scheduleGeneralCommentSave(patchHash, text) { gcSaver.schedule(patchHash, text); }

// Immediate draft save — for explicit "discard" actions where waiting for the
// debounce would visibly leak the cleared draft into other tabs.
export function saveDraftNow(key, text) {
  draftSaver.cancelKey(key);
  return postJson('/api/state/draft', { key, text });
}

export function hasPendingSave() {
  return draftSaver.hasPending() || gcSaver.hasPending();
}

// Flush every pending debounced save.  Called by loadAndRender before the
// state reset so keystrokes typed within the debounce window survive reload.
export async function flushSave() {
  await Promise.all([draftSaver.flushAll(), gcSaver.flushAll()]);
}

// Cancel pending saves without persisting them.  Used by the submit flow,
// which is about to bulk-write a cleared state — flushing the in-flight
// drafts would re-create the values we are trying to clear.
export function cancelPendingSaves() {
  draftSaver.cancelAll();
  gcSaver.cancelAll();
}

// ── Bulk save (submit-reset only) ──────────────────────────────────────────
// The submit flow clears comments/generalComments/denied/drafts in one shot
// and preserves approved.  Using delta endpoints here would mean N+M POSTs
// for N comments and M drafts — the bulk endpoint exists for exactly this.
export async function saveStateBulk(payload) {
  return postJson('/api/state', payload);
}

// ── Prompt bar ─────────────────────────────────────────────────────────────
let savedPromptText = null;
export function getSavedPromptText() { return savedPromptText; }
export function setSavedPromptText(v) { savedPromptText = v; }

export function updateCurrentPrompt(prompt) {
  savedPromptText = prompt;
  refreshPromptBar();
}

export function refreshPromptBar() {
  const bar = document.querySelector('#current-prompt-bar');
  if (!bar) return;
  if (savedPromptText && allPatchesFinished()) {
    bar.dataset.prompt = savedPromptText;
    bar.style.display = '';
  } else {
    bar.style.display = 'none';
  }
}

// Allow unit tests to import without a full browser environment.
if (typeof module !== 'undefined') {
  module.exports = {
    saveCommentNow, saveDecisionNow, saveRevisionsNow,
    scheduleDraftSave, saveDraftNow, scheduleGeneralCommentSave,
    saveStateBulk,
    flushSave, hasPendingSave, cancelPendingSaves,
    initStateChannel, closeStateChannel, maybeCatchupOnVisible,
    updateCurrentPrompt, refreshPromptBar, getSavedPromptText, setSavedPromptText,
  };
}

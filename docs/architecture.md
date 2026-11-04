# Client-side architecture

The browser-side application is split into five ES modules under `public/`. This document describes their structure, the layering rules that keep them maintainable, and the conventions to follow when extending them.

## Files

| File | Lines | Responsibility |
|---|---|---|
| `public/state.js` | ~110 | State object, pure mutators/accessors, draft cache, constants |
| `public/persistence.js` | ~70 | `saveState`, `scheduleAutoSave`, `flushSave`, prompt bar data |
| `public/revisions.js` | ~120 | `diffFingerprint`, `migrateApprovals`, `detectRevisionChanges`, `getRevisionList` |
| `public/renderer.js` | ~1225 | All DOM construction and event wiring |
| `public/layout.js` | ~140 | View layout kept across reloads: preferences in localStorage (sidebar, Rendered files, collapsed files), where the tab is in sessionStorage (open patch, revision/compare view, scroll); per project page and worktree, read once into memory; no imports |
| `public/richdiff.js` | ~200 | Rendered (rich) diff of Markdown / Bikeshed files: block-level LCS diff (`diffSequences`), change marking (`markChanges`), the sandboxed-frame view (`mountRichView`). Server side: `src/render.js` + `GET /api/rendered` |
| `public/highlight.js` | ~120 | Syntax highlighting of diff lines with the vendored `public/vendor/highlight.min.js`; pure helpers (`languageFor`, `splitHighlightedLines`, `highlightDiffLines`) |
| `public/app.js` | ~370 | Orchestrators (`loadAndRender`, `submitReview`, `init`, `initWorktreeBar`, `startUpdatePolling`) + entry point |

## Layers

```
app.js (orchestrators)
  ├── renderer.js  ──► state.js
  │                ──► persistence.js
  │                ──► revisions.js
  ├── persistence.js ──► state.js
  ├── revisions.js   ──► state.js
  │                  ──► persistence.js
  └── state.js  (no imports)
```

Arrows point **down** — a layer may only call into layers below it. The renderer reads state but never writes it. State mutators never call render functions.

## Import graph

```
state.js        ← no imports (bottom of stack)
persistence.js  ← imports state.js
revisions.js    ← imports state.js, persistence.js
renderer.js     ← imports state.js, persistence.js, revisions.js
app.js          ← imports all four
```

This is a strict DAG. ES module semantics enforce it at parse time — any attempted cycle is a syntax error.

## The state layer

All mutable application data lives in one object:

```javascript
const state = {
  patches: [],            // current patch series (from /api/diff)
  currentPatchIdx: 0,
  approved: new Set(),    // patch hashes the reviewer approved
  denied: new Set(),      // patch hashes the reviewer denied
  comments: {},           // [patchHash][filePath][lineKey] = commentObj
  generalComments: {},    // [patchHash] = string
  revisions: [],          // [{savedAt, patches:[{hash,message,diffFingerprint}]}]
  updatedPatches: {},     // {patchIdx: {oldHash, oldMessage}} — ephemeral, not persisted
  showRevision: {},       // {patchIdx: hash|null} — ephemeral revision toggle state
  compareRevision: {},    // {patchIdx: {from, to}|absent} — ephemeral compare mode
};
```

### Mutator contract

**State mutators are pure data operations.** They write to `state` only — no `scheduleAutoSave()`, no render calls:

```javascript
// Correct:
export function approvePatch(hash) {
  state.approved.add(hash);
}

// Wrong — never do this:
export function approvePatch(hash) {
  state.approved.add(hash);
  scheduleAutoSave();    // ← violates the contract (would require importing persistence.js)
  renderTabs();          // ← violates the contract (would require importing renderer.js)
}
```

The caller (always an event handler in `renderer.js`) is responsible for calling `scheduleAutoSave()` and triggering re-renders after a mutation.

This rule enforces the import DAG: `state.js` has no imports. If a mutator called `scheduleAutoSave()`, state.js would need to import persistence.js; if it called `renderTabs()`, it would need to import renderer.js — both would create a cycle since those modules already import state.js.

### Accessors

Read-only helpers (`getComment`, `commentsForPatch`, `getGeneralComment`, `allPatchesFinished`, `currentPatch`) are co-located with state. They take arguments and return values; they have no side effects.

## The persistence layer

`saveState` serialises `state.comments`, `state.generalComments`, `state.approved`, `state.denied`, and `state.revisions` to `/api/state` (a JSON file on disk).

`scheduleAutoSave` debounces saves with a 500 ms timer stored in the module-private `saveTimer`. `flushSave` cancels the timer and calls `saveState` immediately — used by `loadAndRender` before resetting state so approvals made within the debounce window are not silently lost on reload.

`refreshPromptBar` shows or hides the current-prompt bar based on whether all patches are finished and a prompt text exists. It lives in persistence because it reads `savedPromptText`, which is persistence-private state.

## The revisions layer

### diffFingerprint

```javascript
function diffFingerprint(patch) { … }
```

Computes a string fingerprint of a patch's changed lines (added/removed only, not context). Two patches with the same fingerprint have identical code changes regardless of commit hash or message. Used to distinguish:

- **Hash-only changes** (rebase, message amend) → fingerprints match → migrate approval to new hash
- **Code changes** (actual diff content changed) → fingerprints differ → clear approval, reviewer must re-evaluate

### migrateApprovals

```javascript
function migrateApprovals(prevPatches, currPatches, approved, denied)
  → { approved: Set, denied: Set }
```

Pure function. Walks the two patch lists slot-by-slot. For each slot where the hash changed:

1. If fingerprints match (or neither has a fingerprint) → carry the approval/denial forward to the new hash.
2. If fingerprints differ → drop the decision; the reviewer must look again.

Returns new Sets; does not mutate the inputs.

### detectRevisionChanges

Called once per `loadAndRender`. Compares the current patch list against the most recent revision snapshot. If anything changed, records a new revision entry and runs `migrateApprovals` to update `state.approved`/`state.denied`. Keeps at most 10 revision snapshots.

## The renderer

All DOM construction and mutation lives in a single `renderer.js` (~1225 lines). It is intentionally kept as one file — the three conceptual sub-areas (comment UI, diff rendering, patch/tab/nav assembly) are tightly coupled through `buildPatchEl` and `renderFile`, so splitting them would introduce cross-imports without a clean boundary.

Internal sub-areas (for navigation, not enforced as separate modules):
- **Comment UI** — `showCommentForm`, `renderCommentDisplay`, `renderDraftDisplay`, `renderCommitMessageSection`
- **Diff rendering** — `renderFile`, `renderExpandRow`, `countStats`
- **Patch/tab/nav assembly** — `buildPatchEl`, `renderCurrentPatch`, `initPatchNodes`, `renderTabs`, `switchPatch`, `buildNavItemsEl`, `activateFileNav`

Key functions:

| Function | Responsibility |
|---|---|
| `buildPatchEl(idx)` | Builds a complete patch element (detached) for a given index. Returns `{ el, diffWrap, navItemsEl }`. |
| `renderCurrentPatch()` | Rebuilds the current patch in-place, replacing the existing element. |
| `initPatchNodes()` | Builds all patch elements on initial load; only the active one is visible. |
| `renderTabs()` | Redraws the patch tab bar. Rebuilds from scratch if patch count changes; otherwise updates class/content in-place. |
| `switchPatch(idx)` | Hides the old patch element, shows the new one, updates tab active state. O(1) DOM ops. |
| `renderFile(fileData, patchHash)` | Builds one file diff block (header + hunk rows + expand rows + comment rows). |
| `buildNavItemsEl(files, diffWrap)` | Builds the file-nav items element (detached). |
| `activateFileNav(navItemsEl, diffWrap)` | Swaps in a pre-built nav items element and attaches the scroll highlight handler. |
| `updateSubmitButton()` | Enables/disables the Generate button based on current activity. |

### Patch element lifecycle

```
loadAndRender()
  └─ initPatchNodes()
       ├─ buildPatchEl(0) → attached, visible
       ├─ buildPatchEl(1) → attached, hidden (display:none)
       └─ buildPatchEl(2) → attached, hidden

switchPatch(1)            → hide 0, show 1 (no rebuild)

approvePatch(hash)        → state mutated
  caller:
    renderTabs()          → update tab classes in-place
    renderCurrentPatch()  → buildPatchEl(1) again, replaceWith
```

`patchEls` is a module-level array that caches `{ el, diffWrap, navItemsEl }` for each patch. It is rebuilt on every `loadAndRender` and updated in-place on `renderCurrentPatch`.

### Expand-context rows

`renderExpandRow` manages its own state (current hidden range, known file length) in closure variables. Clicking ↑/↓ fetches from `/api/filecontext` and inserts context rows into the table without a full re-render. The expand row removes itself when the hidden range is exhausted.

## The orchestrators

These functions wire the layers together. They are allowed to call any layer.

### `loadAndRender()`

1. Flush any pending auto-save.
2. Reset all state (ephemeral and persisted).
3. Fetch `/api/diff` and `/api/state` in parallel.
4. Populate `state` from both responses.
5. Run `detectRevisionChanges` (migrate approvals, record revision).
6. Call `renderTabs`, `initPatchNodes`, `updateSubmitButton`, `refreshPromptBar`.

Safe to call multiple times — worktree switching calls it on each switch.

### `submitReview()`

1. Serialise current feedback into the POST body.
2. POST to `/api/submit`.
3. On success: show the result overlay, auto-copy the prompt to clipboard.
4. Clear `state.denied`, `state.comments`, `state.generalComments` (approved is kept — patches already signed off remain so across review cycles).
5. Save state, re-render tabs and current patch.

### `init()`

Attaches all top-level event listeners (submit button, copy buttons, modal close, reload banner). Calls `initWorktreeBar()` then `loadAndRender()`.

### `startUpdatePolling()`

Polls `/api/headhash` every 5 seconds. Shows the reload banner when the hash changes. Does not auto-reload — the reviewer decides when to pull in new diffs.

## Revision UI

When a patch has been seen in multiple revisions (`getRevisionList` returns length > 1), `buildPatchEl` renders a revision bar above the diff.

Two modes:
- **Single-revision view** — a row of buttons, one per revision. Clicking a non-current button fetches `/api/patchdiff/:hash` and renders that version read-only.
- **Compare mode** — two rows (From / To). Clicking the `⇄` button enters compare mode; `renderCurrentPatch` then fetches `/api/revdiff?from=…&to=…` and renders the between-revision diff.

Both modes are stored in `state.showRevision` and `state.compareRevision` (ephemeral — not persisted across reloads).

## Test compatibility

`index.html` loads `app.js` as `<script type="module">`, so the browser runs native ES modules. Tests use Babel (`babel-jest`) with `@babel/preset-env` to convert `import`/`export` to CommonJS `require`/`module.exports` in the test environment only. This means `require('../public/app')` in test files resolves the full import chain transparently, and no test file paths need to change.

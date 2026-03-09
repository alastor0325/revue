# firefox-review

A local web UI for reviewing Claude-generated Firefox patches in git worktrees.

**[→ Interactive demo](https://alastor0325.github.io/firefox-review/docs/)**

## The problem

When you use Claude Code to implement a Firefox bug, the patches land in a dedicated git worktree (e.g. `~/firefox-my-feature`). Reviewing those changes and sending feedback back to Claude is awkward — there's no clean way to annotate specific lines and hand the structured feedback off without manual copy-pasting.

`firefox-review` solves this with a GitHub-style diff viewer that runs locally, lets you leave inline comments per patch, and generates a structured prompt you can paste directly into Claude.

## Setup

**Prerequisites:** Node.js ≥ 18

```bash
git clone https://github.com/alastor0325/firefox-review
cd firefox-review
npm install
npm link          # makes `firefox-review` available globally
```

**Expected directory layout:**

```
~/firefox/               ← main Firefox repo (central)
~/firefox-my-feature/    ← a Claude-generated worktree
~/firefox-experiment/    ← another worktree
```

## Usage

### Interactive picker (no argument)

```bash
firefox-review
```

Lists all worktrees and the main repo:

```
Available repos / worktrees:

  1.  firefox  (main repo)
  2.  firefox-my-feature    (feature-branch)
  3.  firefox-experiment    (detached)

Select [1-3]:
```

### Direct launch

```bash
firefox-review <worktree-name>

# Examples:
firefox-review my-feature
firefox-review experiment
```

`<worktree-name>` is the suffix of the directory: `~/firefox-<worktree-name>`.

The browser opens at `http://localhost:7777` automatically (increments if the port is busy).

## Reviewing

### Per-patch tabs

When a worktree has multiple commits the UI shows **tabs** — one per patch:

```
[ Part 1: Add WebIDL ]  [ Part 2: Implement logic ]  [ Part 3: Fire events ]
```

Each tab shows a comment-count badge, a `✓` if approved, or a `⊘` if skipped.

### Per-patch actions

Each patch has three buttons in the heading:

| Button | Meaning |
|---|---|
| **Approve** | Patch looks good — no issues. Turns green `Approved ✓`. |
| **Deny** | Patch requires significant changes. Diff stays visible for comments. |
| **Skip** | Patch won't be reviewed. Turns gray with strikethrough. |

All can be undone by clicking again.

### Adding comments

- **Click any diff line** to open an inline comment box
- **Save** — the comment appears as a yellow annotation beneath the line
- Click the annotation to edit it, × to delete it
- Use the **General feedback** box for patch-level concerns not tied to a specific line

### Submitting feedback

When you're done reviewing all patches, click the **Generate Review Prompt** button. It:

1. Writes `REVIEW_FEEDBACK_<worktree-name>.md` in the worktree covering all patches (see format below)
2. Opens a modal with the prompt — click **Copy prompt** and paste it into Claude

The button is enabled as soon as any patch has any activity (a comment, approval, denial, or skip).

## Auto-save and state persistence

Your review state (comments, general feedback, approved/denied/skipped status) is saved automatically to `REVIEW_STATE_<worktree-name>.json` in the worktree. When you reopen `firefox-review` for the same worktree, all your work is restored automatically.

### What triggers what

| Action | State JSON | MD file |
|---|---|---|
| Add / edit / delete a line comment | ✓ auto-saved | ✗ |
| Type in the General feedback textarea | ✓ auto-saved | ✗ |
| Click **Approve** / **Unapprove** | ✓ auto-saved | ✗ |
| Click **Deny** / **Undeny** | ✓ auto-saved | ✗ |
| Click **Skip** / **Unskip** | ✓ auto-saved | ✗ |
| Click **Generate Review Prompt** | ✓ | ✓ written/overwritten |

The MD is only ever written when you explicitly click the button.

### Copy current prompt bar

Once all patches have been acted on (each approved, denied, or skipped), a green **Copy current prompt** bar appears below the header — this is populated the first time you click Generate Review Prompt and persists across reopens.

## Prompt format

`REVIEW_FEEDBACK_<worktree-name>.md` covers all patches in one file:

```
You are being asked to revise your implementation in worktree firefox-my-feature.

## Full patch series:
- aaa111 my-feature - Part 1: Add WebIDL  [DENIED — requires significant changes]
- bbb222 my-feature - Part 2: Implement logic
- ccc333 my-feature - Part 3: Fire events  [SKIPPED — not reviewed]

---

## Part 1 (aaa111) — my-feature - Part 1: Add WebIDL

⚠ This patch was denied — it requires significant changes.

### Line-level feedback:

#### dom/media/Foo.webidl : line 2
[YOUR CODE] :   void toggle();
[FEEDBACK]  : Use camelCase

---

## Part 2 (bbb222) — my-feature - Part 2: Implement logic

### General feedback:

Please use RAII for the lock throughout this patch.

### Line-level feedback:

#### dom/media/ContentPlaybackController.cpp : line 42
[YOUR CODE] : MOZ_ASSERT(mBrowsingContext);
[FEEDBACK]  : Add a message string — MOZ_ASSERT(mBrowsingContext, "must not be null")

---

## Instructions:
For each part with feedback above, apply changes only to files modified in that
commit unless a fix strictly requires touching other code. After making changes,
summarize what you changed for each feedback item.
```

- Approved patches are noted `[APPROVED — no issues]` in the series list; they still get a feedback section if they have comments
- Denied patches are noted `[DENIED — requires significant changes]` and always get a feedback section (with a denial note), even without text comments
- Skipped patches are noted `[SKIPPED — not reviewed]` — no feedback section ever
- Patches with no comments, no general comment, and not denied are omitted from the feedback sections entirely

## Development

```bash
npm test              # run all tests
npm run test:watch    # watch mode
npm run test:coverage # coverage report
```

Tests cover:
- `parseDiff` — diff parsing (added/removed/context lines, multiple files, binary files, multiple hunks)
- `parseWorktreeList` — worktree discovery parsing
- `formatCombinedPrompt` / `submitReview` — combined prompt structure, approved/skipped markers, multi-patch feedback
- Express routes — all API endpoints with mocked git and claude modules

## License

MIT

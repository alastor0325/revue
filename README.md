# firefox-review

A local web UI for reviewing Claude-generated Firefox patches in git worktrees.

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

Once a patch has at least one line comment or a general comment, the **Submit Review for Part N** button is enabled. Clicking it:

1. Writes `REVIEW_FEEDBACK_<worktree-name>.md` in the worktree (see format below)
2. Opens a modal with the full prompt — click **Copy prompt** and paste it into Claude

## Auto-save and state persistence

Your review state (comments, general feedback, approved/skipped status) is saved automatically to `REVIEW_STATE_<worktree-name>.json` in the worktree. When you reopen `firefox-review` for the same worktree, all your work is restored automatically.

### What triggers a state save and MD regeneration

Every one of the following actions saves state and rewrites `REVIEW_FEEDBACK_<worktree-name>.md` (debounced 500 ms):

| Action | Triggers save + MD |
|---|---|
| Add / edit / delete a line comment | ✓ |
| Type in the General feedback textarea | ✓ |
| Click **Approve** or **Undo approve** | ✓ |
| Click **Deny** or **Undo deny** | ✓ |
| Click **Skip** or **Undo skip** | ✓ |
| Click **Submit Review** | ✓ (immediate) |

The MD is written as long as there is **any activity** on any patch — text feedback, an approval, or a skip. If you have only opened the tool and not interacted yet, no MD is written.

### Copy current prompt bar

If `REVIEW_FEEDBACK_<worktree-name>.md` already exists when you open the tool, a green **Copy current prompt** bar appears below the header. This lets you copy the prompt at any time without clicking Submit.

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

- Approved patches are noted `[APPROVED — no issues]` in the series list — no feedback section
- Denied patches are noted `[DENIED — requires significant changes]` and always get a feedback section (with a denial note), even without text comments
- Skipped patches are noted `[SKIPPED — not reviewed]` — no feedback section
- Only patches with actual feedback (or denial) get a `## Part N` section

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

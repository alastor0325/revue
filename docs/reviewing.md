# Reviewing in detail

## Page title

The browser tab title is set to `repoName-worktreeName` (e.g. `firefox-bug-1234567`) and updates immediately when you switch worktrees.

## File navigation sidebar

A sidebar on the left lists all changed files in the current patch, with `+`/`-` counts per file. Click any entry to jump to that file's diff. The sidebar highlights the file currently in view as you scroll, and can be collapsed with the `◀` toggle.

## Per-patch tabs

When a worktree has multiple commits the UI shows **tabs** — one per patch:

```
[ Part 1: Add WebIDL ]  [ Part 2: Implement logic ]  [ Part 3: Fire events ]
```

Each tab shows a comment-count badge, a `✓` if approved, or a `✗` if denied. Tabs with amended commits show a `↑` badge.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `←` / `→` | Switch to the previous / next patch tab |
| `↑` / `↓` | Move to the previous / next file in the current patch (scrolls its diff into view) |

Shortcuts are disabled while you are typing in a comment or feedback field, and while the review-prompt modal is open, so the arrows keep their normal behavior there.

## Patch heading

Each patch heading shows its **Part** label, the commit subject, the short hash, and the commit's **last-modified time** (the committer date, which advances whenever the commit is amended or rebased). The timestamp is left-aligned on the same row as the Approve/Deny buttons, in a smaller muted font.

The heading is **pinned** under the top bar (like the file sidebar), so the Approve/Deny buttons stay reachable while you scroll a long diff — finish reading and act on the patch without scrolling back up.

## Per-patch actions

Each patch has two buttons in the heading:

| Button | Meaning |
|---|---|
| **Approve** | Patch looks good — no issues. Turns green `Approved ✓`. |
| **Deny** | Patch requires significant changes. Diff stays visible for comments. |

Both can be undone by clicking again. Patches with no comments and not denied are simply omitted from the generated feedback — no explicit skip needed.

## Adding comments

- **Click the commit message** to leave feedback on it (subject + body shown separately)
- **Click any diff line** to open an inline comment box
- **Save** — the comment appears as a yellow annotation beneath the line
- Click the annotation to edit it, × to delete it
- Unsaved text in a comment form is cached as a draft — closing the form preserves it; **Discard draft** clears it
- Use the **General feedback** box for patch-level concerns not tied to a specific line

> **Tip:** Selecting text (drag) on the diff or commit message will not trigger the comment box — only a plain click does.

## Revision detection

If a patch has been amended or rebased since the last review session, its tab shows a `↑` badge. A **Revision** bar appears above the diff with one button per recorded revision (`Rev 1`, `Rev 2`, `Rev 3 · current`). Click any revision button to compare diffs between versions.

## Submitting feedback

When you're done reviewing all patches, click the **Generate Review Prompt** button. It:

1. Writes `REVIEW_FEEDBACK_<worktree-name>.md` in the worktree covering all patches
2. Opens a modal with the prompt — already copied to your clipboard, ready to paste into Claude

The button is enabled as soon as any patch has any activity (a comment, approval, denial, or skip).

## Auto-save and state persistence

Your review state (comments, general feedback, approved/denied/skipped status) is saved automatically to `REVIEW_STATE_<worktree-name>.json` in the worktree. When you reopen `revue` for the same worktree, all your work is restored automatically.

### What triggers what

| Action | State JSON | MD file |
|---|---|---|
| Add / edit / delete a comment | ✓ auto-saved | ✗ |
| Type in the General feedback textarea | ✓ auto-saved | ✗ |
| Click **Approve** / **Unapprove** | ✓ auto-saved | ✗ |
| Click **Deny** / **Undeny** | ✓ auto-saved | ✗ |
| Click **Generate Review Prompt** | ✓ | ✓ written/overwritten |

The MD is only ever written when you explicitly click the button.

### Copy current prompt bar

Once all patches have been acted on (each approved or denied), a green **Copy current prompt** bar appears below the header — this is populated the first time you click Generate Review Prompt and persists across reopens.

## Prompt format

`REVIEW_FEEDBACK_<worktree-name>.md` covers all patches in one file:

```
You are being asked to revise your implementation in worktree my-feature.

## Full patch series:
- aaa111 my-feature - Part 1: Add thing  [DENIED — requires significant changes]
- bbb222 my-feature - Part 2: Implement logic
- ccc333 my-feature - Part 3: Fire events  [APPROVED — no issues]

---

## Part 1 (aaa111) — my-feature - Part 1: Add thing

⚠ This patch was denied — it requires significant changes.

### Commit message feedback:

[FEEDBACK]: Fix commit message subject format

### Line-level feedback:

#### src/foo.cpp : line 2
[YOUR CODE] :   void toggle();
[FEEDBACK]  : Use camelCase

---

## Part 2 (bbb222) — my-feature - Part 2: Implement logic

### General feedback:

Please use RAII for the lock throughout this patch.

### Line-level feedback:

#### src/bar.cpp : line 42
[YOUR CODE] : assert(mCtx);
[FEEDBACK]  : Add a message string

---

## Instructions:
Address each piece of feedback in the commit it belongs to. For each part with feedback:
1. Apply the changes only to files modified in that commit, unless a fix strictly requires touching other code.
2. Amend the changes directly into that commit (do not create new commits). Use interactive rebase if the commit is not the tip of the branch.
3. After all amendments are done, summarize what you changed for each feedback item.
```

- Approved patches are noted `[APPROVED — no issues]` in the series list; they still get a feedback section if they have comments
- Denied patches are noted `[DENIED — requires significant changes]` and always get a feedback section (with a denial note), even without text comments
- Patches with no comments, no general comment, and not denied are omitted from the feedback sections entirely

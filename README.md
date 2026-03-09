# firefox-review

A local web UI for reviewing Claude-generated Firefox patches in git worktrees.

## The problem

When you use Claude Code to implement a Firefox bug, the patches land in a dedicated git worktree (e.g. `~/firefox-bugABC`). Reviewing those changes and sending feedback back to Claude is awkward — there's no clean way to annotate specific lines and hand the structured feedback off without manual copy-pasting.

`firefox-review` solves this with a GitHub-style diff viewer that runs locally, lets you leave inline comments, and generates a structured prompt that Claude can act on directly.

## How it works

```
firefox-review bugABC
```

1. Finds the worktree at `~/firefox-bugABC`
2. Computes the diff — all commits above the merge-base with `~/firefox` (central)
3. Starts a local web server and opens the diff viewer in your browser
4. You click any diff line to leave an inline comment
5. Click **"Submit Review to Claude"** — the tool writes `REVIEW_FEEDBACK.md` to the worktree and shows you the one command to run in your terminal

## Setup

**Prerequisites:** Node.js ≥ 18, [Claude Code CLI](https://github.com/anthropics/claude-code)

```bash
git clone https://github.com/alastor0325/firefox-review
cd firefox-review
npm install
npm link          # makes `firefox-review` available globally
```

**Expected directory layout:**

```
~/firefox/              ← main Firefox repo (central)
~/firefox-bugABC/       ← Claude-generated worktree for bugABC
~/firefox-bugXYZ/       ← another worktree
```

## Usage

```bash
firefox-review <bug-id>

# Examples:
firefox-review bugABC
firefox-review bugXYZ
```

The browser opens at `http://localhost:7777` automatically.

### Reviewing

- **Click any diff line** to open an inline comment box
- **Save** the comment — it appears as a yellow annotation beneath the line
- Comments can be edited (click the line again) or deleted (× button)
- The **"Submit Review to Claude"** button is disabled until you have at least one comment

### Submitting feedback

After clicking Submit, the tool:

1. Writes `REVIEW_FEEDBACK.md` to the worktree with this structure:

```
You are being asked to revise your implementation of bugABC.

## Your commits under review:
- a1b2c3d4 bugABC - Part 3: Fire event handlers on global mute.
- e5f6a7b8 bugABC - Part 2: Implement setActive with NotAllowedError semantics.
- c9d0e1f2 bugABC - Part 1: Add new API to WebIDL and wire through utils.

## Reviewer feedback:

### dom/media/ContentPlaybackController.cpp : line 42
[YOUR CODE] : MOZ_ASSERT(mBrowsingContext);
[FEEDBACK]  : Add a message string — MOZ_ASSERT(mBrowsingContext, "must not be null")

### dom/media/MediaControlUtils.h : line 15
[YOUR CODE] : void ToggleCamera(bool aActive);
[FEEDBACK]  : Rename to SetCameraActive to match WebIDL naming

## Instructions:
Address each FEEDBACK item above. Modify only the files and lines mentioned unless a fix
strictly requires touching other code. After making changes, summarize what you changed
for each feedback item.
```

2. Shows you the command to run:

```bash
cd ~/firefox-bugABC && claude --print "$(cat REVIEW_FEEDBACK.md)"
```

Claude receives clearly labeled `[YOUR CODE]` vs `[FEEDBACK]` sections — it never confuses your comments with the code it wrote.

## How Claude distinguishes code from feedback

The prompt format is the key. Every feedback item quotes the exact line Claude wrote (`[YOUR CODE]`) alongside your comment (`[FEEDBACK]`). Claude is instructed to address only the `[FEEDBACK]` items and summarize its changes. The code diff itself is never included in the prompt — only the specific lines you commented on.

## License

MIT

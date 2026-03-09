# firefox-review

A local web UI for reviewing Claude-generated Firefox patches in git worktrees.

## The problem

When you use Claude Code to implement a Firefox bug, the patches land in a dedicated git worktree (e.g. `~/firefox-bugABC`). Reviewing those changes and sending feedback back to Claude is awkward — there's no clean way to annotate specific lines and hand the structured feedback off without manual copy-pasting.

`firefox-review` solves this with a GitHub-style diff viewer that runs locally, lets you leave inline comments per patch, and generates a structured prompt that Claude can act on directly.

## How it works

```
firefox-review bugABC
```

1. Finds the worktree at `~/firefox-bugABC`
2. Computes the diff — splits each commit into its own tab (Part 1, Part 2, …)
3. Starts a local web server and opens the diff viewer in your browser
4. You switch between patch tabs and click any diff line to leave an inline comment
5. Click **"Submit Review for Part N to Claude"** — the tool writes `REVIEW_FEEDBACK_<hash>.md` to the worktree and shows you the one command to run in your terminal

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

The browser opens at `http://localhost:7777` automatically on macOS, Linux, and Windows.

### Reviewing per patch

When a bug has multiple commits, the UI shows **tabs** at the top — one per patch:

```
[ Part 1: Add WebIDL ]  [ Part 2: Implement logic ]  [ Part 3: Fire events ]
```

- Switch tabs to review each patch independently
- Comments are scoped per patch — switching tabs never loses your work
- The tab shows a badge counter once you add comments to it

### Adding comments

- **Click any diff line** to open an inline comment box
- **Save** the comment — it appears as a yellow annotation beneath the line
- Click the annotation to edit it, or × to delete it

### Submitting feedback

After reviewing a patch, click **"Submit Review for Part N to Claude"**. The tool:

1. Writes `REVIEW_FEEDBACK_<hash>.md` to the worktree (one file per patch, no clobbering):

```
You are being asked to revise Part 2 of 3 of your implementation of bugABC.

## Patch under review (Part 2):
- bbb222 bugABC - Part 2: Implement logic  ← THIS PATCH

## Full patch series for context:
- aaa111 bugABC - Part 1: Add WebIDL
- bbb222 bugABC - Part 2: Implement logic  ← THIS PATCH
- ccc333 bugABC - Part 3: Fire events

## Reviewer feedback:

### dom/media/ContentPlaybackController.cpp : line 42
[YOUR CODE] : MOZ_ASSERT(mBrowsingContext);
[FEEDBACK]  : Add a message string — MOZ_ASSERT(mBrowsingContext, "must not be null")

## Instructions:
Address each FEEDBACK item above. This feedback is for Part 2 only — modify only
files changed in that commit unless a fix strictly requires touching other code.
After making changes, summarize what you changed for each feedback item.
```

2. Shows the command to run in your terminal:

**macOS / Linux:**
```bash
cd ~/firefox-bugABC && claude --print "$(cat REVIEW_FEEDBACK_bbb222.md)"
```

**Windows (PowerShell):**
```powershell
cd /d "C:\Users\you\firefox-bugABC" && powershell -Command "Get-Content 'REVIEW_FEEDBACK_bbb222.md' -Raw | claude --print -"
```

## How Claude distinguishes code from feedback

The prompt format is the key. Every feedback item quotes the exact line Claude wrote (`[YOUR CODE]`) alongside your comment (`[FEEDBACK]`). Claude is told which patch to focus on and instructed not to touch other commits. The code diff itself is never included in the prompt — only the specific lines you commented on.

## Development

```bash
npm test              # run all tests
npm run test:watch    # watch mode
npm run test:coverage # coverage report
```

Tests cover:
- `parseDiff` — unit tests for all diff parsing cases (added/removed/context lines, multiple files, binary files, new/deleted files, multiple hunks)
- `formatPrompt` / `submitReview` — unit tests for prompt structure and file output
- Express routes — integration tests for `GET /api/diff` and `POST /api/submit` with mocked git and claude modules

## License

MIT

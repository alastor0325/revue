# Revue

A local web UI for reviewing Git patch series and iterating on them with Claude — browse diffs, leave inline comments, and generate a structured review prompt in one click.

**[→ Interactive demo](https://alastor0325.github.io/revue/docs/)**

## Typical workflow

1. **Ask Claude Code to implement something** in a worktree, e.g. `revue my-feature`.
2. **Open Revue** — `revue my-feature` starts the server and opens the browser automatically.
3. **Browse the diffs** — each commit is a tab. Click any diff line to leave an inline comment, or use the General feedback box for broader concerns. Approve patches that look good, deny ones that need rework.
4. **Click Generate Review Prompt** — Revue writes a structured markdown file and copies the prompt to your clipboard.
5. **Paste into Claude** — Claude reads the per-line feedback, amends the relevant commits, and reports back.
6. **Revue detects the changes** — a banner appears when the worktree HEAD moves. Click reload to pull in the new diffs without losing your session.
7. **Repeat** until all patches are approved.

If you're running Claude on several worktrees in parallel, switch between them from the tab bar at the top — no restart needed.

## Setup

**Prerequisites:** Node.js ≥ 18

```bash
git clone https://github.com/alastor0325/revue
cd revue
npm install
npm link          # makes `revue` available globally
```

## First-time configuration

Tell `revue` which repo to use by default:

```bash
revue init ~/path/to/your/repo
```

This writes `~/.revue/config.json` with your default repo path. Run `init` again any time to change it.

**Expected directory layout** (example with a repo named `myrepo`):

```
~/myrepo/               ← main repo
~/myrepo-feature/       ← a Claude-generated worktree
~/myrepo-experiment/    ← another worktree
```

Worktrees can live anywhere on disk — `revue` discovers them from git's own worktree registry.

## Usage

`revue` always runs as a background daemon — it starts the server, opens your browser, and returns control to the terminal immediately.

```bash
revue                              # start with default repo (from init)
revue --stop                       # stop the running instance
revue --restart                    # restart (picks up server code changes)
revue --port 8080                  # use a specific port instead of 7777
revue my-feature                   # open a specific worktree by name
revue my-feature --port 8080       # worktree + custom port
revue --repo ~/other/repo          # override default repo for this run
revue --repo ~/other/repo feature  # override repo and open specific worktree
```

`<worktree-name>` is the directory basename of the worktree (with the repo name prefix stripped if present, e.g. `myrepo-feature` → `feature`). If omitted, the server starts on the first registered worktree. Switch anytime using the worktree tabs at the top of the page.

The server defaults to port `7777` and increments automatically if that port is busy.

## Reviewing

- **File nav sidebar** — lists changed files with `+`/`-` counts; click to jump, highlights current file on scroll
- **Per-patch tabs** — one tab per commit; badges show comment count `✓` approval `✗` denial `↑` amended
- **Inline comments** — click any diff line or commit message to annotate; drafts are preserved if you close the form
- **Approve / Deny** — mark each patch; denied patches always appear in the generated prompt even without comments
- **Revision detection** — if commits are amended, a revision bar lets you compare old vs new diffs
- **Generate Review Prompt** — writes `REVIEW_FEEDBACK_<worktree>.md` and copies the prompt to clipboard; review state auto-saves to `REVIEW_STATE_<worktree>.json`

→ [Full reviewing reference](docs/reviewing.md)

## Development

```bash
npm test              # run all tests
npm run test:watch    # watch mode
npm run test:coverage # coverage report
```

To run with auto-restart on file changes during development (bypasses daemon mode):

```bash
REVUE_DAEMON=1 npm run dev -- my-feature
```

nodemon watches `src/`, `public/`, and `bin/` and restarts the server on any change. The dev script passes `--no-open` so the browser is not re-opened on every restart — open it manually once, then refresh the tab after each restart.

Alternatively, `revue --restart` is sufficient for one-off server restarts when not actively editing code.

Tests cover:
- **Git module** — `parseDiff`, `parseCommitBody`, `parseWorktreeList`, `getHeadHash`, `getMergeBase` (including origin/main fallback), `getCommits`, `getDiffBetweenCommits`, `lcsCompare`, `getPatchLines`, `getFileLines`
- **Server routes** — all API endpoints with real git repos and real HTTP: `/api/diff`, `/api/state`, `/api/submit`, `/api/headhash`, `/api/reload` (SSE), `/api/revdiff`, `/api/patchdiff/:hash`, `/api/worktrees`, `/api/switch`, `/api/filecontext` (including shell-injection guard)
- **`submitReview`** — combined prompt structure, approved/skipped/denied markers, commit message and inline feedback, multi-patch feedback
- **Worktree switching** — `discoverWorktrees`, `/api/worktrees`, `/api/switch`, cache invalidation, per-worktree state files
- **Browser UI** (real Chromium via Playwright): diff rendering, patch tabs, sidebar nav, approve/deny, inline comments, draft persistence, commit message comments, general feedback, expand-context rows, tab badges, worktree switcher bar, URL hash navigation, revision compare mode, update banner, result overlay, copy-prompt button, error states, empty-worktree state, nested file paths

## License

MIT

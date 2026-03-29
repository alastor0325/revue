---
name: dev
description: >
  Development loop for the revue project: implement a change, self-review the diff,
  run tests, spawn an agent review (simplify), commit, and push. ALL steps are mandatory.
  Use for any feature or bug fix in this repo.
  Triggers on: "dev loop", "/dev", "implement and test", "start dev loop".
allowed-tools: [Read, Edit, Write, Bash, Glob, Grep, AskUserQuestion]
---

# Revue Dev Loop

This is the development loop for the **revue** project. Every cycle goes:

```
Develop → Self-Review → Test → Agent Review → Commit → Push → (fix & repeat if needed)
```

**IMPORTANT: ALL steps are mandatory for every code change. Do not respond as done until commit and push are complete.**

Project rules (from CLAUDE.md):
- Every code change **must** include a corresponding test in the same response.
- **All tests must pass before committing.** A failing test is a hard blocker — fix it, do not skip or suppress.
- **Always add integration tests when possible.** If the change touches `src/git.js`, `src/server.js`, or `bin/revue.js`, add or update a test in `test/integration.test.js` that exercises the real code path (real git commands, real HTTP, real file I/O — no mocks). Unit tests alone are not sufficient for server and git module changes.
- If the change affects user-facing behavior or CLI flags, update README.md.

---

## Step 1 — Understand the Task

Read the relevant source files before touching anything. Understand existing code before modifying it.

Key paths:
- `src/` — server logic and shared modules
- `public/` — frontend JS/HTML/CSS (vanilla, no build step)
- `bin/revue.js` — CLI entry point
- `test/` — Jest tests (Node env for server, jsdom for frontend)

```bash
# Get oriented
ls src/ public/ test/
```

---

## Step 2 — Develop

Make the minimal change needed. Do not add features, refactor surrounding code, or add comments beyond what is necessary.

**Always write or update the test first** (TDD-style) so you know exactly what "done" looks like, then implement.

---

## Step 3 — Self-Review

After writing code, review every file you touched. Ask yourself:
- Does this introduce any security issues (XSS, command injection, path traversal)?
- Is this the minimum change needed, or did I over-engineer?
- Does every new code path have test coverage?
- Did I change user-facing behavior without updating README?

```bash
# Review your diff
git diff
```

Fix any issues found before running tests.

---

## Step 4 — Test

```bash
npm test
```

**If tests pass**: proceed to Step 5.

**If tests fail**: read the failure output carefully, fix the root cause (do NOT skip or suppress), then go back to Step 3. Do not loop more than 3 times before asking the user what's wrong.

---

## Step 5 — Agent Review

Spawn a `simplify` agent to review the changed code for reuse, quality, and efficiency:

```
/simplify
```

Wait for the agent to finish. If it finds issues, fix them and go back to Step 3. Only proceed when the agent review is clean.

---

## Step 6 — Commit & Push

```bash
git add <changed files>
git commit -m "<message>"
git push
```

Commit message must describe *why*, not just what. Do not use `--no-verify`.

---

## Step 7 — Loop or Done

If the task is complete, summarize:
- What was changed and why
- Which tests cover it
- Any README updates made

If there is more to do (e.g. multi-part task), start the next cycle at Step 1.

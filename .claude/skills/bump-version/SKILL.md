---
description: >
  Release a new revue version: bump package.json, commit, tag, push, THEN file an
  issue on the fx-bug-toolkit repo requesting it require the new revue version
  (fx-bug-toolkit's /open-review skill installs revue from github:alastor0325/revue,
  so it must be told to bump the version it pins/verifies). The fx-bug-toolkit
  issue step is MANDATORY — a version bump is not done until that issue is filed.
  Triggers on: "bump version", "/bump-version", "release revue", "cut a release",
  "new revue version", "publish revue".
allowed-tools: [Read, Edit, Bash, AskUserQuestion]
---

# Revue Version Bump

Bumping revue's version has a downstream obligation: the **fx-bug-toolkit**
consumer installs revue from `github:alastor0325/revue` (its `/open-review`
skill), so every bump must be mirrored by an issue asking fx-bug-toolkit to
require the new version.

**MANDATORY: the bump is not complete until the fx-bug-toolkit issue is filed
(Step 5). Do not report done before then.**

The downstream repo is **`alastor0325/fx-bug-toolkit`**.

---

## Step 1 — Decide the new version

Read the current version:

```bash
node -p "require('./package.json').version"
```

If the caller specified a level (`patch`/`minor`/`major`) or an explicit version,
use it. Otherwise use `AskUserQuestion` to choose patch / minor / major, showing
what each resolves to from the current version (semver).

Set `OLD` and `NEW` for later steps.

---

## Step 2 — Bump package.json

Edit only the `version` field — do not let any other tooling rewrite the file.

```bash
node -e "const p=require('./package.json'); p.version='NEW'; require('fs').writeFileSync('./package.json', JSON.stringify(p,null,2)+'\n')"
node -p "require('./package.json').version"   # confirm
```

---

## Step 3 — Test

Per CLAUDE.md, the tree must be green before committing:

```bash
npm test
```

A failing test is a hard blocker. Note: the Playwright UI tests in
`test/ui.test.js` for the update banner / worktree-switch polling are known to be
flaky on slow machines (5s timeouts) — if ONLY those fail, confirm they also fail
on a clean checkout before treating them as unrelated; never use that as cover for
a real regression.

---

## Step 4 — Commit, tag, push

Stage only `package.json` plus any source/test files that belong to this release
(never stray artifacts). Then:

```bash
git add package.json <other release files>
git commit -m "chore: release vNEW

<one-line summary of what this release contains>"
git tag vNEW
git push origin <current-branch>
git push origin vNEW
```

If you are amending an unpushed release commit, `git tag -f vNEW` and
`git push -f origin vNEW` are acceptable **only while the tag has not been
pushed**. Never force-move a tag that is already on origin.

---

## Step 5 — File the fx-bug-toolkit issue (MANDATORY)

Collect what changed since the previous tag so the issue is actionable:

```bash
PREV=$(git describe --tags --abbrev=0 vNEW^ 2>/dev/null || echo "")
[ -n "$PREV" ] && git log --oneline "$PREV"..vNEW || git log --oneline -10 vNEW
```

Then file the issue. Write the body to a temp file to avoid shell-quoting issues,
and remove it afterward:

```bash
gh issue create -R alastor0325/fx-bug-toolkit \
  --title "/open-review: require revue >= NEW" \
  --label enhancement \
  --body-file /tmp/revue-bump-issue.md
```

The body must include:
- The new version **NEW** and the previous version **OLD**.
- A short changelog (the `git log` from above) — what behavior changed and why it
  matters to `/open-review` users.
- The concrete ask: the `/open-review` skill installs revue from
  `github:alastor0325/revue`; it should require/verify `revue >= NEW` and offer to
  reinstall/upgrade when older.
- The source: the revue commit hash and tag `vNEW`.

Report the created issue URL.

---

## Step 6 — Summary

Report: old → new version, the pushed tag, the changelog, and the fx-bug-toolkit
issue URL. If the fx-bug-toolkit issue was NOT filed for any reason, say so loudly
— the release is incomplete.

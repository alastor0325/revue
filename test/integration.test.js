'use strict';

/**
 * Integration tests — no mocks. Real git commands, real Express server,
 * real HTTP requests, real file I/O.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

const {
  getHeadHash, getCommits, getDiffPerCommit, getFileLines,
  getDiffForCommit, getDiffBetweenCommits, discoverWorktrees, getMergeBase,
} = require('../src/git');
const { createApp, startServer, findAvailablePort } = require('../src/server');
const { git, stateFilePathFor } = require('./helpers');

// ── Helpers ────────────────────────────────────────────────────────────────

function httpRequest(url, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method,
      ...(data && { headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }),
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
        catch { resolve({ status: res.statusCode, body: out }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Shared git fixtures ────────────────────────────────────────────────────

let tmpDir;
let mainRepoPath;
let workRepoPath;
let commitHash;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-integration-'));
  mainRepoPath = path.join(tmpDir, 'main-repo');
  workRepoPath = path.join(tmpDir, 'work-repo');

  fs.mkdirSync(mainRepoPath);
  git(mainRepoPath, 'init');
  git(mainRepoPath, 'config user.email "test@test.com"');
  git(mainRepoPath, 'config user.name "Test"');
  fs.writeFileSync(path.join(mainRepoPath, 'base.txt'), 'base content\n');
  git(mainRepoPath, 'add .');
  git(mainRepoPath, 'commit -m "initial commit"');

  execSync(`git clone "${mainRepoPath}" "${workRepoPath}"`, { encoding: 'utf8' });
  git(workRepoPath, 'config user.email "test@test.com"');
  git(workRepoPath, 'config user.name "Test"');
  fs.writeFileSync(
    path.join(workRepoPath, 'feature.js'),
    'function hello() {\n  return "hello";\n}\n'
  );
  git(workRepoPath, 'add .');
  git(workRepoPath, 'commit -m "feat: add hello function"');
  commitHash = git(workRepoPath, 'rev-parse HEAD');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── git.js integration ────────────────────────────────────────────────────

describe('git integration', () => {
  test('getHeadHash returns the real HEAD commit hash', () => {
    const hash = getHeadHash(workRepoPath);
    expect(hash).toBe(commitHash);
  });

  test('getHeadHash returns null for a directory without commits', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-empty-'));
    try {
      git(empty, 'init');
      expect(getHeadHash(empty)).toBeNull();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test('getHeadHash matches git after refs are packed', () => {
    // pack-refs removes the loose ref file, forcing the packed-refs lookup path.
    git(workRepoPath, 'pack-refs --all');
    expect(fs.existsSync(path.join(workRepoPath, '.git', 'refs', 'heads', git(workRepoPath, 'rev-parse --abbrev-ref HEAD')))).toBe(false);
    expect(getHeadHash(workRepoPath)).toBe(git(workRepoPath, 'rev-parse HEAD'));
  });

  test('getHeadHash matches git for a detached HEAD', () => {
    const det = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-detach-'));
    try {
      execSync(`git clone "${mainRepoPath}" "${det}"`, { encoding: 'utf8' });
      git(det, `checkout --detach ${git(det, 'rev-parse HEAD')}`);
      expect(getHeadHash(det)).toBe(git(det, 'rev-parse HEAD'));
    } finally {
      fs.rmSync(det, { recursive: true, force: true });
    }
  });

  test('getHeadHash matches git for a linked worktree', () => {
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-link-'));
    const linked = path.join(linkParent, 'wt');
    try {
      git(workRepoPath, `worktree add -b wt-branch "${linked}"`);
      expect(getHeadHash(linked)).toBe(git(linked, 'rev-parse HEAD'));
    } finally {
      git(workRepoPath, `worktree remove --force "${linked}"`);
      fs.rmSync(linkParent, { recursive: true, force: true });
    }
  });

  test('getDiffPerCommit throws baseTooFar when the series exceeds maxCommits', () => {
    // Real git: workRepoPath is 1 commit ahead of its base. A cap of 0 makes the
    // nearest base "too far", so it must throw the actionable error rather than
    // attempt the diff — the mechanism that prevents the esr infinite-load.
    let thrown;
    try { getDiffPerCommit(workRepoPath, mainRepoPath, 0); } catch (e) { thrown = e; }
    expect(thrown && thrown.baseTooFar).toBe(true);
    expect(thrown.message).toMatch(/Refusing to diff/);
    // With the default cap the same worktree still yields its real series.
    expect(getDiffPerCommit(workRepoPath, mainRepoPath).length).toBeGreaterThan(0);
  });

  test('getCommits returns commits ahead of the main repo', () => {
    const commits = getCommits(workRepoPath, mainRepoPath);
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe('feat: add hello function');
    expect(commits[0].hash).toMatch(/^[0-9a-f]+$/);
  });

  test('getCommits includes the committer date as ISO-8601 matching git', () => {
    const commits = getCommits(workRepoPath, mainRepoPath);
    const gitDate = git(workRepoPath, `show -s --format=%cI ${commitHash}`);
    expect(commits[0].date).toBe(gitDate);
    // Must be a parseable timestamp the UI can format.
    expect(Number.isNaN(Date.parse(commits[0].date))).toBe(false);
  });

  test('getCommits returns [] when worktree has no commits ahead of main', () => {
    const commits = getCommits(mainRepoPath, mainRepoPath);
    expect(commits).toEqual([]);
  });

  test('getDiffPerCommit returns parsed diff from real git show output', () => {
    const patches = getDiffPerCommit(workRepoPath, mainRepoPath);
    expect(patches).toHaveLength(1);

    const patch = patches[0];
    expect(patch.message).toBe('feat: add hello function');
    expect(typeof patch.body).toBe('string');
    expect(patch.body).toContain('feat: add hello function');
    // git log --oneline produces an abbreviated hash
    expect(commitHash.startsWith(patch.hash)).toBe(true);
    expect(patch.files).toHaveLength(1);
    expect(patch.files[0].newPath).toBe('feature.js');

    const lines = patch.files[0].hunks[0].lines;
    const added = lines.filter((l) => l.type === 'added').map((l) => l.content);
    expect(added).toContain('function hello() {');
    expect(added).toContain('  return "hello";');
    expect(added).toContain('}');
  });

  // getDiffPerCommit reads the whole series with a single `git log -p` and
  // splits it into per-commit blocks. This guards that each commit is matched
  // to its OWN files (and message/body), with no cross-commit leakage.
  test('getDiffPerCommit isolates each commit to its own files across a multi-commit series', () => {
    const md = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-multi-'));
    const main = path.join(md, 'main');
    const work = path.join(md, 'work');
    try {
      fs.mkdirSync(main);
      git(main, 'init');
      git(main, 'config user.email "test@test.com"');
      git(main, 'config user.name "Test"');
      fs.writeFileSync(path.join(main, 'alpha.js'), 'const a = 0;\n');
      git(main, 'add .');
      git(main, 'commit -m "initial"');

      execSync(`git clone "${main}" "${work}"`, { encoding: 'utf8' });
      git(work, 'config user.email "test@test.com"');
      git(work, 'config user.name "Test"');

      fs.writeFileSync(path.join(work, 'alpha.js'), 'const a = 1;\n');
      git(work, 'add .');
      git(work, 'commit -m "feat: change alpha" -m "Body for alpha."');

      fs.writeFileSync(path.join(work, 'beta.js'), 'const b = 1;\n');
      fs.writeFileSync(path.join(work, 'gamma.js'), 'const g = 1;\n');
      git(work, 'add .');
      git(work, 'commit -m "feat: add beta and gamma"');

      fs.writeFileSync(path.join(work, 'alpha.js'), 'const a = 2;\n');
      git(work, 'add .');
      git(work, 'commit -m "fix: alpha again"');

      const patches = getDiffPerCommit(work, main);
      expect(patches.map((p) => p.message)).toEqual([
        'feat: change alpha', 'feat: add beta and gamma', 'fix: alpha again',
      ]);
      // Each commit shows only the files it changed — no leakage from siblings.
      expect(patches[0].files.map((f) => f.newPath)).toEqual(['alpha.js']);
      expect(patches[1].files.map((f) => f.newPath)).toEqual(['beta.js', 'gamma.js']);
      expect(patches[2].files.map((f) => f.newPath)).toEqual(['alpha.js']);
      // Full multi-line body is preserved for the first commit.
      expect(patches[0].body).toContain('Body for alpha.');
    } finally {
      fs.rmSync(md, { recursive: true, force: true });
    }
  });

  test('getFileLines returns real file content at a commit', () => {
    const result = getFileLines(workRepoPath, commitHash, 'feature.js', 1, 2);
    expect(result.totalLines).toBe(3);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toMatchObject({ type: 'context', content: 'function hello() {', newLineNum: 1 });
    expect(result.lines[1]).toMatchObject({ type: 'context', content: '  return "hello";', newLineNum: 2 });
  });

  test('getFileLines clamps end to totalLines', () => {
    const result = getFileLines(workRepoPath, commitHash, 'feature.js', 1, 100);
    expect(result.totalLines).toBe(3);
    expect(result.lines).toHaveLength(3);
  });

  test('getDiffForCommit returns real parsed diff for a specific commit', () => {
    const files = getDiffForCommit(workRepoPath, commitHash);
    expect(files).toHaveLength(1);
    expect(files[0].newPath).toBe('feature.js');
    const added = files[0].hunks[0].lines.filter((l) => l.type === 'added').map((l) => l.content);
    expect(added).toContain('function hello() {');
    expect(added).toContain('  return "hello";');
  });

  // A commit that deletes a file must expose the deleted path (oldPath), not a
  // null/"/dev/null" newPath that the UI would render as the filename "null".
  test('a commit deleting a file keeps the deleted path as oldPath with newPath null', () => {
    const md = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-del-'));
    const main = path.join(md, 'main');
    const work = path.join(md, 'work');
    try {
      fs.mkdirSync(main);
      git(main, 'init');
      git(main, 'config user.email "test@test.com"');
      git(main, 'config user.name "Test"');
      fs.writeFileSync(path.join(main, 'doomed.js'), 'const a = 1;\nconst b = 2;\n');
      git(main, 'add .');
      git(main, 'commit -m "initial"');

      execSync(`git clone "${main}" "${work}"`, { encoding: 'utf8' });
      git(work, 'config user.email "test@test.com"');
      git(work, 'config user.name "Test"');
      fs.rmSync(path.join(work, 'doomed.js'));
      git(work, 'add -A');
      git(work, 'commit -m "feat: remove doomed.js"');

      const patches = getDiffPerCommit(work, main);
      expect(patches).toHaveLength(1);
      const file = patches[0].files[0];
      expect(file.oldPath).toBe('doomed.js');
      expect(file.newPath).toBeNull();
      // The path the UI displays (newPath || oldPath) is the real file.
      expect(file.newPath || file.oldPath).toBe('doomed.js');
    } finally {
      fs.rmSync(md, { recursive: true, force: true });
    }
  });

  test('a commit adding a binary file lists it (flagged binary, with path, no hunks)', () => {
    const md = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-bin-'));
    const main = path.join(md, 'main');
    const work = path.join(md, 'work');
    try {
      fs.mkdirSync(main);
      git(main, 'init');
      git(main, 'config user.email "test@test.com"');
      git(main, 'config user.name "Test"');
      fs.writeFileSync(path.join(main, 'base.txt'), 'base\n');
      git(main, 'add .');
      git(main, 'commit -m "initial"');

      execSync(`git clone "${main}" "${work}"`, { encoding: 'utf8' });
      git(work, 'config user.email "test@test.com"');
      git(work, 'config user.name "Test"');
      fs.writeFileSync(path.join(work, 'video.mp4'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00]));
      git(work, 'add .');
      git(work, 'commit -m "feat: add a video"');

      const patches = getDiffPerCommit(work, main);
      expect(patches).toHaveLength(1);
      const file = patches[0].files.find((f) => (f.newPath || f.oldPath) === 'video.mp4');
      expect(file).toBeTruthy();       // not dropped
      expect(file.binary).toBe(true);
      expect(file.hunks).toEqual([]);  // content not parsed
    } finally {
      fs.rmSync(md, { recursive: true, force: true });
    }
  });
});

// ── server integration (real Express, no git mocks) ───────────────────────

describe('server HTTP integration', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    const app = createApp({
      worktreeName: 'work-repo',
      worktreePath: workRepoPath,
      mainRepoPath,
    });
    const port = await findAvailablePort(19200);
    await new Promise((resolve) => {
      server = app.listen(port, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll((done) => { server.close(done); });

  test('GET /api/headhash returns real HEAD hash', async () => {
    const { status, body } = await httpRequest(`${baseUrl}/api/headhash`);
    expect(status).toBe(200);
    expect(body.hash).toBe(commitHash);
  });

  test('GET /api/diff returns real parsed patches', async () => {
    const { status, body } = await httpRequest(`${baseUrl}/api/diff`);
    expect(status).toBe(200);
    expect(body.repoName).toBe('main-repo');
    expect(body.worktreeName).toBe('work-repo');
    expect(body.patches).toHaveLength(1);
    expect(body.patches[0].message).toBe('feat: add hello function');
    expect(body.patches[0].files[0].newPath).toBe('feature.js');
    // The patch heading shows the last-modified time, so the date must survive
    // the JSON round-trip as a parseable ISO string.
    expect(typeof body.patches[0].date).toBe('string');
    expect(Number.isNaN(Date.parse(body.patches[0].date))).toBe(false);
  });

  test('GET /api/diff returns consistent data on repeated calls', async () => {
    const r1 = await httpRequest(`${baseUrl}/api/diff`);
    const r2 = await httpRequest(`${baseUrl}/api/diff`);
    expect(r1.body.patches[0].hash).toBe(r2.body.patches[0].hash);
  });

  // The client seeds its update-detection baseline from /api/diff's headHash,
  // so it must equal the worktree's real HEAD (and what /api/headhash returns).
  test('GET /api/diff reports the HEAD hash, matching /api/headhash', async () => {
    const diff = await httpRequest(`${baseUrl}/api/diff`);
    const head = await httpRequest(`${baseUrl}/api/headhash`);
    expect(diff.body.headHash).toBe(commitHash);
    expect(diff.body.headHash).toBe(head.body.hash);
  });

  test('GET /api/state returns empty state initially', async () => {
    const { status, body } = await httpRequest(`${baseUrl}/api/state`);
    expect(status).toBe(200);
    expect(body.prompt).toBeNull();
  });

  test('POST /api/state persists state; GET /api/state retrieves it', async () => {
    const payload = { approvals: { [commitHash]: true } };
    const post = await httpRequest(`${baseUrl}/api/state`, { method: 'POST', body: payload });
    expect(post.status).toBe(200);
    expect(post.body.ok).toBe(true);

    const get = await httpRequest(`${baseUrl}/api/state`);
    expect(get.status).toBe(200);
    expect(get.body.approvals).toEqual({ [commitHash]: true });
  });

  test('POST /api/state persists compareRevision; GET /api/state retrieves it — compare button depends on this', async () => {
    const compareRevision = { 0: { from: 'abc123', to: 'def456' } };
    await httpRequest(`${baseUrl}/api/state`, { method: 'POST', body: { compareRevision } });
    const { status, body } = await httpRequest(`${baseUrl}/api/state`);
    expect(status).toBe(200);
    expect(body.compareRevision).toEqual(compareRevision);
    await httpRequest(`${baseUrl}/api/state`, { method: 'POST', body: { compareRevision: {} } });
  });

  test('GET /api/state preserves revision order — UI depends on this to show latest first', async () => {
    const revisions = [
      { savedAt: '2024-01-01T00:00:00.000Z', patches: [{ hash: 'aaa', message: 'first' }] },
      { savedAt: '2024-01-02T00:00:00.000Z', patches: [{ hash: 'bbb', message: 'second' }] },
      { savedAt: '2024-01-03T00:00:00.000Z', patches: [{ hash: 'ccc', message: 'third' }] },
    ];
    await httpRequest(`${baseUrl}/api/state`, { method: 'POST', body: { revisions } });
    const { status, body } = await httpRequest(`${baseUrl}/api/state`);
    expect(status).toBe(200);
    expect(body.revisions).toHaveLength(3);
    // Server must return revisions oldest-first; the UI reverses this for display
    expect(body.revisions[0].savedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(body.revisions[2].savedAt).toBe('2024-01-03T00:00:00.000Z');
    // Clean up
    await httpRequest(`${baseUrl}/api/state`, { method: 'POST', body: { revisions: [] } });
  });

  // The revision toggle bar shows each revision's committer date, which the
  // client stores inside the per-patch snapshot. That date must survive the
  // state round-trip or a reload would fall back to the snapshot save time.
  test('GET /api/state preserves the committer date stored in a revision snapshot', async () => {
    const revisions = [
      { savedAt: '2024-01-01T00:00:00.000Z', patches: [{ hash: 'aaa', message: 'first', date: '2026-06-01T09:15:00+00:00' }] },
    ];
    await httpRequest(`${baseUrl}/api/state`, { method: 'POST', body: { revisions } });
    const { status, body } = await httpRequest(`${baseUrl}/api/state`);
    expect(status).toBe(200);
    expect(body.revisions[0].patches[0].date).toBe('2026-06-01T09:15:00+00:00');
    await httpRequest(`${baseUrl}/api/state`, { method: 'POST', body: { revisions: [] } });
  });

  test('GET /api/filecontext returns real file lines', async () => {
    const shortHash = commitHash.slice(0, 8);
    const { status, body } = await httpRequest(
      `${baseUrl}/api/filecontext?hash=${shortHash}&file=feature.js&start=1&end=2`
    );
    expect(status).toBe(200);
    expect(body.lines[0].content).toBe('function hello() {');
    expect(body.totalLines).toBe(3);
    // The UI derives a per-line comment key from newLineNum, so expanded
    // context lines must carry the line numbers for the requested range.
    expect(body.lines[0].newLineNum).toBe(1);
    expect(body.lines[1].newLineNum).toBe(2);
  });

  test('GET /api/filecontext with bad params returns 400', async () => {
    const { status } = await httpRequest(`${baseUrl}/api/filecontext?hash=abc123&file=f.js&start=5&end=3`);
    expect(status).toBe(400);
  });

  test('GET /api/filecontext rejects file path containing double-quote (shell injection guard)', async () => {
    const shortHash = commitHash.slice(0, 8);
    // A " in the file path would break shell quoting in: git show "${hash}:${file}"
    const badFile = encodeURIComponent('feature.js"; echo pwned #');
    const { status } = await httpRequest(
      `${baseUrl}/api/filecontext?hash=${shortHash}&file=${badFile}&start=1&end=5`
    );
    expect(status).toBe(400);
  });

  test('GET /api/filecontext returns 404 for a non-existent file at a valid commit', async () => {
    const shortHash = commitHash.slice(0, 8);
    const { status, body } = await httpRequest(
      `${baseUrl}/api/filecontext?hash=${shortHash}&file=does-not-exist.js&start=1&end=5`
    );
    expect(status).toBe(404);
    expect(body.error).toMatch(/Could not read file/i);
  });

  test('GET /api/revdiff with invalid hashes returns 400', async () => {
    const { status, body } = await httpRequest(`${baseUrl}/api/revdiff?from=notahash&to=alsonotahash`);
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid hash/i);
  });

  test('POST /api/submit with empty allFeedback returns 400', async () => {
    const { status, body } = await httpRequest(`${baseUrl}/api/submit`, { method: 'POST', body: { allFeedback: [] } });
    expect(status).toBe(400);
    expect(body.error).toMatch(/no feedback/i);
  });

  test('POST /api/switch to unknown worktree returns 404', async () => {
    const { status, body } = await httpRequest(`${baseUrl}/api/switch`, { method: 'POST', body: { worktreeName: 'nonexistent' } });
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });

  test('POST /api/switch with missing worktreeName returns 400', async () => {
    const { status, body } = await httpRequest(`${baseUrl}/api/switch`, { method: 'POST', body: {} });
    expect(status).toBe(400);
    expect(body.error).toMatch(/required/i);
  });

  test('POST /api/submit with only deniedHashes (no comments, no approvals) returns 200', async () => {
    const allFeedback = [{ hash: commitHash, comments: [], generalComment: '' }];
    const { status, body } = await httpRequest(`${baseUrl}/api/submit`, {
      method: 'POST',
      body: { allFeedback, approvedHashes: [], deniedHashes: [commitHash] },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.feedbackPath).toContain('REVIEW_FEEDBACK');
    expect(fs.existsSync(body.feedbackPath)).toBe(true);
    fs.unlinkSync(body.feedbackPath);
  });

  test('GET /api/patchdiff/:hash returns real parsed diff for the commit', async () => {
    const shortHash = commitHash.slice(0, 8);
    const { status, body } = await httpRequest(`${baseUrl}/api/patchdiff/${shortHash}`);
    expect(status).toBe(200);
    expect(body.hash).toBe(shortHash);
    expect(body.files).toHaveLength(1);
    expect(body.files[0].newPath).toBe('feature.js');
    const added = body.files[0].hunks[0].lines.filter((l) => l.type === 'added').map((l) => l.content);
    expect(added).toContain('function hello() {');
  });

  test('GET /api/worktrees lists the main repo', async () => {
    const { status, body } = await httpRequest(`${baseUrl}/api/worktrees`);
    expect(status).toBe(200);
    expect(body.current).toBe('work-repo');
    expect(Array.isArray(body.worktrees)).toBe(true);
    expect(body.worktrees.some((w) => w.isMain)).toBe(true);
    expect(body.worktrees.some((w) => w.worktreeName === 'work-repo')).toBe(false); // work-repo is a clone, not a real git worktree
  });

  test('POST /api/submit success path writes feedback file and returns prompt', async () => {
    const allFeedback = [{ hash: commitHash, comments: [], generalComment: 'LGTM' }];
    const { status, body } = await httpRequest(`${baseUrl}/api/submit`, {
      method: 'POST',
      body: { allFeedback, approvedHashes: [commitHash], deniedHashes: [] },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.feedbackPath).toContain('REVIEW_FEEDBACK_work-repo.md');
    expect(fs.existsSync(body.feedbackPath)).toBe(true);
    expect(typeof body.prompt).toBe('string');
    expect(body.prompt.length).toBeGreaterThan(0);
    fs.unlinkSync(body.feedbackPath);
  });

  test('after submit, approved is preserved but denied/comments are cleared on disk', async () => {
    // Simulate having comments and both approved and denied saved before submit
    const priorState = { comments: { abc: { 'file.js': { L1: { text: 'nit' } } } }, generalComments: { abc: 'Overall ok' }, approved: [commitHash], denied: ['other'] };
    await httpRequest(`${baseUrl}/api/state`, { method: 'POST', body: priorState });

    // Submit generates the feedback file
    const allFeedback = [{ hash: commitHash, comments: [], generalComment: 'LGTM' }];
    const submitRes = await httpRequest(`${baseUrl}/api/submit`, {
      method: 'POST',
      body: { allFeedback, approvedHashes: [commitHash], deniedHashes: [] },
    });
    expect(submitRes.status).toBe(200);

    // Client keeps approved but clears denied/comments after successful submit
    const clearRes = await httpRequest(`${baseUrl}/api/state`, {
      method: 'POST',
      body: { comments: {}, generalComments: {}, approved: [commitHash], denied: [] },
    });
    expect(clearRes.status).toBe(200);

    // Subsequent GET /api/state: approved preserved, feedback cleared
    const { status, body } = await httpRequest(`${baseUrl}/api/state`);
    expect(status).toBe(200);
    expect(body.comments).toEqual({});
    expect(body.generalComments).toEqual({});
    expect(body.approved).toEqual([commitHash]);
    expect(body.denied).toEqual([]);

    fs.unlinkSync(submitRes.body.feedbackPath);
  });

  test('POST /api/state round-trips drafts so refresh restores unsaved comment text', async () => {
    // Drafts are unsaved comment textarea contents — they must persist to disk
    // so a page reload (or a second tab) sees them, not get wiped.
    const drafts = {
      [`${commitHash}/feature.js/n1`]: 'WIP: this name is unclear',
      [`${commitHash}/__commit__/msg`]: 'WIP: needs a bug link',
    };
    const postRes = await httpRequest(`${baseUrl}/api/state`, {
      method: 'POST',
      body: { comments: {}, generalComments: {}, approved: [], denied: [], drafts },
    });
    expect(postRes.status).toBe(200);

    const { status, body } = await httpRequest(`${baseUrl}/api/state`);
    expect(status).toBe(200);
    expect(body.drafts).toEqual(drafts);

    // Clean up so subsequent tests start from a known state
    await httpRequest(`${baseUrl}/api/state`, {
      method: 'POST',
      body: { comments: {}, generalComments: {}, approved: [], denied: [], drafts: {} },
    });
  });

  test('GET /api/state returns prompt from existing REVIEW_FEEDBACK MD file', async () => {
    const mdPath = path.join(workRepoPath, 'REVIEW_FEEDBACK_work-repo.md');
    fs.writeFileSync(mdPath, 'pre-existing review prompt', 'utf8');
    try {
      const { status, body } = await httpRequest(`${baseUrl}/api/state`);
      expect(status).toBe(200);
      expect(body.prompt).toBe('pre-existing review prompt');
    } finally {
      fs.unlinkSync(mdPath);
    }
  });

  // A state file that exists but can't be parsed must be flagged `unreadable`,
  // NOT returned as an empty {} — otherwise the client treats it as a clean
  // empty start and overwrites the (recoverable) file, destroying approvals.
  test('GET /api/state flags an existing-but-corrupt state file as unreadable', async () => {
    const statePath = stateFilePathFor(workRepoPath);
    let existing = null;
    try { existing = fs.readFileSync(statePath, 'utf8'); } catch {}
    fs.writeFileSync(statePath, 'not valid json!!!', 'utf8');
    try {
      const { status, body } = await httpRequest(`${baseUrl}/api/state`);
      expect(status).toBe(200);
      expect(body.unreadable).toBe(true);
      // Crucially it must NOT look like clean saved state.
      expect(body.approved).toBeUndefined();
      expect(body.revisions).toBeUndefined();
    } finally {
      if (existing !== null) fs.writeFileSync(statePath, existing, 'utf8');
      else try { fs.unlinkSync(statePath); } catch {}
    }
  });

  test('GET /api/state does NOT flag unreadable when no state file exists', async () => {
    const statePath = stateFilePathFor(workRepoPath);
    const legacyPath = path.join(workRepoPath, 'REVIEW_STATE_work-repo.json');
    let existing = null;
    try { existing = fs.readFileSync(statePath, 'utf8'); } catch {}
    try { fs.unlinkSync(statePath); } catch {}
    try { fs.unlinkSync(legacyPath); } catch {} // ensure migration can't resurrect
    try {
      const { status, body } = await httpRequest(`${baseUrl}/api/state`);
      expect(status).toBe(200);
      expect(body.unreadable).toBeUndefined(); // clean empty start, safe to baseline
    } finally {
      if (existing !== null) fs.writeFileSync(statePath, existing, 'utf8');
    }
  });

  // State is persisted inside the worktree's git dir, NOT as a loose file in
  // the working tree (where it showed up as untracked and got deleted as a
  // mistaken stray artifact — the original data-loss bug).
  test('a state write lands in the git dir, not the working tree', async () => {
    await httpRequest(`${baseUrl}/api/state`, {
      method: 'POST',
      body: { comments: {}, generalComments: {}, approved: ['h1'], denied: [] },
    });
    const gitDirState = stateFilePathFor(workRepoPath);
    expect(fs.existsSync(gitDirState)).toBe(true);
    expect(gitDirState).toContain('.git');
    // No loose REVIEW_STATE file left in the working tree.
    const looseInWorktree = fs.readdirSync(workRepoPath).filter((f) => f.startsWith('REVIEW_STATE_'));
    expect(looseInWorktree).toEqual([]);
    const { body } = await httpRequest(`${baseUrl}/api/state`);
    expect(body.approved).toEqual(['h1']);
    // reset
    await httpRequest(`${baseUrl}/api/state`, { method: 'POST', body: { approved: [], denied: [] } });
  });

  test('GET /api/reload sends SSE stream with server token', async () => {
    const raw = await new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}/api/reload`, (res) => {
        expect(res.headers['content-type']).toMatch('text/event-stream');
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          if (data.includes('data:')) {
            req.destroy();
          }
        });
        // close always fires after destroy; data is fully accumulated by this point
        res.on('close', () => resolve(data));
      });
      req.on('error', (err) => {
        if (err.code !== 'ECONNRESET') reject(err);
      });
    });
    expect(raw).toMatch(/^data: \S+/m);
  });

  test('GET /api/diff recomputes patches after a new commit is made to the worktree', async () => {
    const before = await httpRequest(`${baseUrl}/api/diff`);
    expect(before.body.patches).toHaveLength(1);

    fs.writeFileSync(path.join(workRepoPath, 'extra.js'), 'const extra = 1;\n');
    git(workRepoPath, 'add .');
    git(workRepoPath, 'commit -m "extra: cache invalidation test"');
    try {
      const after = await httpRequest(`${baseUrl}/api/diff`);
      expect(after.status).toBe(200);
      expect(after.body.patches).toHaveLength(2);
      expect(after.body.patches[1].message).toBe('extra: cache invalidation test');
    } finally {
      git(workRepoPath, `reset --hard ${commitHash}`);
    }
  });

  test('GET /api/patchdiff/:hash returns 404 when hash does not exist in the repo', async () => {
    const { status, body } = await httpRequest(`${baseUrl}/api/patchdiff/deadbeef1234`);
    expect(status).toBe(404);
    expect(body.error).toMatch(/deadbeef1234/);
  });

  // The sidebar's sticky offset is driven by the --top-bar-height custom
  // property declared in style.css. If the served CSS ever lacks the variable
  // reference, the sidebar would silently revert to the buggy `top: 0`
  // behavior under the top bar.
  // Browsers will request /favicon.svg on every page load — the server must
  // serve it with the correct content type, and the file must contain the
  // brand colors so a future refactor can't silently drop the design.
  test('GET /favicon.svg returns the brand-coloured SVG', async () => {
    const { status, body } = await httpRequest(`${baseUrl}/favicon.svg`);
    expect(status).toBe(200);
    expect(typeof body).toBe('string');
    expect(body).toMatch(/<svg[^>]*viewBox="0 0 64 64"/);
    expect(body).toMatch(/fill="#0b0d10"/);  // app background
    expect(body).toMatch(/fill="#ebe5d6"/);  // wordmark cream
    expect(body).toMatch(/fill="#3fb950"/);  // approve-green underline
    expect(body).toMatch(/>R</);             // the letter mark itself
  });

  // The HTML must link to the favicon, otherwise the browser falls back to
  // the generic globe icon even though the SVG ships fine.
  test('GET / serves HTML that links to favicon.svg', async () => {
    const { status, body } = await httpRequest(`${baseUrl}/`);
    expect(status).toBe(200);
    expect(body).toMatch(/<link\s+rel="icon"[^>]*type="image\/svg\+xml"[^>]*href="favicon\.svg"/);
  });

  // The back-to-top control must ship in the HTML and be a fixed-position
  // element hidden by default (app.js toggles .visible on scroll).
  test('GET / serves the back-to-top button and /style.css positions it fixed and hidden', async () => {
    const html = await httpRequest(`${baseUrl}/`);
    expect(html.status).toBe(200);
    expect(html.body).toMatch(/<button[^>]*id="btn-back-to-top"/);

    const css = await httpRequest(`${baseUrl}/style.css`);
    expect(css.status).toBe(200);
    expect(css.body).toMatch(/#btn-back-to-top\s*{[^}]*position:\s*fixed/);
    expect(css.body).toMatch(/#btn-back-to-top\s*{[^}]*display:\s*none/);
    expect(css.body).toMatch(/#btn-back-to-top\.visible\s*{[^}]*display:\s*block/);
  });

  // JetBrains Mono ships programming ligatures that fuse != == >= -> into
  // single glyphs.  In code review the raw characters matter — what the
  // reviewer sees must be exactly what is in the file.  This rule is the
  // contract that switches those ligatures off.
  test('GET /style.css disables programming ligatures globally', async () => {
    const { status, body } = await httpRequest(`${baseUrl}/style.css`);
    expect(status).toBe(200);
    expect(body).toMatch(/body\s*{[^}]*font-variant-ligatures:\s*none/);
  });

  test('GET /style.css ships the --top-bar-height-driven sidebar offset', async () => {
    const { status, body } = await httpRequest(`${baseUrl}/style.css`);
    expect(status).toBe(200);
    expect(body).toMatch(/#file-nav\s*{[^}]*top:\s*var\(--top-bar-height/);
    expect(body).toMatch(/max-height:\s*calc\(100vh\s*-\s*var\(--top-bar-height/);
  });

  // The patch heading is pinned under the top bar so Approve/Deny stay
  // reachable while scrolling a long diff. If this regresses, the buttons
  // scroll away and the reviewer has to scroll back up to act on a patch.
  test('GET /style.css pins the patch heading under the top bar', async () => {
    const { status, body } = await httpRequest(`${baseUrl}/style.css`);
    expect(status).toBe(200);
    expect(body).toMatch(/\.patch-heading\s*{[^}]*position:\s*sticky/);
    expect(body).toMatch(/\.patch-heading\s*{[^}]*top:\s*var\(--top-bar-height/);
  });

  // The autosave indicator cycles through "", "Saving…", "Saved", and
  // "Save failed" while the user types.  Without a fixed slot the inline
  // span grows from 0 to ~80 px wide and 0 to one-line tall, shifting the
  // header in/out as each save settles.  If this rule ever regresses the
  // pulse comes back.
  test('GET /style.css pins #autosave-status to a fixed width + min-height', async () => {
    const { status, body } = await httpRequest(`${baseUrl}/style.css`);
    expect(status).toBe(200);
    expect(body).toMatch(/#autosave-status\s*{[^}]*display:\s*block/);
    expect(body).toMatch(/#autosave-status\s*{[^}]*width:\s*90px/);
    expect(body).toMatch(/#autosave-status\s*{[^}]*min-height:\s*1\.5em/);
  });

  // The "Revue" wordmark is intentionally set in the mono font so the
  // masthead reads as a code-tool logotype (matching the worktree path
  // immediately below it).  Both the family and the masthead size are the
  // contract.
  test('GET /style.css renders the Revue wordmark in mono at the masthead size', async () => {
    const { status, body } = await httpRequest(`${baseUrl}/style.css`);
    expect(status).toBe(200);
    expect(body).toMatch(/#header h1 \.app-name\s*{[^}]*font-family:\s*var\(--font-mono\)/);
    expect(body).toMatch(/#header h1 \.app-name\s*{[^}]*font-size:\s*24px/);
    expect(body).toMatch(/#header h1 \.app-name\s*{[^}]*font-weight:\s*700/);
  });

  // ── Delta state endpoints (Task 1a of MULTI_TAB_SYNC_PLAN.md) ────────────
  // These endpoints mutate one logical entry of the state file under a
  // per-worktree lock.  The bulk POST /api/state shares the same lock so two
  // tabs editing different entries cannot clobber each other.

  async function resetState() {
    await httpRequest(`${baseUrl}/api/state`, {
      method: 'POST',
      body: { comments: {}, generalComments: {}, approved: [], denied: [], drafts: {} },
    });
  }

  test('POST /api/state/comment round-trips a single comment', async () => {
    await resetState();
    const comment = { patchHash: 'h1', file: 'a.js', line: 3, lineContent: '  x++;', text: 'why?' };
    const post = await httpRequest(`${baseUrl}/api/state/comment`, {
      method: 'POST',
      body: { patchHash: 'h1', file: 'a.js', key: 'n3', comment },
    });
    expect(post.status).toBe(200);
    const { body } = await httpRequest(`${baseUrl}/api/state`);
    expect(body.comments).toEqual({ h1: { 'a.js': { n3: comment } } });
  });

  test('POST /api/state/comment with comment=null deletes and prunes empty parents', async () => {
    await resetState();
    const c = { patchHash: 'h1', file: 'a.js', line: 1, lineContent: '', text: 't' };
    await httpRequest(`${baseUrl}/api/state/comment`, {
      method: 'POST',
      body: { patchHash: 'h1', file: 'a.js', key: 'n1', comment: c },
    });
    await httpRequest(`${baseUrl}/api/state/comment`, {
      method: 'POST',
      body: { patchHash: 'h1', file: 'a.js', key: 'n1', comment: null },
    });
    const { body } = await httpRequest(`${baseUrl}/api/state`);
    expect(body.comments).toEqual({}); // parent objects pruned
  });

  test('POST /api/state/comment rejects missing fields with 400', async () => {
    const { status } = await httpRequest(`${baseUrl}/api/state/comment`, {
      method: 'POST',
      body: { patchHash: 'h1', file: 'a.js' }, // missing key
    });
    expect(status).toBe(400);
  });

  test('POST /api/state/general-comment round-trips text', async () => {
    await resetState();
    await httpRequest(`${baseUrl}/api/state/general-comment`, {
      method: 'POST',
      body: { patchHash: 'h1', text: 'overall LGTM' },
    });
    const { body } = await httpRequest(`${baseUrl}/api/state`);
    expect(body.generalComments).toEqual({ h1: 'overall LGTM' });
  });

  // Drafts and saved comments live in independent slots in the state file —
  // when both exist for the SAME (patchHash, file, key) the API must return
  // both.  The UI relies on this so a pending edit of a saved comment can
  // be restored after a page reload.
  test('GET /api/state returns drafts and comments separately for the same key', async () => {
    await resetState();
    const patchHash = 'h-edit';
    const file = 'a.js';
    const key = 'n7';
    const dk = `${patchHash}/${file}/${key}`;
    // Save a real comment.
    await httpRequest(`${baseUrl}/api/state/comment`, {
      method: 'POST',
      body: { patchHash, file, key, comment: { patchHash, file, line: 7, lineContent: '', text: 'final' } },
    });
    // Save a draft for the SAME key (pending edit).
    await httpRequest(`${baseUrl}/api/state/draft`, {
      method: 'POST', body: { key: dk, text: 'final EDIT' },
    });
    const { body } = await httpRequest(`${baseUrl}/api/state`);
    expect(body.comments[patchHash][file][key].text).toBe('final');
    expect(body.drafts[dk]).toBe('final EDIT');
  });

  test('POST /api/state/draft stores text; null deletes the entry', async () => {
    await resetState();
    await httpRequest(`${baseUrl}/api/state/draft`, {
      method: 'POST',
      body: { key: 'h1/a.js/n3', text: 'WIP comment' },
    });
    let res = await httpRequest(`${baseUrl}/api/state`);
    expect(res.body.drafts).toEqual({ 'h1/a.js/n3': 'WIP comment' });

    await httpRequest(`${baseUrl}/api/state/draft`, {
      method: 'POST',
      body: { key: 'h1/a.js/n3', text: null },
    });
    res = await httpRequest(`${baseUrl}/api/state`);
    expect(res.body.drafts).toEqual({});
  });

  test('POST /api/state/decision applies approve/unapprove/deny/undeny', async () => {
    await resetState();
    await httpRequest(`${baseUrl}/api/state/decision`, { method: 'POST', body: { patchHash: 'h1', kind: 'approve' } });
    await httpRequest(`${baseUrl}/api/state/decision`, { method: 'POST', body: { patchHash: 'h2', kind: 'deny' } });
    let res = await httpRequest(`${baseUrl}/api/state`);
    expect(res.body.approved).toEqual(['h1']);
    expect(res.body.denied).toEqual(['h2']);

    await httpRequest(`${baseUrl}/api/state/decision`, { method: 'POST', body: { patchHash: 'h1', kind: 'unapprove' } });
    await httpRequest(`${baseUrl}/api/state/decision`, { method: 'POST', body: { patchHash: 'h2', kind: 'undeny' } });
    res = await httpRequest(`${baseUrl}/api/state`);
    expect(res.body.approved).toEqual([]);
    expect(res.body.denied).toEqual([]);
  });

  test('POST /api/state/decision rejects unknown kind with 400', async () => {
    const { status } = await httpRequest(`${baseUrl}/api/state/decision`, {
      method: 'POST',
      body: { patchHash: 'h1', kind: 'nope' },
    });
    expect(status).toBe(400);
  });

  // The regression this whole task fixes: two tabs writing different entries
  // at the same time must both persist.  Before delta endpoints, the bulk
  // POST /api/state wrote each tab's full in-memory snapshot, so whichever
  // tab flushed last would overwrite the other's edit.
  test('parallel delta POSTs on different keys both persist', async () => {
    await resetState();
    const a = httpRequest(`${baseUrl}/api/state/comment`, {
      method: 'POST',
      body: { patchHash: 'h1', file: 'a.js', key: 'n1', comment: { patchHash: 'h1', file: 'a.js', line: 1, lineContent: '', text: 'from A' } },
    });
    const b = httpRequest(`${baseUrl}/api/state/comment`, {
      method: 'POST',
      body: { patchHash: 'h1', file: 'b.js', key: 'n2', comment: { patchHash: 'h1', file: 'b.js', line: 2, lineContent: '', text: 'from B' } },
    });
    const c = httpRequest(`${baseUrl}/api/state/decision`, {
      method: 'POST',
      body: { patchHash: 'h1', kind: 'approve' },
    });
    const d = httpRequest(`${baseUrl}/api/state/draft`, {
      method: 'POST',
      body: { key: 'h1/c.js/n5', text: 'draft from D' },
    });
    const results = await Promise.all([a, b, c, d]);
    for (const r of results) expect(r.status).toBe(200);

    const { body } = await httpRequest(`${baseUrl}/api/state`);
    expect(body.comments.h1['a.js'].n1.text).toBe('from A');
    expect(body.comments.h1['b.js'].n2.text).toBe('from B');
    expect(body.approved).toEqual(['h1']);
    expect(body.drafts['h1/c.js/n5']).toBe('draft from D');

    // The atomic writer should clean up after itself: no .tmp leftover in the
    // git dir where the state file (and its temp files) now live.
    const stateDir = path.dirname(stateFilePathFor(workRepoPath));
    const leftovers = fs.readdirSync(stateDir).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  test('parallel delta POSTs on the same key — last-write-wins, file stays valid JSON', async () => {
    await resetState();
    const writes = Array.from({ length: 10 }, (_, i) =>
      httpRequest(`${baseUrl}/api/state/general-comment`, {
        method: 'POST',
        body: { patchHash: 'h1', text: `text ${i}` },
      })
    );
    const results = await Promise.all(writes);
    for (const r of results) expect(r.status).toBe(200);

    // After serialisation, the final value must be one of the writes — the
    // file must still parse and the value must be from the set we sent.
    const { body } = await httpRequest(`${baseUrl}/api/state`);
    expect(/^text \d$/.test(body.generalComments.h1)).toBe(true);
  });

  // Worktrees that accumulate many revisions can produce state files past
  // 100 KB (each revision carries a diffFingerprint per patch).  The
  // body-parser limit must accommodate that or POST /api/state/revisions
  // (and the bulk reset) silently fail with 413, breaking sync.
  test('POST /api/state/revisions accepts payloads well past Expresss default 100 KB', async () => {
    await resetState();
    // Build a ~500 KB payload via long diffFingerprint strings.
    const big = 'x'.repeat(50 * 1024);
    const revisions = Array.from({ length: 10 }, (_, i) => ({
      savedAt: `2026-05-${(i % 28) + 1}T00:00:00Z`,
      patches: [{ hash: `h${i}`, message: `m${i}`, diffFingerprint: big }],
    }));
    const res = await httpRequest(`${baseUrl}/api/state/revisions`, {
      method: 'POST', body: { revisions, approved: [], denied: [] },
    });
    expect(res.status).toBe(200);
  });

  // The re-review flag (approved patches whose code changed in a new revision)
  // rides along with the revisions write and must survive the round-trip so the
  // indication persists across reloads.
  test('POST /api/state/revisions round-trips reapprovalNeeded', async () => {
    await resetState();
    const post = await httpRequest(`${baseUrl}/api/state/revisions`, {
      method: 'POST',
      body: { revisions: [], approved: ['keep'], denied: [], reapprovalNeeded: ['changed1', 'changed2'] },
    });
    expect(post.status).toBe(200);
    const { body } = await httpRequest(`${baseUrl}/api/state`);
    expect(body.reapprovalNeeded).toEqual(['changed1', 'changed2']);
    await httpRequest(`${baseUrl}/api/state/revisions`, {
      method: 'POST', body: { revisions: [], approved: [], denied: [], reapprovalNeeded: [] },
    });
  });

  test('POST /api/state/revisions rejects a non-array reapprovalNeeded with 400', async () => {
    const { status } = await httpRequest(`${baseUrl}/api/state/revisions`, {
      method: 'POST', body: { revisions: [], approved: [], denied: [], reapprovalNeeded: 'nope' },
    });
    expect(status).toBe(400);
  });

  test('POST /api/state/revisions still accepts a payload omitting reapprovalNeeded (older clients)', async () => {
    const { status } = await httpRequest(`${baseUrl}/api/state/revisions`, {
      method: 'POST', body: { revisions: [], approved: [], denied: [] },
    });
    expect(status).toBe(200);
  });

  // ── SSE state-events stream (Task 3a) ─────────────────────────────────
  // Two listeners must both receive a delta event.  Each event carries the
  // origin tab id + per-tab seq so peer tabs can dedupe duplicates that
  // arrive over both BroadcastChannel and SSE.
  test('GET /api/state/events fans a delta out to all connected listeners', async () => {
    await resetState();
    function openListener() {
      return new Promise((resolve) => {
        const req = http.get(`${baseUrl}/api/state/events`, (res) => {
          const events = [];
          let buf = '';
          res.on('data', (chunk) => {
            buf += chunk;
            const parts = buf.split('\n\n');
            buf = parts.pop();
            for (const part of parts) {
              if (part.startsWith('data: ')) {
                try { events.push(JSON.parse(part.slice(6))); } catch {}
              }
            }
          });
          resolve({ req, events, close: () => req.destroy() });
        });
      });
    }
    const a = await openListener();
    const b = await openListener();
    // Wait for the initial "hello" so we don't race the comment POST.
    await new Promise((r) => setTimeout(r, 100));

    await httpRequest(`${baseUrl}/api/state/comment`, {
      method: 'POST',
      body: { patchHash: 'h1', file: 'a.js', key: 'n1', comment: { patchHash: 'h1', file: 'a.js', line: 1, lineContent: '', text: 'hi' } },
    });
    await new Promise((r) => setTimeout(r, 150));

    a.close(); b.close();
    const aDelta = a.events.find((e) => e.kind === 'comment');
    const bDelta = b.events.find((e) => e.kind === 'comment');
    expect(aDelta).toBeTruthy();
    expect(bDelta).toBeTruthy();
    expect(aDelta.patchHash).toBe('h1');
    expect(aDelta._version).toBe(bDelta._version);
  });

  // The server's `_version` counter advances on every write.  A reconnecting
  // client uses the hello event's _version to decide whether it missed any
  // events while disconnected (Task 4 consistency sweep).
  test('hello event reports the current _version; later deltas carry incremented _version', async () => {
    await resetState();
    function openListener() {
      return new Promise((resolve) => {
        const events = [];
        const req = http.get(`${baseUrl}/api/state/events`, (res) => {
          let buf = '';
          res.on('data', (chunk) => {
            buf += chunk;
            const parts = buf.split('\n\n');
            buf = parts.pop();
            for (const part of parts) {
              if (part.startsWith('data: ')) {
                try { events.push(JSON.parse(part.slice(6))); } catch {}
              }
            }
          });
        });
        setTimeout(() => resolve({ req, events }), 150);
      });
    }
    const a = await openListener();
    const hello = a.events.find((e) => e.kind === 'hello');
    expect(hello).toBeTruthy();
    const before = hello._version;

    await httpRequest(`${baseUrl}/api/state/general-comment`, {
      method: 'POST', body: { patchHash: 'h-v', text: 'one' },
    });
    await httpRequest(`${baseUrl}/api/state/general-comment`, {
      method: 'POST', body: { patchHash: 'h-v', text: 'two' },
    });
    await new Promise((r) => setTimeout(r, 200));
    a.req.destroy();

    const deltas = a.events.filter((e) => e.kind === 'general-comment');
    expect(deltas).toHaveLength(2);
    expect(deltas[0]._version).toBe(before + 1);
    expect(deltas[1]._version).toBe(before + 2);
  });

  // After a client disconnects, its subscriber slot must be released; if it
  // weren't, publishStateEvent would try to write to a dead socket forever.
  test('SSE subscriber slot is released when the client disconnects', async () => {
    await resetState();
    function openListener() {
      return new Promise((resolve) => {
        const req = http.get(`${baseUrl}/api/state/events`, () => resolve(req));
      });
    }
    // Trigger one publish before connecting so the subscriber count we
    // observe is unambiguous (just our connection).
    const r1 = await openListener();
    await new Promise((r) => setTimeout(r, 100));
    r1.destroy();
    // Wait a moment for req.on('close') to fire on the server.
    await new Promise((r) => setTimeout(r, 100));
    // The remaining publishStateEvent calls must not throw or hang.
    const post = await httpRequest(`${baseUrl}/api/state/general-comment`, {
      method: 'POST',
      body: { patchHash: 'h-cleanup', text: 'still works' },
    });
    expect(post.status).toBe(200);
  });

  test('SSE event includes X-Tab-Id and X-Tab-Seq from the originating POST', async () => {
    await resetState();
    const collected = [];
    const req = http.get(`${baseUrl}/api/state/events`, (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          if (part.startsWith('data: ')) {
            try { collected.push(JSON.parse(part.slice(6))); } catch {}
          }
        }
      });
    });
    await new Promise((r) => setTimeout(r, 100));

    // Send a POST with the tab-id/seq headers the client always attaches.
    const data = JSON.stringify({ patchHash: 'h1', kind: 'approve' });
    await new Promise((resolve, reject) => {
      const postReq = http.request({
        hostname: '127.0.0.1', port: new URL(baseUrl).port, path: '/api/state/decision',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'X-Tab-Id': 'tab-foo',
          'X-Tab-Seq': '42',
        },
      }, (r) => { r.on('end', resolve); r.resume(); });
      postReq.on('error', reject);
      postReq.write(data); postReq.end();
    });
    await new Promise((r) => setTimeout(r, 150));
    req.destroy();

    const ev = collected.find((e) => e.kind === 'decision');
    expect(ev).toBeTruthy();
    expect(ev._from).toBe('tab-foo');
    expect(ev._seq).toBe(42);
    expect(ev.action).toBe('approve');
  });

  // Legacy bulk POST and delta POSTs going in parallel: the lock ensures
  // neither corrupts the JSON.  We don't assert on which wins (the test is
  // about file integrity, not ordering); we only assert the result is
  // self-consistent.
  test('mixed legacy bulk POST + delta POSTs do not corrupt the state file', async () => {
    await resetState();
    const ops = [
      httpRequest(`${baseUrl}/api/state`, {
        method: 'POST',
        body: { comments: {}, generalComments: { h1: 'bulk write' }, approved: ['h1'], denied: [], drafts: {} },
      }),
      httpRequest(`${baseUrl}/api/state/comment`, {
        method: 'POST',
        body: { patchHash: 'h2', file: 'x.js', key: 'n1', comment: { patchHash: 'h2', file: 'x.js', line: 1, lineContent: '', text: 'delta' } },
      }),
      httpRequest(`${baseUrl}/api/state/draft`, {
        method: 'POST',
        body: { key: 'h3/y.js/n4', text: 'parallel draft' },
      }),
    ];
    const results = await Promise.all(ops);
    for (const r of results) expect(r.status).toBe(200);

    // File must parse to a valid object whatever the interleaving was.
    const { status, body } = await httpRequest(`${baseUrl}/api/state`);
    expect(status).toBe(200);
    expect(typeof body).toBe('object');
  });
});

// ── diff cache invalidates on base movement ───────────────────────────────

describe('GET /api/diff recomputes when the base moves under a stable HEAD', () => {
  let cbTmp, cbServer, cbUrl, cbWork;

  beforeAll(async () => {
    cbTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-cachebase-'));
    const main = path.join(cbTmp, 'main');
    cbWork = path.join(cbTmp, 'work');
    fs.mkdirSync(main);
    git(main, 'init');
    git(main, 'config user.email "t@t.com"');
    git(main, 'config user.name "T"');
    fs.writeFileSync(path.join(main, 'base.txt'), 'base\n');
    git(main, 'add .');
    git(main, 'commit -m "initial"');

    execSync(`git clone "${main}" "${cbWork}"`, { encoding: 'utf8' });
    git(cbWork, 'config user.email "t@t.com"');
    git(cbWork, 'config user.name "T"');
    // Three commits ahead of origin/main.
    for (const n of [1, 2, 3]) {
      fs.writeFileSync(path.join(cbWork, `f${n}.txt`), `change ${n}\n`);
      git(cbWork, 'add .');
      git(cbWork, `commit -m "feat: part ${n}"`);
    }

    const app = createApp({ worktreeName: 'work', worktreePath: cbWork, mainRepoPath: main });
    const port = await findAvailablePort(19400);
    await new Promise((resolve) => { cbServer = app.listen(port, '127.0.0.1', resolve); });
    cbUrl = `http://127.0.0.1:${port}`;
  });

  afterAll((done) => {
    fs.rmSync(cbTmp, { recursive: true, force: true });
    cbServer.close(done);
  });

  test('a fetch that advances origin/main shrinks the series without a HEAD change', async () => {
    const before = await httpRequest(`${cbUrl}/api/diff`);
    expect(before.body.patches).toHaveLength(3); // base..HEAD = all 3
    const head = before.body.headHash;

    // Simulate a fetch fast-forwarding origin/main onto the 2nd commit (an
    // ancestor of HEAD). HEAD is unchanged; only the merge-base moves.
    const secondCommit = git(cbWork, 'rev-parse HEAD~1');
    git(cbWork, `update-ref refs/remotes/origin/main ${secondCommit}`);

    const after = await httpRequest(`${cbUrl}/api/diff`);
    expect(after.body.headHash).toBe(head);     // HEAD really did not change
    expect(after.body.patches).toHaveLength(1); // only the commit past the new base — not the stale 3
    expect(after.body.patches[0].message).toBe('feat: part 3');
  });
});

// ── startServer lifecycle ─────────────────────────────────────────────────

describe('startServer lifecycle', () => {
  let server;
  let port;
  let pidFile;
  let pidDir;

  beforeAll(async () => {
    pidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-pid-'));
    pidFile = path.join(pidDir, 'test.pid');
    server = await startServer({
      worktreeName: 'work-repo',
      worktreePath: workRepoPath,
      mainRepoPath,
      pidFile,
      port: 19300,
      noOpen: true,
    });
    port = server.address().port;
  });

  afterAll((done) => {
    server.close(() => {
      fs.rmSync(pidDir, { recursive: true, force: true });
      done();
    });
  });

  test('server binds to a real port', () => {
    expect(port).toEqual(expect.any(Number));
    expect(port).toBeGreaterThan(0);
  });

  test('server writes pid:port to the PID file', () => {
    expect(fs.existsSync(pidFile)).toBe(true);
    const content = fs.readFileSync(pidFile, 'utf8').trim();
    const [pidStr, portStr] = content.split(':');
    expect(parseInt(pidStr, 10)).toBe(process.pid);
    expect(parseInt(portStr, 10)).toBe(port);
  });

  test('server responds to real HTTP requests', async () => {
    const { status, body } = await httpRequest(`http://127.0.0.1:${port}/api/headhash`);
    expect(status).toBe(200);
    expect(body.hash).toBe(commitHash);
  });

  test('findAvailablePort skips an already-bound port', async () => {
    const next = await findAvailablePort(port);
    expect(next).toBeGreaterThan(port);
  });
});

// ── getDiffBetweenCommits + GET /api/revdiff ──────────────────────────────
// Fixture: two commits both modifying calc.js — v1 sets y=20, v2 sets y=200.
// getDiffBetweenCommits compares the patch *introduced* by each commit,
// so the delta shows the line changed between the two patch versions.

describe('revdiff integration', () => {
  let revTmpDir, revMain, revWork, hashV1, hashV2, revServer, revPort;

  beforeAll(async () => {
    revTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-revdiff-'));
    revMain = path.join(revTmpDir, 'main');
    revWork = path.join(revTmpDir, 'work');

    fs.mkdirSync(revMain);
    git(revMain, 'init');
    git(revMain, 'config user.email "test@test.com"');
    git(revMain, 'config user.name "Test"');
    fs.writeFileSync(path.join(revMain, 'calc.js'), 'const x = 1;\nconst y = 2;\nconst z = 3;\n');
    git(revMain, 'add .');
    git(revMain, 'commit -m "initial"');

    execSync(`git clone "${revMain}" "${revWork}"`, { encoding: 'utf8' });
    git(revWork, 'config user.email "test@test.com"');
    git(revWork, 'config user.name "Test"');

    fs.writeFileSync(path.join(revWork, 'calc.js'), 'const x = 1;\nconst y = 20;\nconst z = 3;\n');
    git(revWork, 'add .');
    git(revWork, 'commit -m "v1: set y to 20"');
    hashV1 = git(revWork, 'rev-parse HEAD');

    fs.writeFileSync(path.join(revWork, 'calc.js'), 'const x = 1;\nconst y = 200;\nconst z = 3;\n');
    git(revWork, 'add .');
    git(revWork, 'commit -m "v2: set y to 200"');
    hashV2 = git(revWork, 'rev-parse HEAD');

    const app = createApp({ worktreeName: 'work', worktreePath: revWork, mainRepoPath: revMain });
    revPort = await findAvailablePort(18700);
    await new Promise((resolve) => { revServer = app.listen(revPort, '127.0.0.1', resolve); });
  });

  afterAll((done) => {
    revServer.close(() => {
      fs.rmSync(revTmpDir, { recursive: true, force: true });
      done();
    });
  });

  test('getDiffBetweenCommits shows lines that changed between the two patch versions', () => {
    const files = getDiffBetweenCommits(revWork, hashV1, hashV2);
    expect(files).toHaveLength(1);
    expect(files[0].newPath).toBe('calc.js');
    const lines = files[0].hunks[0].lines;
    // v2 added 'const y = 200;' but v1 had 'const y = 20;'
    expect(lines.some((l) => l.type === 'added' && l.content === 'const y = 200;')).toBe(true);
    expect(lines.some((l) => l.type === 'removed' && l.content === 'const y = 20;')).toBe(true);
  });

  test('GET /api/diff returns both commits in oldest-first order', async () => {
    const { status, body } = await httpRequest(`http://127.0.0.1:${revPort}/api/diff`);
    expect(status).toBe(200);
    expect(body.patches).toHaveLength(2);
    expect(body.patches[0].message).toBe('v1: set y to 20');
    expect(body.patches[1].message).toBe('v2: set y to 200');
    expect(body.patches[0].files[0].newPath).toBe('calc.js');
    expect(body.patches[1].files[0].newPath).toBe('calc.js');
  });

  test('GET /api/revdiff returns empty files array when comparing a commit to itself', async () => {
    const shortV1 = hashV1.slice(0, 8);
    const { status, body } = await httpRequest(
      `http://127.0.0.1:${revPort}/api/revdiff?from=${shortV1}&to=${shortV1}`
    );
    expect(status).toBe(200);
    expect(body.files).toHaveLength(0); // same patch on both sides → no delta
  });

  test('GET /api/revdiff returns the patch delta for real commit hashes', async () => {
    const shortV1 = hashV1.slice(0, 8);
    const shortV2 = hashV2.slice(0, 8);
    const { status, body } = await httpRequest(
      `http://127.0.0.1:${revPort}/api/revdiff?from=${shortV1}&to=${shortV2}`
    );
    expect(status).toBe(200);
    expect(body.from).toBe(shortV1);
    expect(body.to).toBe(shortV2);
    const lines = body.files[0].hunks[0].lines;
    expect(lines.some((l) => l.type === 'added' && l.content === 'const y = 200;')).toBe(true);
    expect(lines.some((l) => l.type === 'removed' && l.content === 'const y = 20;')).toBe(true);
  });
});

// ── Revision comparison file scoping ───────────────────────────────────────
// A comparison must show only the files the `to` revision changes. Files that
// only the `from` revision touched (e.g. an unrelated commit the position-
// matched snapshot points at after a rebase) must not leak into the view.

describe('revision comparison file scoping', () => {
  let scTmpDir, scRepo, scServer, scPort, fromHash, toHash;

  beforeAll(async () => {
    scTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-scope-'));
    scRepo = path.join(scTmpDir, 'repo');
    fs.mkdirSync(scRepo);
    git(scRepo, 'init -q');
    git(scRepo, 'config user.email "test@test.com"');
    git(scRepo, 'config user.name "Test"');
    fs.writeFileSync(path.join(scRepo, 'a.js'), 'const a = 0;\n');
    fs.writeFileSync(path.join(scRepo, 'b.js'), 'const b = 0;\n');
    git(scRepo, 'add .');
    git(scRepo, 'commit -q -m "base"');
    const baseHash = git(scRepo, 'rev-parse HEAD');

    // `from` revision changes BOTH a.js and b.js.
    fs.writeFileSync(path.join(scRepo, 'a.js'), 'const a = 1;\n');
    fs.writeFileSync(path.join(scRepo, 'b.js'), 'const b = 1;\n');
    git(scRepo, 'add .');
    git(scRepo, 'commit -q -m "from: change a and b"');
    fromHash = git(scRepo, 'rev-parse HEAD');

    // `to` revision (off the same base) changes ONLY a.js.
    git(scRepo, `checkout -q -b rebased ${baseHash}`);
    fs.writeFileSync(path.join(scRepo, 'a.js'), 'const a = 2;\n');
    git(scRepo, 'add .');
    git(scRepo, 'commit -q -m "to: change a only"');
    toHash = git(scRepo, 'rev-parse HEAD');

    const app = createApp({ worktreeName: 'repo', worktreePath: scRepo, mainRepoPath: scRepo });
    scPort = await findAvailablePort(18950);
    await new Promise((resolve) => { scServer = app.listen(scPort, '127.0.0.1', resolve); });
  });

  afterAll((done) => {
    scServer.close(() => {
      fs.rmSync(scTmpDir, { recursive: true, force: true });
      done();
    });
  });

  test('GET /api/revdiff returns only files the `to` revision changes', async () => {
    const { status, body } = await httpRequest(
      `http://127.0.0.1:${scPort}/api/revdiff?from=${fromHash.slice(0, 8)}&to=${toHash.slice(0, 8)}`
    );
    expect(status).toBe(200);
    // b.js was changed only by `from` → excluded; a.js is what `to` changes.
    expect(body.files.map((f) => f.newPath)).toEqual(['a.js']);
  });
});

// ── discoverWorktrees + GET /api/worktrees + POST /api/switch ─────────────
// Fixture: a real git repo with one `git worktree add` so discoverWorktrees
// exercises the real `git worktree list --porcelain` path.

describe('discoverWorktrees and worktree switching integration', () => {
  let wtTmpDir, wtMain, wtWorktreePath, wtServer, wtPort;

  beforeAll(async () => {
    wtTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-wt-'));
    wtMain = path.join(wtTmpDir, 'repo');
    wtWorktreePath = path.join(wtTmpDir, 'repo-feature');

    fs.mkdirSync(wtMain);
    git(wtMain, 'init');
    git(wtMain, 'config user.email "test@test.com"');
    git(wtMain, 'config user.name "Test"');
    fs.writeFileSync(path.join(wtMain, 'README'), 'hello\n');
    git(wtMain, 'add .');
    git(wtMain, 'commit -m "initial"');

    // Create a real git worktree on a new branch
    git(wtMain, `worktree add -b feature "${wtWorktreePath}"`);

    const app = createApp({ worktreeName: 'feature', worktreePath: wtWorktreePath, mainRepoPath: wtMain });
    wtPort = await findAvailablePort(18800);
    await new Promise((resolve) => { wtServer = app.listen(wtPort, '127.0.0.1', resolve); });
  });

  afterAll((done) => {
    wtServer.close(() => {
      fs.rmSync(wtTmpDir, { recursive: true, force: true });
      done();
    });
  });

  test('discoverWorktrees finds the real worktree and strips the repo-name prefix', () => {
    const worktrees = discoverWorktrees(wtMain);
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].worktreeName).toBe('feature');
    // git resolves symlinks in paths; compare against the real path
    expect(worktrees[0].path).toBe(fs.realpathSync(wtWorktreePath));
    expect(worktrees[0].branch).toBe('feature');
  });

  test('GET /api/worktrees includes main repo and the real worktree', async () => {
    const { status, body } = await httpRequest(`http://127.0.0.1:${wtPort}/api/worktrees`);
    expect(status).toBe(200);
    expect(body.current).toBe('feature');
    expect(body.worktrees.some((w) => w.isMain && w.worktreeName === 'repo')).toBe(true);
    expect(body.worktrees.some((w) => w.worktreeName === 'feature')).toBe(true);
    // The drag-scrollable switcher bar only renders when more than one
    // worktree exists, so the contract must return at least two entries.
    expect(body.worktrees.length).toBeGreaterThanOrEqual(2);
  });

  test('POST /api/switch to main repo succeeds and updates the active worktree', async () => {
    const { status, body } = await httpRequest(`http://127.0.0.1:${wtPort}/api/switch`, {
      method: 'POST',
      body: { worktreeName: 'repo' },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.worktreeName).toBe('repo');
    expect(body.worktreePath).toBe(wtMain);
  });

  test('GET /api/diff after POST /api/switch returns data from the new worktree', async () => {
    // Switch back to the feature worktree (which has no commits ahead of main)
    await httpRequest(`http://127.0.0.1:${wtPort}/api/switch`, {
      method: 'POST',
      body: { worktreeName: 'feature' },
    });
    const { status, body } = await httpRequest(`http://127.0.0.1:${wtPort}/api/diff`);
    expect(status).toBe(200);
    expect(body.worktreeName).toBe('feature');
    expect(body.patches).toHaveLength(0);
  });

  test('GET /api/state and POST /api/state use the state file of the active worktree', async () => {
    const sw1 = await httpRequest(`http://127.0.0.1:${wtPort}/api/switch`, {
      method: 'POST',
      body: { worktreeName: 'feature' },
    });
    expect(sw1.status).toBe(200);

    const post = await httpRequest(`http://127.0.0.1:${wtPort}/api/state`, {
      method: 'POST',
      body: { stateMarker: 'feature-worktree' },
    });
    expect(post.status).toBe(200);

    const featureGet = await httpRequest(`http://127.0.0.1:${wtPort}/api/state`);
    expect(featureGet.body.stateMarker).toBe('feature-worktree');

    const sw2 = await httpRequest(`http://127.0.0.1:${wtPort}/api/switch`, {
      method: 'POST',
      body: { worktreeName: 'repo' },
    });
    expect(sw2.status).toBe(200);

    const repoGet = await httpRequest(`http://127.0.0.1:${wtPort}/api/state`);
    expect(repoGet.body.stateMarker).toBeUndefined();
  });
});

// ── getMergeBase — fallback when origin/main is absent ────────────────────
// Fixture: a plain (non-clone) repo with a linked worktree.  Because there
// is no remote, rev-parse origin/main fails and getMergeBase must fall back
// to rev-parse HEAD on the main repo itself.

describe('getMergeBase — fallback without origin/main', () => {
  let fbTmpDir, fbMain, fbWork;

  beforeAll(() => {
    fbTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-mb-'));
    fbMain = path.join(fbTmpDir, 'main');
    fbWork = path.join(fbTmpDir, 'work');

    fs.mkdirSync(fbMain);
    git(fbMain, 'init');
    git(fbMain, 'config user.email "test@test.com"');
    git(fbMain, 'config user.name "Test"');
    fs.writeFileSync(path.join(fbMain, 'base.txt'), 'base\n');
    git(fbMain, 'add .');
    git(fbMain, 'commit -m "initial"');

    // git worktree add creates a linked worktree with no origin remote
    git(fbMain, `worktree add -b feature "${fbWork}"`);
    fs.writeFileSync(path.join(fbWork, 'new.txt'), 'new\n');
    git(fbWork, 'add .');
    git(fbWork, 'commit -m "feat: add new"');
  });

  afterAll(() => {
    fs.rmSync(fbTmpDir, { recursive: true, force: true });
  });

  test('getMergeBase falls back to mainRepoPath HEAD when origin/main is unavailable', () => {
    const base = getMergeBase(fbWork, fbMain);
    const mainHead = git(fbMain, 'rev-parse HEAD');
    expect(base).toBe(mainHead);
  });

  test('getCommits finds the patch commit via the fallback path', () => {
    const commits = getCommits(fbWork, fbMain);
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe('feat: add new');
  });
});

// ── getMergeBase — prefers the branch upstream over origin/main ────────────
// The esr scenario: a worktree forked from an integration branch (origin/esr)
// that itself diverged from origin/main long ago. Comparing against origin/main
// would include the whole esr divergence (and, for a real esr, tens of
// thousands of commits → spawnSync ENOBUFS). The branch's tracking upstream
// gives the correct, nearby base so only the worktree's own patches show.

describe('getMergeBase — prefers the branch upstream', () => {
  let upTmpDir, upOrigin, upWork;

  beforeAll(() => {
    upTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-up-'));
    upOrigin = path.join(upTmpDir, 'origin');
    upWork = path.join(upTmpDir, 'work');

    fs.mkdirSync(upOrigin);
    git(upOrigin, 'init -b main');
    git(upOrigin, 'config user.email "test@test.com"');
    git(upOrigin, 'config user.name "Test"');
    fs.writeFileSync(path.join(upOrigin, 'base.txt'), 'base\n');
    git(upOrigin, 'add .');
    git(upOrigin, 'commit -m "A: shared root"');

    // esr forks at the shared root and adds its own commit.
    git(upOrigin, 'checkout -b esr');
    fs.writeFileSync(path.join(upOrigin, 'esr.txt'), 'esr\n');
    git(upOrigin, 'add .');
    git(upOrigin, 'commit -m "E1: esr-only commit"');

    // main moves far ahead of the fork point.
    git(upOrigin, 'checkout main');
    for (const n of [1, 2, 3]) {
      fs.writeFileSync(path.join(upOrigin, `m${n}.txt`), `m${n}\n`);
      git(upOrigin, 'add .');
      git(upOrigin, `commit -m "M${n}: main advances"`);
    }

    execSync(`git clone "${upOrigin}" "${upWork}"`, { encoding: 'utf8' });
    git(upWork, 'config user.email "test@test.com"');
    git(upWork, 'config user.name "Test"');
    // Branch off the esr integration branch, tracking it as upstream.
    git(upWork, 'checkout -b patch --track origin/esr');
    fs.writeFileSync(path.join(upWork, 'patch.txt'), 'patch\n');
    git(upWork, 'add .');
    git(upWork, 'commit -m "P: the patch under review"');
  });

  afterAll(() => {
    fs.rmSync(upTmpDir, { recursive: true, force: true });
  });

  test('merge-base is the esr tip, not the older origin/main fork point', () => {
    const base = getMergeBase(upWork, upWork);
    const esrTip = git(upWork, 'rev-parse origin/esr');
    expect(base).toBe(esrTip);
  });

  test('getCommits returns only the worktree patch, not the esr divergence', () => {
    const commits = getCommits(upWork, upWork);
    expect(commits.map((c) => c.message)).toEqual(['P: the patch under review']);
  });
});

// ── Keyboard navigation data contract ──────────────────────────────────────
// The arrow-key shortcuts rely on the shape of /api/diff: Left/Right switch
// between patches (so there must be more than one patch entry) and Up/Down
// move between files within a patch (so a patch's `files` array must list
// every changed file, in a stable order the sidebar mirrors).

describe('keyboard navigation data contract', () => {
  let kbTmpDir, kbMain, kbWork, kbServer, kbPort;

  beforeAll(async () => {
    kbTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-kbnav-'));
    kbMain = path.join(kbTmpDir, 'main');
    kbWork = path.join(kbTmpDir, 'work');

    fs.mkdirSync(kbMain);
    git(kbMain, 'init');
    git(kbMain, 'config user.email "test@test.com"');
    git(kbMain, 'config user.name "Test"');
    fs.writeFileSync(path.join(kbMain, 'base.txt'), 'base\n');
    git(kbMain, 'add .');
    git(kbMain, 'commit -m "initial"');

    execSync(`git clone "${kbMain}" "${kbWork}"`, { encoding: 'utf8' });
    git(kbWork, 'config user.email "test@test.com"');
    git(kbWork, 'config user.name "Test"');

    // Commit 1 — one file → the first patch tab.
    fs.writeFileSync(path.join(kbWork, 'alpha.js'), 'const a = 1;\n');
    git(kbWork, 'add .');
    git(kbWork, 'commit -m "feat: add alpha"');

    // Commit 2 — two files → gives Up/Down something to move between.
    fs.writeFileSync(path.join(kbWork, 'beta.js'), 'const b = 2;\n');
    fs.writeFileSync(path.join(kbWork, 'gamma.js'), 'const g = 3;\n');
    git(kbWork, 'add .');
    git(kbWork, 'commit -m "feat: add beta and gamma"');

    const app = createApp({ worktreeName: 'work', worktreePath: kbWork, mainRepoPath: kbMain });
    kbPort = await findAvailablePort(18900);
    await new Promise((resolve) => { kbServer = app.listen(kbPort, '127.0.0.1', resolve); });
  });

  afterAll((done) => {
    kbServer.close(() => {
      fs.rmSync(kbTmpDir, { recursive: true, force: true });
      done();
    });
  });

  test('GET /api/diff returns multiple patches so Left/Right can switch tabs', async () => {
    const { status, body } = await httpRequest(`http://127.0.0.1:${kbPort}/api/diff`);
    expect(status).toBe(200);
    expect(body.patches.length).toBeGreaterThanOrEqual(2);
  });

  test('a multi-file patch lists every file in stable order so Up/Down can navigate', async () => {
    const { body } = await httpRequest(`http://127.0.0.1:${kbPort}/api/diff`);
    const multi = body.patches.find((p) => p.message === 'feat: add beta and gamma');
    expect(multi).toBeTruthy();
    const paths = multi.files.map((f) => f.newPath);
    expect(paths).toEqual(['beta.js', 'gamma.js']);
  });

  // The tab bar renders one tab per patch in the server's order, and Left/Right
  // (plus the scroll-active-tab-into-view behavior) map directly to that order.
  // If the server reordered patches, arrow navigation would jump unpredictably.
  test('patches come back in oldest-first commit order so tabs map to that order', async () => {
    const { body } = await httpRequest(`http://127.0.0.1:${kbPort}/api/diff`);
    const messages = body.patches.map((p) => p.message);
    expect(messages).toEqual(['feat: add alpha', 'feat: add beta and gamma']);
  });
});

// ── Legacy state migration ─────────────────────────────────────────────────
// State used to live in the working tree as REVIEW_STATE_<name>.json. On first
// access it must be migrated into the git dir so existing approvals are not
// lost, and the loose working-tree file is removed.

describe('legacy state migration', () => {
  let mgTmpDir, mgMain, mgWork, mgServer, mgPort;

  beforeAll(async () => {
    mgTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-migrate-'));
    mgMain = path.join(mgTmpDir, 'main');
    mgWork = path.join(mgTmpDir, 'work');
    fs.mkdirSync(mgMain);
    git(mgMain, 'init');
    git(mgMain, 'config user.email "test@test.com"');
    git(mgMain, 'config user.name "Test"');
    fs.writeFileSync(path.join(mgMain, 'base.txt'), 'base\n');
    git(mgMain, 'add .');
    git(mgMain, 'commit -m "initial"');

    execSync(`git clone "${mgMain}" "${mgWork}"`, { encoding: 'utf8' });
    git(mgWork, 'config user.email "test@test.com"');
    git(mgWork, 'config user.name "Test"');

    // Seed a legacy in-worktree state file with real approvals.
    fs.writeFileSync(
      path.join(mgWork, 'REVIEW_STATE_work.json'),
      JSON.stringify({ approved: ['keepme'], denied: [], revisions: [{ savedAt: '2026-06-02T00:00:00Z', patches: [] }] }),
      'utf8',
    );

    const app = createApp({ worktreeName: 'work', worktreePath: mgWork, mainRepoPath: mgMain });
    mgPort = await findAvailablePort(18960);
    await new Promise((resolve) => { mgServer = app.listen(mgPort, '127.0.0.1', resolve); });
  });

  afterAll((done) => {
    mgServer.close(() => { fs.rmSync(mgTmpDir, { recursive: true, force: true }); done(); });
  });

  test('GET /api/state migrates the legacy file: approvals preserved, loose file removed, state now in git dir', async () => {
    const { status, body } = await httpRequest(`http://127.0.0.1:${mgPort}/api/state`);
    expect(status).toBe(200);
    expect(body.approved).toEqual(['keepme']); // not lost
    expect(body.unreadable).toBeUndefined();

    // The loose working-tree file is gone, and the state now lives in the git dir.
    expect(fs.existsSync(path.join(mgWork, 'REVIEW_STATE_work.json'))).toBe(false);
    const gitDirState = stateFilePathFor(mgWork);
    expect(fs.existsSync(gitDirState)).toBe(true);
    expect(JSON.parse(fs.readFileSync(gitDirState, 'utf8')).approved).toEqual(['keepme']);
  });
});

// ── Bulk write before first read still migrates legacy state ────────────────
// POST /api/state does a full-replace write without readStateFile, so it must
// migrate the legacy file itself — otherwise a bulk write landing before any
// read would leave the legacy file orphaned in the working tree.

describe('bulk write migrates legacy state', () => {
  let bmTmpDir, bmMain, bmWork, bmServer, bmPort;

  beforeAll(async () => {
    bmTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-bulkmig-'));
    bmMain = path.join(bmTmpDir, 'main');
    bmWork = path.join(bmTmpDir, 'work');
    fs.mkdirSync(bmMain);
    git(bmMain, 'init');
    git(bmMain, 'config user.email "test@test.com"');
    git(bmMain, 'config user.name "Test"');
    fs.writeFileSync(path.join(bmMain, 'base.txt'), 'base\n');
    git(bmMain, 'add .');
    git(bmMain, 'commit -m "initial"');
    execSync(`git clone "${bmMain}" "${bmWork}"`, { encoding: 'utf8' });
    git(bmWork, 'config user.email "test@test.com"');
    git(bmWork, 'config user.name "Test"');
    fs.writeFileSync(path.join(bmWork, 'REVIEW_STATE_work.json'), JSON.stringify({ approved: ['old'] }), 'utf8');

    const app = createApp({ worktreeName: 'work', worktreePath: bmWork, mainRepoPath: bmMain });
    bmPort = await findAvailablePort(18970);
    await new Promise((resolve) => { bmServer = app.listen(bmPort, '127.0.0.1', resolve); });
  });

  afterAll((done) => {
    bmServer.close(() => { fs.rmSync(bmTmpDir, { recursive: true, force: true }); done(); });
  });

  test('a bulk POST as the first request removes the loose legacy file', async () => {
    // First request of the session is a bulk write (no GET beforehand).
    const post = await httpRequest(`http://127.0.0.1:${bmPort}/api/state`, {
      method: 'POST', body: { approved: ['new'], denied: [] },
    });
    expect(post.status).toBe(200);
    // The legacy working-tree file must not be left orphaned.
    expect(fs.existsSync(path.join(bmWork, 'REVIEW_STATE_work.json'))).toBe(false);
    expect(fs.existsSync(stateFilePathFor(bmWork))).toBe(true);
    const { body } = await httpRequest(`http://127.0.0.1:${bmPort}/api/state`);
    expect(body.approved).toEqual(['new']);
  });
});

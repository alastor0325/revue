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
} = require('../src/git');
const { createApp, startServer, findAvailablePort } = require('../src/server');

// ── Helpers ────────────────────────────────────────────────────────────────

function git(cwd, cmd) {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

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

  test('getCommits returns commits ahead of the main repo', () => {
    const commits = getCommits(workRepoPath, mainRepoPath);
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe('feat: add hello function');
    expect(commits[0].hash).toMatch(/^[0-9a-f]+$/);
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
  });

  test('GET /api/diff returns consistent data on repeated calls', async () => {
    const r1 = await httpRequest(`${baseUrl}/api/diff`);
    const r2 = await httpRequest(`${baseUrl}/api/diff`);
    expect(r1.body.patches[0].hash).toBe(r2.body.patches[0].hash);
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

  test('GET /api/filecontext returns real file lines', async () => {
    const shortHash = commitHash.slice(0, 8);
    const { status, body } = await httpRequest(
      `${baseUrl}/api/filecontext?hash=${shortHash}&file=feature.js&start=1&end=2`
    );
    expect(status).toBe(200);
    expect(body.lines[0].content).toBe('function hello() {');
    expect(body.totalLines).toBe(3);
  });

  test('GET /api/filecontext with bad params returns 400', async () => {
    const { status } = await httpRequest(`${baseUrl}/api/filecontext?hash=abc123&file=f.js&start=5&end=3`);
    expect(status).toBe(400);
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

'use strict';

const request = require('supertest');
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

// ── Mock git.js and claude.js before requiring server.js ──────────────────

jest.mock('../src/git', () => ({
  getHeadHash: jest.fn(),
  getDiffPerCommit: jest.fn(),
  getDiffForCommit: jest.fn(),
  getDiffBetweenCommits: jest.fn(),
  getFileLines: jest.fn(),
  discoverWorktrees: jest.fn(),
}));

jest.mock('../src/claude', () => ({
  submitReview: jest.fn(),
}));

const { getHeadHash, getDiffPerCommit, getDiffForCommit, getDiffBetweenCommits, getFileLines, discoverWorktrees } = require('../src/git');
const { submitReview }     = require('../src/claude');
const { createApp, findAvailablePort, startServer } = require('../src/server');

// ── Fixtures ───────────────────────────────────────────────────────────────

const PATCHES = [
  {
    hash: 'aaa111',
    message: 'bugABC - Part 1: Add WebIDL',
    files: [
      {
        oldPath: 'dom/media/Foo.webidl',
        newPath: 'dom/media/Foo.webidl',
        binary: false,
        hunks: [
          {
            header: '@@ -1,3 +1,4 @@',
            oldStart: 1, oldCount: 3, newStart: 1, newCount: 4,
            lines: [
              { type: 'context', content: 'interface Foo {', newLineNum: 1, oldLineNum: 1 },
              { type: 'added',   content: '  void toggle();', newLineNum: 2, oldLineNum: null },
            ],
          },
        ],
      },
    ],
  },
  {
    hash: 'bbb222',
    message: 'bugABC - Part 2: Implement logic',
    files: [
      {
        oldPath: 'dom/media/Bar.cpp',
        newPath: 'dom/media/Bar.cpp',
        binary: false,
        hunks: [],
      },
    ],
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────

function makeApp() {
  return createApp({
    worktreeName: 'bugABC',
    worktreePath: '/fake/worktree',
    mainRepoPath: '/fake/firefox',
  });
}

// ── GET /api/diff ──────────────────────────────────────────────────────────

describe('GET /api/diff', () => {
  beforeEach(() => {
    getHeadHash.mockReturnValue('abc123');
    getDiffPerCommit.mockReset();
  });

  test('returns 200 with patches array on success', async () => {
    getDiffPerCommit.mockReturnValue(PATCHES);
    const app = makeApp();
    const res = await request(app).get('/api/diff');
    expect(res.status).toBe(200);
    expect(res.body.repoName).toBe('firefox');
    expect(res.body.worktreeName).toBe('bugABC');
    expect(res.body.worktreePath).toBe('/fake/worktree');
    expect(res.body.patches).toHaveLength(2);
    expect(res.body.patches[0].hash).toBe('aaa111');
    expect(res.body.patches[1].hash).toBe('bbb222');
  });

  test('returns correct file and hunk data per patch', async () => {
    getDiffPerCommit.mockReturnValue(PATCHES);
    const app = makeApp();
    const res = await request(app).get('/api/diff');
    const patch1 = res.body.patches[0];
    expect(patch1.files).toHaveLength(1);
    expect(patch1.files[0].newPath).toBe('dom/media/Foo.webidl');
    expect(patch1.files[0].hunks[0].lines).toHaveLength(2);
  });

  test('returns 500 when git throws', async () => {
    getDiffPerCommit.mockImplementation(() => { throw new Error('git failed'); });
    const app = makeApp();
    const res = await request(app).get('/api/diff');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('git failed');
  });

  test('caches result — getDiffPerCommit called only once when HEAD does not change', async () => {
    getDiffPerCommit.mockReturnValue(PATCHES);
    const app = makeApp();
    await request(app).get('/api/diff');
    await request(app).get('/api/diff');
    expect(getDiffPerCommit).toHaveBeenCalledTimes(1);
  });

  test('recomputes when HEAD hash changes between requests', async () => {
    getDiffPerCommit.mockReturnValue(PATCHES);
    getHeadHash
      .mockReturnValueOnce('abc123')
      .mockReturnValueOnce('def456');
    const app = makeApp();
    await request(app).get('/api/diff');
    await request(app).get('/api/diff');
    expect(getDiffPerCommit).toHaveBeenCalledTimes(2);
  });
});

// ── GET /api/headhash ──────────────────────────────────────────────────────

describe('GET /api/headhash', () => {
  test('returns current HEAD hash', async () => {
    getHeadHash.mockReturnValue('deadbeef');
    const app = makeApp();
    const res = await request(app).get('/api/headhash');
    expect(res.status).toBe(200);
    expect(res.body.hash).toBe('deadbeef');
  });

  test('returns 500 when git throws', async () => {
    getHeadHash.mockImplementation(() => { throw new Error('not a repo'); });
    const app = makeApp();
    const res = await request(app).get('/api/headhash');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('not a repo');
  });
});

// ── POST /api/submit ───────────────────────────────────────────────────────

describe('POST /api/submit', () => {
  beforeEach(() => {
    getHeadHash.mockReturnValue('abc123');
    getDiffPerCommit.mockReset();
    submitReview.mockReset();
    getDiffPerCommit.mockReturnValue(PATCHES);
    submitReview.mockReturnValue({
      feedbackPath: '/fake/worktree/REVIEW_FEEDBACK_bugABC.md',
      prompt: 'You are being asked to revise…',
    });
  });

  const validAllFeedback = [
    { hash: 'aaa111', comments: [{ file: 'dom/media/Foo.webidl', line: 2, lineContent: '  void toggle();', text: 'Use camelCase' }], generalComment: '' },
    { hash: 'bbb222', comments: [], generalComment: '' },
  ];

  const validBody = {
    allFeedback: validAllFeedback,
  };

  test('returns 200 with ok, feedbackPath, and prompt on valid input', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/submit').send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.feedbackPath).toContain('REVIEW_FEEDBACK_bugABC.md');
    expect(res.body.prompt).toBeTruthy();
  });

  test('calls submitReview with allPatches and allFeedback', async () => {
    const app = makeApp();
    await request(app).post('/api/submit').send(validBody);
    expect(submitReview).toHaveBeenCalledTimes(1);
    const [worktreePath, worktreeName, allPatches, allFeedback] = submitReview.mock.calls[0];
    expect(worktreePath).toBe('/fake/worktree');
    expect(worktreeName).toBe('bugABC');
    expect(allPatches).toHaveLength(2);
    expect(allFeedback[0].comments[0].text).toBe('Use camelCase');
  });

  test('returns 400 when allFeedback is missing', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/submit').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  test('returns 400 when no activity at all', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/submit').send({
      allFeedback: [
        { hash: 'aaa111', comments: [], generalComment: '' },
        { hash: 'bbb222', comments: [], generalComment: '' },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  test('returns 200 when only generalComment is provided', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/submit').send({
      allFeedback: [
        { hash: 'aaa111', comments: [], generalComment: 'Please use RAII.' },
        { hash: 'bbb222', comments: [], generalComment: '' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('returns 200 for denied patches even without text feedback', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/submit').send({
      allFeedback: [
        { hash: 'aaa111', comments: [], generalComment: '' },
        { hash: 'bbb222', comments: [], generalComment: '' },
      ],
      deniedHashes: ['aaa111'],
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('passes approvedHashes to submitReview', async () => {
    const app = makeApp();
    await request(app).post('/api/submit').send({ ...validBody, approvedHashes: ['bbb222'] });
    const approvedArg = submitReview.mock.calls[0][4];
    expect(approvedArg).toEqual(['bbb222']);
  });

  test('passes empty approvedHashes when not provided', async () => {
    const app = makeApp();
    await request(app).post('/api/submit').send(validBody);
    const approvedArg = submitReview.mock.calls[0][4];
    expect(approvedArg).toEqual([]);
  });

  test('passes deniedHashes to submitReview', async () => {
    const app = makeApp();
    await request(app).post('/api/submit').send({ ...validBody, deniedHashes: ['bbb222'] });
    const deniedArg = submitReview.mock.calls[0][5];
    expect(deniedArg).toEqual(['bbb222']);
  });

  test('passes empty deniedHashes when not provided', async () => {
    const app = makeApp();
    await request(app).post('/api/submit').send(validBody);
    const deniedArg = submitReview.mock.calls[0][5];
    expect(deniedArg).toEqual([]);
  });

  test('returns 500 when submitReview throws', async () => {
    submitReview.mockImplementation(() => { throw new Error('write failed'); });
    const app = makeApp();
    const res = await request(app).post('/api/submit').send(validBody);
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('write failed');
  });
});

// ── GET /api/state + POST /api/state ──────────────────────────────────────

describe('GET /api/state', () => {
  let tmpDir;
  beforeEach(() => {
    getHeadHash.mockReturnValue('abc123');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxreview-state-'));
    getDiffPerCommit.mockReset();
    submitReview.mockReset();
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function makeStateApp() {
    getDiffPerCommit.mockReturnValue(PATCHES);
    return createApp({ worktreeName: 'bugABC', worktreePath: tmpDir, mainRepoPath: '/fake/firefox' });
  }

  test('GET returns empty object when no state file exists', async () => {
    const app = makeStateApp();
    const res = await request(app).get('/api/state');
    expect(res.status).toBe(200);
    expect(res.body.prompt).toBeNull();
  });

  test('POST persists state and can be retrieved via GET', async () => {
    const app = makeStateApp();
    const payload = {
      comments: { aaa111: { 'file.cpp': { n5: { file: 'file.cpp', line: 5, lineContent: 'x', text: 'fix this' } } } },
      generalComments: { aaa111: 'overall concern' },
      skipped: ['bbb222'],
      approved: [],
    };
    const postRes = await request(app).post('/api/state').send(payload);
    expect(postRes.status).toBe(200);
    expect(postRes.body.ok).toBe(true);
    expect(postRes.body.prompt).toBeUndefined();

    const getRes = await request(app).get('/api/state');
    expect(getRes.status).toBe(200);
    expect(getRes.body.skipped).toEqual(['bbb222']);
    expect(getRes.body.generalComments.aaa111).toBe('overall concern');
  });

  test('POST never calls submitReview', async () => {
    const app = makeStateApp();
    const postRes = await request(app).post('/api/state').send({
      comments: { aaa111: { 'file.cpp': { n5: { file: 'file.cpp', line: 5, lineContent: 'x', text: 'fix' } } } },
      generalComments: {}, skipped: [], approved: [], denied: ['aaa111'],
    });
    expect(postRes.body.ok).toBe(true);
    expect(submitReview).not.toHaveBeenCalled();
  });

  test('GET returns existing prompt from MD file', async () => {
    const app = makeStateApp();
    const mdPath = require('path').join(tmpDir, 'REVIEW_FEEDBACK_bugABC.md');
    require('fs').writeFileSync(mdPath, 'existing prompt content', 'utf8');
    const res = await request(app).get('/api/state');
    expect(res.body.prompt).toBe('existing prompt content');
  });

  test('approved hashes are persisted and retrieved', async () => {
    const app = makeStateApp();
    await request(app).post('/api/state').send({ approved: ['aaa111'], skipped: [], comments: {}, generalComments: {} });
    const res = await request(app).get('/api/state');
    expect(res.body.approved).toEqual(['aaa111']);
  });
});

// ── GET /api/patchdiff/:hash ───────────────────────────────────────────────

describe('GET /api/patchdiff/:hash', () => {
  beforeEach(() => {
    getHeadHash.mockReturnValue('abc123');
    getDiffPerCommit.mockReset();
    getDiffForCommit.mockReset();
    getDiffPerCommit.mockReturnValue(PATCHES);
  });

  const SAMPLE_FILES = [
    {
      oldPath: 'dom/media/Foo.webidl',
      newPath: 'dom/media/Foo.webidl',
      binary: false,
      hunks: [],
    },
  ];

  test('returns 200 with hash and files on valid hash', async () => {
    getDiffForCommit.mockReturnValue(SAMPLE_FILES);
    const app = makeApp();
    const res = await request(app).get('/api/patchdiff/abc1234');
    expect(res.status).toBe(200);
    expect(res.body.hash).toBe('abc1234');
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].newPath).toBe('dom/media/Foo.webidl');
  });

  test('returns 400 for invalid hash format', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/patchdiff/not-a-hash!!');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid hash format');
  });

  test('returns 404 when git throws', async () => {
    getDiffForCommit.mockImplementation(() => { throw new Error('bad object abc9999'); });
    const app = makeApp();
    const res = await request(app).get('/api/patchdiff/abc9999');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('abc9999');
  });
});

// ── GET /api/revdiff ───────────────────────────────────────────────────────

describe('GET /api/revdiff', () => {
  const SAMPLE_FILES = [{ oldPath: 'dom/media/Foo.cpp', newPath: 'dom/media/Foo.cpp', binary: false, hunks: [] }];

  beforeEach(() => {
    getHeadHash.mockReturnValue('abc123');
    getDiffBetweenCommits.mockReset();
  });

  test('returns 200 with from, to, and files on valid hashes', async () => {
    getDiffBetweenCommits.mockReturnValue(SAMPLE_FILES);
    const app = makeApp();
    const res = await request(app).get('/api/revdiff?from=aaa1111&to=bbb2222');
    expect(res.status).toBe(200);
    expect(res.body.from).toBe('aaa1111');
    expect(res.body.to).toBe('bbb2222');
    expect(res.body.files).toHaveLength(1);
    expect(getDiffBetweenCommits).toHaveBeenCalledWith('/fake/worktree', 'aaa1111', 'bbb2222');
  });

  test('returns 400 when from hash is invalid', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/revdiff?from=bad!!&to=bbb2222');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid hash format');
  });

  test('returns 400 when to hash is missing', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/revdiff?from=aaa1111');
    expect(res.status).toBe(400);
  });

  test('returns 500 when git throws', async () => {
    getDiffBetweenCommits.mockImplementation(() => { throw new Error('bad object'); });
    const app = makeApp();
    const res = await request(app).get('/api/revdiff?from=aaa1111&to=bbb2222');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('bad object');
  });
});

// ── startServer pidFile ────────────────────────────────────────────────────

describe('startServer pidFile', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxreview-srv-'));
    getHeadHash.mockReturnValue('abc123');
    getDiffPerCommit.mockReturnValue(PATCHES);
    discoverWorktrees.mockReturnValue([]);
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('writes pid:port to pidFile after server binds', async () => {
    const pidFile = path.join(tmpDir, 'test.pid');
    const server = await startServer({
      worktreeName: 'bugABC',
      worktreePath: tmpDir,
      mainRepoPath: '/fake/firefox',
      pidFile,
      noOpen: true,
    });
    try {
      expect(fs.existsSync(pidFile)).toBe(true);
      const content = fs.readFileSync(pidFile, 'utf8').trim();
      const [pid, port] = content.split(':');
      expect(Number(pid)).toBe(process.pid);
      expect(Number(port)).toBeGreaterThan(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('does not throw when pidFile is not provided', async () => {
    const server = await startServer({
      worktreeName: 'bugABC',
      worktreePath: tmpDir,
      mainRepoPath: '/fake/firefox',
      noOpen: true,
    });
    await new Promise((resolve) => server.close(resolve));
  });

  test('binds to the specified port when --port is given', async () => {
    const desiredPort = await findAvailablePort(19900);
    const server = await startServer({
      worktreeName: 'bugABC',
      worktreePath: tmpDir,
      mainRepoPath: '/fake/firefox',
      port: desiredPort,
      noOpen: true,
    });
    try {
      expect(server.address().port).toBe(desiredPort);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('does not open browser when noOpen is true', async () => {
    let browserOpened = false;
    jest.spyOn(require('child_process'), 'execSync').mockImplementation((cmd) => {
      if (/^open |^xdg-open |^start /.test(cmd)) browserOpened = true;
    });
    const server = await startServer({
      worktreeName: 'bugABC',
      worktreePath: tmpDir,
      mainRepoPath: '/fake/firefox',
      noOpen: true,
    });
    try {
      expect(browserOpened).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      jest.restoreAllMocks();
    }
  });
});

// ── findAvailablePort ──────────────────────────────────────────────────────

describe('findAvailablePort', () => {
  test('returns the preferred port when it is free on 127.0.0.1', async () => {
    const port = await findAvailablePort(19999);
    expect(port).toBe(19999);
  });

  test('skips to next port when preferred is already bound on 127.0.0.1', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(19998, '127.0.0.1', resolve));
    try {
      const port = await findAvailablePort(19998);
      expect(port).toBe(19999);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});

// ── GET /api/filecontext ───────────────────────────────────────────────────

describe('GET /api/filecontext', () => {
  const SAMPLE_RESULT = {
    lines: [
      { type: 'context', content: 'void Foo::Bar() {', newLineNum: 10, oldLineNum: 10 },
      { type: 'context', content: '  return true;',    newLineNum: 11, oldLineNum: 11 },
    ],
    totalLines: 200,
  };

  beforeEach(() => {
    getHeadHash.mockReturnValue('abc123');
    getFileLines.mockReset();
  });

  test('returns 200 with lines and totalLines on valid request', async () => {
    getFileLines.mockReturnValue(SAMPLE_RESULT);
    const app = makeApp();
    const res = await request(app).get('/api/filecontext?hash=abc1234&file=dom/media/Foo.cpp&start=10&end=11');
    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.totalLines).toBe(200);
    expect(getFileLines).toHaveBeenCalledWith('/fake/worktree', 'abc1234', 'dom/media/Foo.cpp', 10, 11);
  });

  test('returns 400 when hash is missing', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/filecontext?file=dom/media/Foo.cpp&start=1&end=5');
    expect(res.status).toBe(400);
  });

  test('returns 400 when hash has invalid format', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/filecontext?hash=not-valid!!&file=dom/media/Foo.cpp&start=1&end=5');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  test('returns 400 when file is missing', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/filecontext?hash=abc1234&start=1&end=5');
    expect(res.status).toBe(400);
  });

  test('returns 400 when start is 0 (not a valid line number)', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/filecontext?hash=abc1234&file=dom/media/Foo.cpp&start=0&end=5');
    expect(res.status).toBe(400);
  });

  test('returns 400 when end is less than start', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/filecontext?hash=abc1234&file=dom/media/Foo.cpp&start=10&end=5');
    expect(res.status).toBe(400);
  });

  test('returns 400 when start and end are non-numeric', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/filecontext?hash=abc1234&file=dom/media/Foo.cpp&start=abc&end=def');
    expect(res.status).toBe(400);
  });

  test('returns 404 when git throws', async () => {
    getFileLines.mockImplementation(() => { throw new Error('path not found in tree'); });
    const app = makeApp();
    const res = await request(app).get('/api/filecontext?hash=abc1234&file=dom/media/Foo.cpp&start=1&end=5');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('path not found in tree');
  });
});

// ── GET /api/worktrees ─────────────────────────────────────────────────────

describe('GET /api/worktrees', () => {
  const WORKTREES = [
    { path: '/fake/firefox-bugABC', branch: 'bug-ABC', worktreeName: 'bugABC' },
    { path: '/fake/firefox-bugXYZ', branch: 'bug-XYZ', worktreeName: 'bugXYZ' },
  ];

  beforeEach(() => {
    getHeadHash.mockReturnValue('abc123');
    discoverWorktrees.mockReset();
  });

  test('returns 200 with current worktree and full list including main repo', async () => {
    discoverWorktrees.mockReturnValue(WORKTREES);
    const app = makeApp();
    const res = await request(app).get('/api/worktrees');
    expect(res.status).toBe(200);
    expect(res.body.current).toBe('bugABC');
    // list includes main repo (path.basename('/fake/firefox') = 'firefox') + two worktrees
    expect(res.body.worktrees).toHaveLength(3);
    expect(res.body.worktrees[0].isMain).toBe(true);
    expect(res.body.worktrees.map((w) => w.worktreeName)).toContain('bugABC');
    expect(res.body.worktrees.map((w) => w.worktreeName)).toContain('bugXYZ');
  });

  test('returns current worktree name matching the one the app was started with', async () => {
    discoverWorktrees.mockReturnValue([]);
    const app = makeApp(); // started with worktreeName: 'bugABC'
    const res = await request(app).get('/api/worktrees');
    expect(res.body.current).toBe('bugABC');
  });

  test('returns 500 when discoverWorktrees throws', async () => {
    discoverWorktrees.mockImplementation(() => { throw new Error('git error'); });
    const app = makeApp();
    const res = await request(app).get('/api/worktrees');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('git error');
  });
});

// ── POST /api/switch ───────────────────────────────────────────────────────

describe('POST /api/switch', () => {
  const WORKTREES = [
    { path: '/fake/firefox-bugABC', branch: 'bug-ABC', worktreeName: 'bugABC' },
    { path: '/fake/firefox-bugXYZ', branch: 'bug-XYZ', worktreeName: 'bugXYZ' },
  ];

  beforeEach(() => {
    getHeadHash.mockReturnValue('abc123');
    getDiffPerCommit.mockReturnValue(PATCHES);
    discoverWorktrees.mockReset();
    discoverWorktrees.mockReturnValue(WORKTREES);
  });

  test('returns 200 with ok, new worktreeName, and worktreePath on valid switch', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/switch').send({ worktreeName: 'bugXYZ' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.worktreeName).toBe('bugXYZ');
    expect(res.body.worktreePath).toBe('/fake/firefox-bugXYZ');
  });

  test('can switch to the main repo entry', async () => {
    const app = makeApp();
    // path.basename('/fake/firefox') = 'firefox' — the main repo entry
    const res = await request(app).post('/api/switch').send({ worktreeName: 'firefox' });
    expect(res.status).toBe(200);
    expect(res.body.worktreeName).toBe('firefox');
  });

  test('subsequent /api/diff uses the switched worktree', async () => {
    const app = makeApp();
    await request(app).post('/api/switch').send({ worktreeName: 'bugXYZ' });
    await request(app).get('/api/diff');
    // getDiffPerCommit should be called with the new worktreePath
    expect(getDiffPerCommit).toHaveBeenCalledWith('/fake/firefox-bugXYZ', expect.any(String));
  });

  test('returns 404 when the requested worktree does not exist', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/switch').send({ worktreeName: 'doesNotExist' });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('doesNotExist');
  });

  test('returns 400 when worktreeName is missing', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/switch').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  test('returns 500 when discoverWorktrees throws', async () => {
    discoverWorktrees.mockImplementation(() => { throw new Error('git error'); });
    const app = makeApp();
    const res = await request(app).post('/api/switch').send({ worktreeName: 'bugXYZ' });
    expect(res.status).toBe(500);
  });
});

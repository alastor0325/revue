'use strict';

const request = require('supertest');
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

// ── Mock git.js and claude.js before requiring server.js ──────────────────

jest.mock('../src/git', () => ({
  getDiffPerCommit: jest.fn(),
}));

jest.mock('../src/claude', () => ({
  submitReview: jest.fn(),
}));

const { getDiffPerCommit } = require('../src/git');
const { submitReview }     = require('../src/claude');
const { createApp, findAvailablePort } = require('../src/server');

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
    getDiffPerCommit.mockReset();
  });

  test('returns 200 with patches array on success', async () => {
    getDiffPerCommit.mockReturnValue(PATCHES);
    const app = makeApp();
    const res = await request(app).get('/api/diff');
    expect(res.status).toBe(200);
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

  test('caches result — getDiffPerCommit called only once across multiple requests', async () => {
    getDiffPerCommit.mockReturnValue(PATCHES);
    const app = makeApp();
    await request(app).get('/api/diff');
    await request(app).get('/api/diff');
    expect(getDiffPerCommit).toHaveBeenCalledTimes(1);
  });
});

// ── POST /api/submit ───────────────────────────────────────────────────────

describe('POST /api/submit', () => {
  beforeEach(() => {
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
    patchHash: 'aaa111',
    allFeedback: validAllFeedback,
  };

  test('returns 200 with ok, feedbackPath, and command on valid input', async () => {
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

  test('returns 400 when patchHash is missing', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/submit').send({ allFeedback: validAllFeedback });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  test('returns 400 when allFeedback is missing', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/submit').send({ patchHash: 'aaa111' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  test('returns 400 when current patch has no comments and no general comment', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/submit').send({
      patchHash: 'aaa111',
      allFeedback: [
        { hash: 'aaa111', comments: [], generalComment: '' },
        { hash: 'bbb222', comments: [], generalComment: '' },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  test('returns 200 when only generalComment is provided for current patch', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/submit').send({
      patchHash: 'aaa111',
      allFeedback: [
        { hash: 'aaa111', comments: [], generalComment: 'Please use RAII.' },
        { hash: 'bbb222', comments: [], generalComment: '' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('returns 404 when patchHash does not match any patch', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/submit').send({
      patchHash: 'zzz999',
      allFeedback: [{ hash: 'zzz999', comments: [{ file: 'f', line: 1, lineContent: 'x', text: 'y' }], generalComment: '' }],
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('zzz999');
  });

  test('passes skippedHashes to submitReview', async () => {
    const app = makeApp();
    await request(app).post('/api/submit').send({ ...validBody, skippedHashes: ['bbb222'] });
    const skippedArg = submitReview.mock.calls[0][4];
    expect(skippedArg).toEqual(['bbb222']);
  });

  test('passes empty skippedHashes when not provided', async () => {
    const app = makeApp();
    await request(app).post('/api/submit').send(validBody);
    const skippedArg = submitReview.mock.calls[0][4];
    expect(skippedArg).toEqual([]);
  });

  test('passes approvedHashes to submitReview', async () => {
    const app = makeApp();
    await request(app).post('/api/submit').send({ ...validBody, approvedHashes: ['bbb222'] });
    const approvedArg = submitReview.mock.calls[0][5];
    expect(approvedArg).toEqual(['bbb222']);
  });

  test('passes empty approvedHashes when not provided', async () => {
    const app = makeApp();
    await request(app).post('/api/submit').send(validBody);
    const approvedArg = submitReview.mock.calls[0][5];
    expect(approvedArg).toEqual([]);
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxreview-state-'));
    getDiffPerCommit.mockReset();
    submitReview.mockReset();
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function makeStateApp() {
    getDiffPerCommit.mockReturnValue(PATCHES);
    submitReview.mockImplementation((_, name, _patches, _feedback) => ({
      feedbackPath: `${tmpDir}/REVIEW_FEEDBACK_${name}.md`,
      prompt: `You are being asked to revise your implementation in worktree firefox-${name}.`,
    }));
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

    const getRes = await request(app).get('/api/state');
    expect(getRes.status).toBe(200);
    expect(getRes.body.skipped).toEqual(['bbb222']);
    expect(getRes.body.generalComments.aaa111).toBe('overall concern');
  });

  test('POST regenerates MD and returns prompt when feedback exists', async () => {
    const app = makeStateApp();
    const payload = {
      comments: { aaa111: { 'file.cpp': { n5: { file: 'file.cpp', line: 5, lineContent: 'x', text: 'fix this' } } } },
      generalComments: {},
      skipped: [],
      approved: [],
    };
    const postRes = await request(app).post('/api/state').send(payload);
    expect(postRes.body.prompt).toBeTruthy();
    expect(postRes.body.prompt).toContain('bugABC');
    expect(submitReview).toHaveBeenCalled();
    // allFeedback passed to submitReview should include the comment
    const allFeedbackArg = submitReview.mock.calls[0][3];
    expect(allFeedbackArg.find(f => f.hash === 'aaa111').comments).toHaveLength(1);
  });

  test('GET returns existing prompt from MD file', async () => {
    const app = makeStateApp();
    // Write MD file directly
    const mdPath = require('path').join(tmpDir, 'REVIEW_FEEDBACK_bugABC.md');
    require('fs').writeFileSync(mdPath, 'existing prompt content', 'utf8');
    const res = await request(app).get('/api/state');
    expect(res.body.prompt).toBe('existing prompt content');
  });

  test('POST does not regenerate MD when no feedback exists', async () => {
    const app = makeStateApp();
    const postRes = await request(app).post('/api/state').send({
      comments: {}, generalComments: {}, skipped: [], approved: [],
    });
    expect(postRes.body.prompt).toBeNull();
    const mdPath = require('path').join(tmpDir, 'REVIEW_FEEDBACK_bugABC.md');
    expect(require('fs').existsSync(mdPath)).toBe(false);
  });

  test('approved hashes are persisted and retrieved', async () => {
    const app = makeStateApp();
    await request(app).post('/api/state').send({ approved: ['aaa111'], skipped: [], comments: {}, generalComments: {} });
    const res = await request(app).get('/api/state');
    expect(res.body.approved).toEqual(['aaa111']);
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

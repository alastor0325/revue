'use strict';

const request = require('supertest');
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Mock git.js and claude.js before requiring server.js ──────────────────

jest.mock('../src/git', () => ({
  getDiffPerCommit: jest.fn(),
}));

jest.mock('../src/claude', () => ({
  submitReview: jest.fn(),
}));

const { getDiffPerCommit } = require('../src/git');
const { submitReview }     = require('../src/claude');
const { createApp }        = require('../src/server');

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
      feedbackPath: '/fake/worktree/REVIEW_FEEDBACK_aaa111.md',
      command: 'cd "/fake/worktree" && claude --print "$(cat REVIEW_FEEDBACK_aaa111.md)"',
    });
  });

  const validBody = {
    patchHash: 'aaa111',
    comments: [
      { file: 'dom/media/Foo.webidl', line: 2, lineContent: '  void toggle();', text: 'Use camelCase' },
    ],
  };

  test('returns 200 with ok, feedbackPath, and command on valid input', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/submit').send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.feedbackPath).toContain('REVIEW_FEEDBACK_aaa111.md');
    expect(res.body.command).toContain('REVIEW_FEEDBACK_aaa111.md');
  });

  test('calls submitReview with the correct patch and comments', async () => {
    const app = makeApp();
    await request(app).post('/api/submit').send(validBody);
    expect(submitReview).toHaveBeenCalledTimes(1);
    const [worktreePath, worktreeName, patch, allPatches, comments] = submitReview.mock.calls[0];
    expect(worktreePath).toBe('/fake/worktree');
    expect(worktreeName).toBe('bugABC');
    expect(patch.hash).toBe('aaa111');
    expect(allPatches).toHaveLength(2);
    expect(comments[0].text).toBe('Use camelCase');
  });

  test('returns 400 when patchHash is missing', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/submit').send({ comments: validBody.comments });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  test('returns 400 when comments array is empty', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/submit').send({ patchHash: 'aaa111', comments: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  test('returns 400 when comments is missing', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/submit').send({ patchHash: 'aaa111' });
    expect(res.status).toBe(400);
  });

  test('returns 200 when only generalComment is provided (no line comments)', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/submit').send({
      patchHash: 'aaa111',
      comments: [],
      generalComment: 'Please use RAII throughout this patch.',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('passes generalComment to submitReview', async () => {
    const app = makeApp();
    await request(app).post('/api/submit').send({
      patchHash: 'aaa111',
      comments: [],
      generalComment: 'Use RAII.',
    });
    const generalArg = submitReview.mock.calls[0][6];
    expect(generalArg).toBe('Use RAII.');
  });

  test('passes empty string for generalComment when not provided', async () => {
    const app = makeApp();
    await request(app).post('/api/submit').send(validBody);
    const generalArg = submitReview.mock.calls[0][6];
    expect(generalArg).toBe('');
  });

  test('returns 404 when patchHash does not match any patch', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/submit').send({
      patchHash: 'zzz999',
      comments: validBody.comments,
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('zzz999');
  });

  test('passes skippedHashes to submitReview when provided', async () => {
    const app = makeApp();
    await request(app).post('/api/submit').send({
      ...validBody,
      skippedHashes: ['bbb222'],
    });
    const skippedArg = submitReview.mock.calls[0][5];
    expect(skippedArg).toEqual(['bbb222']);
  });

  test('passes empty skippedHashes when not provided', async () => {
    const app = makeApp();
    await request(app).post('/api/submit').send(validBody);
    const skippedArg = submitReview.mock.calls[0][5];
    expect(skippedArg).toEqual([]);
  });

  test('returns 500 when submitReview throws', async () => {
    submitReview.mockImplementation(() => { throw new Error('write failed'); });
    const app = makeApp();
    const res = await request(app).post('/api/submit').send(validBody);
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('write failed');
  });
});

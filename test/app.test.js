'use strict';

// app.js uses browser globals; stub the minimum so the module loads cleanly.
global.document = { addEventListener: () => {} };
global.fetch = () => {};

const { diffFingerprint, migrateApprovals, submitReview, state, drafts } = require('../public/app');

// ── migrateApprovals ───────────────────────────────────────────────────────

describe('migrateApprovals', () => {
  function patches(...hashes) {
    return hashes.map((h) => ({ hash: h, message: '' }));
  }

  test('returns unchanged sets when no hashes changed', () => {
    const prev = patches('aaa', 'bbb');
    const curr = patches('aaa', 'bbb');
    const approved = new Set(['aaa']);
    const denied   = new Set(['bbb']);
    const result = migrateApprovals(prev, curr, approved, denied);
    expect([...result.approved]).toEqual(['aaa']);
    expect([...result.denied]).toEqual(['bbb']);
  });

  test('migrates approved hash when a patch is amended', () => {
    const prev = patches('old1', 'bbb');
    const curr = patches('new1', 'bbb');
    const approved = new Set(['old1']);
    const result = migrateApprovals(prev, curr, approved, new Set());
    expect(result.approved.has('new1')).toBe(true);
    expect(result.approved.has('old1')).toBe(false);
  });

  test('migrates denied hash when a patch is amended', () => {
    const prev = patches('aaa', 'old2');
    const curr = patches('aaa', 'new2');
    const denied = new Set(['old2']);
    const result = migrateApprovals(prev, curr, new Set(), denied);
    expect(result.denied.has('new2')).toBe(true);
    expect(result.denied.has('old2')).toBe(false);
  });

  test('migrates all amended patches in a series', () => {
    const prev = patches('p1old', 'p2old', 'p3old');
    const curr = patches('p1new', 'p2new', 'p3new');
    const approved = new Set(['p1old', 'p3old']);
    const denied   = new Set(['p2old']);
    const result = migrateApprovals(prev, curr, approved, denied);
    expect([...result.approved].sort()).toEqual(['p1new', 'p3new']);
    expect([...result.denied]).toEqual(['p2new']);
  });

  test('preserves unchanged hashes alongside migrated ones', () => {
    const prev = patches('keep', 'oldHash');
    const curr = patches('keep', 'newHash');
    const approved = new Set(['keep', 'oldHash']);
    const result = migrateApprovals(prev, curr, approved, new Set());
    expect(result.approved.has('keep')).toBe(true);
    expect(result.approved.has('newHash')).toBe(true);
    expect(result.approved.has('oldHash')).toBe(false);
  });

  test('does not mutate the original approved/denied sets', () => {
    const prev = patches('a');
    const curr = patches('b');
    const approved = new Set(['a']);
    const denied   = new Set();
    migrateApprovals(prev, curr, approved, denied);
    expect(approved.has('a')).toBe(true); // original unchanged
    expect(approved.has('b')).toBe(false);
  });

  test('handles patch list growing (new patch added at end)', () => {
    const prev = patches('aaa');
    const curr = patches('aaa', 'bbb');
    const approved = new Set(['aaa']);
    const result = migrateApprovals(prev, curr, approved, new Set());
    expect(result.approved.has('aaa')).toBe(true); // unchanged slot preserved
    expect(result.approved.has('bbb')).toBe(false); // new patch not auto-approved
  });

  test('handles patch list shrinking (patch removed from end)', () => {
    const prev = patches('aaa', 'bbb');
    const curr = patches('aaa');
    const approved = new Set(['aaa', 'bbb']);
    const result = migrateApprovals(prev, curr, approved, new Set());
    expect(result.approved.has('aaa')).toBe(true);
    // bbb is still in the set (it was approved; caller decides what to do with orphans)
    expect(result.approved.has('bbb')).toBe(true);
  });

  test('real-world: 7-patch series fully rebased, preserves approvals', () => {
    const oldHashes = ['4c121d73cc59', '54578b393e54', '1691a15381b6', '0638605bdac1',
                       '34a981659e03', '2384470bea8b', 'c9d2cb3e30a4'];
    const newHashes = ['8df262054527', '34bd29cbae3e', '066334383877', 'a788e32159d9',
                       '5d403cf94173', 'e21e480ba360', '1d37ab3f1e94'];
    const prev = patches(...oldHashes);
    const curr = patches(...newHashes);
    // Simulate: patches 0, 1, 2 were approved; patch 3 was denied
    const approved = new Set([oldHashes[0], oldHashes[1], oldHashes[2]]);
    const denied   = new Set([oldHashes[3]]);
    const result = migrateApprovals(prev, curr, approved, denied);
    expect(result.approved.has(newHashes[0])).toBe(true);
    expect(result.approved.has(newHashes[1])).toBe(true);
    expect(result.approved.has(newHashes[2])).toBe(true);
    expect(result.denied.has(newHashes[3])).toBe(true);
    // Old hashes gone
    oldHashes.forEach((h) => {
      expect(result.approved.has(h)).toBe(false);
      expect(result.denied.has(h)).toBe(false);
    });
  });
});

// ── diffFingerprint ────────────────────────────────────────────────────────

describe('diffFingerprint', () => {
  function makePatch(lines) {
    // lines: array of { type: 'added'|'removed'|'context', content: string }
    return { files: [{ hunks: [{ lines }] }] };
  }

  test('returns an 8-char lowercase hex string', () => {
    expect(diffFingerprint({ files: [] })).toMatch(/^[0-9a-f]{8}$/);
    expect(diffFingerprint(makePatch([{ type: 'added', content: 'x' }]))).toMatch(/^[0-9a-f]{8}$/);
  });

  test('context lines do not affect the fingerprint', () => {
    const withCtx    = makePatch([{ type: 'context', content: 'unchanged' }, { type: 'added', content: 'x' }]);
    const withoutCtx = makePatch([{ type: 'added',   content: 'x' }]);
    expect(diffFingerprint(withCtx)).toBe(diffFingerprint(withoutCtx));
  });

  test('different added vs removed produce different fingerprints (type prefix included)', () => {
    const added   = makePatch([{ type: 'added',   content: 'x' }]);
    const removed = makePatch([{ type: 'removed', content: 'x' }]);
    expect(diffFingerprint(added)).not.toBe(diffFingerprint(removed));
  });

  test('same changed lines produce identical fingerprint', () => {
    const lines = [{ type: 'added', content: 'x' }];
    expect(diffFingerprint(makePatch(lines))).toBe(diffFingerprint(makePatch(lines)));
  });

  test('different changed lines produce different fingerprints', () => {
    const p1 = makePatch([{ type: 'added', content: 'foo' }]);
    const p2 = makePatch([{ type: 'added', content: 'bar' }]);
    expect(diffFingerprint(p1)).not.toBe(diffFingerprint(p2));
  });

  // The new compact representation is what actually fixed
  // REVIEW_STATE_*.json blowing past Express's 100 KB body-parser limit
  // (see MULTI_TAB_SYNC_PLAN.md follow-up).  Worth a guard that a patch
  // with many large lines still produces an 8-char hash.
  test('stays compact even for a large patch', () => {
    const big = makePatch(Array.from({ length: 5000 }, (_, i) => ({
      type: 'added', content: `line number ${i} with a fair amount of content`,
    })));
    expect(diffFingerprint(big)).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ── Legacy-format migration ────────────────────────────────────────────────
// State files written before the hash-fingerprint upgrade store the raw
// concatenated lines in `diffFingerprint`.  Those must continue to compare
// correctly against newly-computed (hashed) fingerprints so we don't wipe
// every existing approval on first load after upgrade.

describe('migrateApprovals — legacy long-form fingerprint', () => {
  // Build a tiny patch whose new (hashed) fingerprint we can derive.
  const newPatch = { files: [{ hunks: [{ lines: [{ type: 'added', content: 'foo' }] }] }] };
  const newFp = diffFingerprint(newPatch); // 8 hex chars
  const legacyFp = 'afoo';                  // pre-upgrade format

  test('legacy prev fingerprint matching the same code carries the approval forward', () => {
    const prev = [{ hash: 'old', diffFingerprint: legacyFp }];
    const curr = [{ hash: 'new', diffFingerprint: newFp }];
    const result = migrateApprovals(prev, curr, new Set(['old']), new Set());
    expect(result.approved.has('new')).toBe(true);
    expect(result.approved.has('old')).toBe(false);
  });

  test('legacy prev fingerprint that differs from current still clears the approval', () => {
    const prev = [{ hash: 'old', diffFingerprint: 'abar' }];
    const curr = [{ hash: 'new', diffFingerprint: newFp }];
    const result = migrateApprovals(prev, curr, new Set(['old']), new Set());
    expect(result.approved.has('old')).toBe(false);
    expect(result.approved.has('new')).toBe(false);
  });
});

// ── migrateApprovals — fingerprint-aware decisions ─────────────────────────

describe('migrateApprovals — fingerprint-aware', () => {
  // Real diffFingerprint output is 8 lowercase hex chars; use that shape in
  // these tests so they reflect production data.
  const FP1 = 'aaaaaaaa';
  const FP2 = 'bbbbbbbb';
  function patch(hash, fp) {
    return fp !== undefined ? { hash, diffFingerprint: fp } : { hash };
  }

  test('same fingerprint, different hash → approved migrated to new hash', () => {
    const prev = [patch('old', FP1)];
    const curr = [patch('new', FP1)];
    const result = migrateApprovals(prev, curr, new Set(['old']), new Set());
    expect(result.approved.has('new')).toBe(true);
    expect(result.approved.has('old')).toBe(false);
  });

  test('different fingerprint, different hash → approved cleared and flagged for re-review', () => {
    const prev = [patch('old', FP1)];
    const curr = [patch('new', FP2)];
    const result = migrateApprovals(prev, curr, new Set(['old']), new Set());
    expect(result.approved.has('old')).toBe(false);
    expect(result.approved.has('new')).toBe(false);
    // The new revision of a once-approved patch is flagged so the UI can
    // prompt a re-review.
    expect(result.reapprovalNeeded.has('new')).toBe(true);
  });

  test('different fingerprint → denied cleared too (not flagged for re-review)', () => {
    const prev = [patch('old', FP1)];
    const curr = [patch('new', FP2)];
    const result = migrateApprovals(prev, curr, new Set(), new Set(['old']));
    expect(result.denied.has('old')).toBe(false);
    expect(result.denied.has('new')).toBe(false);
    // Only previously-approved patches need the re-review flag.
    expect(result.reapprovalNeeded.has('new')).toBe(false);
  });

  test('same fingerprint → no re-review flag (approval just carried forward)', () => {
    const prev = [patch('old', FP1)];
    const curr = [patch('new', FP1)];
    const result = migrateApprovals(prev, curr, new Set(['old']), new Set());
    expect(result.reapprovalNeeded.size).toBe(0);
  });

  test('changed fingerprint but never approved → no re-review flag', () => {
    const prev = [patch('old', FP1)];
    const curr = [patch('new', FP2)];
    const result = migrateApprovals(prev, curr, new Set(), new Set());
    expect(result.reapprovalNeeded.size).toBe(0);
  });

  test('no fingerprint on either side → falls back to hash migration', () => {
    const prev = [{ hash: 'old' }];
    const curr = [{ hash: 'new' }];
    const result = migrateApprovals(prev, curr, new Set(['old']), new Set());
    expect(result.approved.has('new')).toBe(true);
    expect(result.approved.has('old')).toBe(false);
  });

  test('fingerprint absent on prev only → falls back to hash migration', () => {
    const prev = [{ hash: 'old' }];
    const curr = [patch('new', 'fp1')];
    const result = migrateApprovals(prev, curr, new Set(['old']), new Set());
    expect(result.approved.has('new')).toBe(true);
  });
});

// ── remapFeedbackHashes — feedback survives an amend ───────────────────────

describe('remapFeedbackHashes', () => {
  const { remapFeedbackHashes } = require('../public/app');

  function comment(text) { return { text }; }

  test('re-keys line comments from the old hash to the new hash', () => {
    const comments = { old1: { 'a.js': { n5: comment('fix this') } } };
    const result = remapFeedbackHashes(comments, {}, [['old1', 'new1']]);
    expect(result.comments.old1).toBeUndefined();
    expect(result.comments.new1['a.js'].n5).toEqual(comment('fix this'));
  });

  test('re-keys the general comment from the old hash to the new hash', () => {
    const general = { old1: 'needs work' };
    const result = remapFeedbackHashes({}, general, [['old1', 'new1']]);
    expect(result.generalComments.old1).toBeUndefined();
    expect(result.generalComments.new1).toBe('needs work');
  });

  test('carries feedback forward unconditionally (never dropped by a diff change)', () => {
    // remap has no notion of whether the diff changed — every changed hash
    // carries its feedback forward. This is the whole point: feedback is only
    // drained by submit, never invalidated by the code changing.
    const comments = { old1: { 'a.js': { n1: comment('keep me') } } };
    const result = remapFeedbackHashes(comments, {}, [['old1', 'new1']]);
    expect(result.comments.new1['a.js'].n1).toEqual(comment('keep me'));
  });

  test('a fresh comment already on the new hash wins over the carried-forward one', () => {
    const comments = {
      old1: { 'a.js': { n5: comment('stale') } },
      new1: { 'a.js': { n5: comment('fresh') } },
    };
    const result = remapFeedbackHashes(comments, {}, [['old1', 'new1']]);
    expect(result.comments.new1['a.js'].n5).toEqual(comment('fresh'));
  });

  test('merges non-colliding files/lines from old and new hashes', () => {
    const comments = {
      old1: { 'a.js': { n5: comment('old-a') } },
      new1: { 'b.js': { n2: comment('new-b') } },
    };
    const result = remapFeedbackHashes(comments, {}, [['old1', 'new1']]);
    expect(result.comments.new1['a.js'].n5).toEqual(comment('old-a'));
    expect(result.comments.new1['b.js'].n2).toEqual(comment('new-b'));
  });

  test('keeps an existing general comment on the new hash over the old one', () => {
    const general = { old1: 'old text', new1: 'new text' };
    const result = remapFeedbackHashes({}, general, [['old1', 'new1']]);
    expect(result.generalComments.new1).toBe('new text');
  });

  test('leaves unrelated hashes and no-op remaps untouched', () => {
    const comments = { other: { 'x.js': { n1: comment('unrelated') } } };
    const result = remapFeedbackHashes(comments, {}, [['same', 'same']]);
    expect(result.comments.other['x.js'].n1).toEqual(comment('unrelated'));
  });

  test('does not mutate the input objects', () => {
    const comments = { old1: { 'a.js': { n5: comment('x') } } };
    const general = { old1: 'y' };
    remapFeedbackHashes(comments, general, [['old1', 'new1']]);
    expect(comments.old1).toBeDefined();
    expect(general.old1).toBe('y');
  });
});

// ── submitReview — approved preserved, denied/comments cleared ─────────────

describe('submitReview — state after submit', () => {
  let elements;

  function makeElement(overrides = {}) {
    return { textContent: '', value: '', classList: { add: jest.fn() }, dataset: {}, ...overrides };
  }

  beforeEach(() => {
    elements = {
      '#result-feedback-path': makeElement(),
      '#result-prompt':        makeElement(),
      '#result-overlay':       makeElement({ classList: { add: jest.fn() } }),
      '#btn-submit':           makeElement({ disabled: false }),
      '#btn-copy-prompt':      makeElement(),
      '#submit-warning':       makeElement(),
    };
    global.document = {
      addEventListener: () => {},
      querySelector: (sel) => elements[sel] || null,
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ feedbackPath: '/fake/REVIEW_FEEDBACK.md', prompt: 'prompt text' }),
    });
    global.navigator = { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } };

    state.patches = [{ hash: 'abc123', message: 'fix: thing', files: [] }];
    state.approved = new Set(['abc123']);
    state.denied   = new Set(['def456']);
    state.comments = { abc123: { 'file.js': { L1: { text: 'nit' } } } };
    state.generalComments = { abc123: 'overall ok' };
  });

  afterEach(() => {
    global.document = { addEventListener: () => {} };
    delete global.navigator;
    state.patches = [];
    state.approved = new Set();
    state.denied   = new Set();
    state.comments = {};
    state.generalComments = {};
  });

  test('approved state is preserved after generating prompt', async () => {
    await submitReview();
    expect(state.approved.has('abc123')).toBe(true);
  });

  test('denied state is cleared after generating prompt', async () => {
    await submitReview();
    expect(state.denied.size).toBe(0);
  });

  test('comments and generalComments are cleared after generating prompt', async () => {
    await submitReview();
    expect(state.comments).toEqual({});
    expect(state.generalComments).toEqual({});
  });

  test('drafts are cleared after generating prompt — refresh must NOT clear them, only submit does', async () => {
    drafts['abc123/file.js/n1'] = 'WIP draft text';
    drafts['abc123/__commit__/msg'] = 'WIP commit draft';
    await submitReview();
    expect(Object.keys(drafts)).toHaveLength(0);
  });

  test('sends the reviewed patch series so the server builds the file from client hashes', async () => {
    await submitReview();
    const submitCall = global.fetch.mock.calls.find((c) => c[0] === '/api/submit');
    const body = JSON.parse(submitCall[1].body);
    expect(body.patches).toEqual([{ hash: 'abc123', message: 'fix: thing' }]);
  });

  test('a comment added while the submit request is in flight is not drained', async () => {
    // Model the reported race: the reviewer adds feedback on a new line while
    // the submit request is still in flight (e.g. reviewing a new version while
    // Claude amends). The blanket reset used to wipe it; now it must survive.
    global.fetch = jest.fn().mockImplementation((url) => ({
      ok: true,
      json: () => {
        if (url === '/api/submit') {
          state.comments.abc123['file.js'].L2 = { text: 'added mid-flight' };
        }
        return Promise.resolve({ feedbackPath: '/fake/REVIEW_FEEDBACK.md', prompt: 'prompt text' });
      },
    }));
    await submitReview();
    // The pre-existing comment was submitted and drained...
    expect(state.comments.abc123?.['file.js']?.L1).toBeUndefined();
    // ...but the one added mid-flight survives.
    expect(state.comments.abc123['file.js'].L2).toEqual({ text: 'added mid-flight' });
  });
});

// ── submitReview — integration hooks (fx-dev-hub) ──────────────────────────

describe('submitReview integration hooks', () => {
  let elements, dispatched;

  function makeElement(overrides = {}) {
    return { textContent: '', value: '', classList: { add: jest.fn() }, dataset: {}, ...overrides };
  }

  beforeEach(() => {
    elements = {
      '#result-feedback-path': makeElement(),
      '#result-prompt':        makeElement(),
      '#result-overlay':       makeElement(),
      '#btn-submit':           makeElement({ disabled: false }),
      '#btn-copy-prompt':      makeElement(),
      '#submit-warning':       makeElement(),
    };
    dispatched = [];
    global.document = {
      addEventListener: () => {},
      querySelector: (sel) => elements[sel] || null,
      dispatchEvent: (ev) => { dispatched.push(ev); return true; },
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ feedbackPath: '/fake/REVIEW_FEEDBACK.md', prompt: 'the review prompt' }),
    });
    global.navigator = { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } };

    state.patches = [{ hash: 'abc123', message: 'fix: thing', files: [] }];
    state.approved = new Set(['abc123']);
    state.denied = new Set();
    state.comments = {};
    state.generalComments = { abc123: 'ok' };
  });

  afterEach(() => {
    global.document = { addEventListener: () => {} };
    delete global.navigator;
    state.patches = [];
    state.approved = new Set();
    state.denied = new Set();
    state.comments = {};
    state.generalComments = {};
  });

  test('restores the button label from data-idle-label when an integration set it', async () => {
    elements['#btn-submit'].dataset.idleLabel = 'Generate & Run in Claude';
    await submitReview();
    expect(elements['#btn-submit'].textContent).toBe('Generate & Run in Claude');
  });

  test('defaults the button label to "Generate Review Prompt" when no idle label is set', async () => {
    await submitReview();
    expect(elements['#btn-submit'].textContent).toBe('Generate Review Prompt');
  });

  test('dispatches revue:prompt-generated carrying the generated prompt', async () => {
    await submitReview();
    const ev = dispatched.find((e) => e.type === 'revue:prompt-generated');
    expect(ev).toBeDefined();
    expect(ev.detail.prompt).toBe('the review prompt');
  });
});

// ── submitReview — auto-copy to clipboard ──────────────────────────────────

describe('submitReview clipboard auto-copy', () => {
  let elements;

  function makeElement(overrides = {}) {
    return { textContent: '', value: '', classList: { add: jest.fn() }, dataset: {}, ...overrides };
  }

  beforeEach(() => {
    elements = {
      '#result-feedback-path': makeElement(),
      '#result-prompt':        makeElement(),
      '#result-overlay':       makeElement({ classList: { add: jest.fn() } }),
      '#btn-submit':           makeElement({ disabled: false }),
      '#btn-copy-prompt':      makeElement(),
      '#submit-warning':       makeElement(),
    };

    global.document = {
      addEventListener: () => {},
      querySelector: (sel) => elements[sel] || null,
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        feedbackPath: '/fake/REVIEW_FEEDBACK_bugABC.md',
        prompt: 'Please revise the following patches…',
      }),
    });

    global.navigator = {
      clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
    };
  });

  afterEach(() => {
    global.document = { addEventListener: () => {} };
    delete global.navigator;
  });

  test('copies the generated prompt to the clipboard automatically', async () => {
    await submitReview();
    expect(global.navigator.clipboard.writeText).toHaveBeenCalledWith(
      'Please revise the following patches…'
    );
  });

  test('sets btn-copy-prompt text to "Copied!" after auto-copy', async () => {
    jest.useFakeTimers();
    await submitReview();
    expect(elements['#btn-copy-prompt'].textContent).toBe('Copied!');
    jest.useRealTimers();
  });

  test('does not throw when clipboard access is denied', async () => {
    global.navigator.clipboard.writeText = jest.fn().mockRejectedValue(new Error('denied'));
    await expect(submitReview()).resolves.not.toThrow();
  });
});

'use strict';

// app.js uses browser globals; stub the minimum so the module loads cleanly.
global.document = { addEventListener: () => {} };
global.fetch = () => {};

const { migrateApprovals } = require('../public/app');

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

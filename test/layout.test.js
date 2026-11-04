/**
 * @jest-environment jsdom
 */
'use strict';

// View layout persisted across reloads (public/layout.js).

const layout = require('../public/layout');

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  layout.resetLayoutCache();
  history.replaceState(null, '', '/r/firefox/');
  layout.setLayoutWorktree('1955763');
});

test('sidebar state is per project page, and survives a reload', () => {
  layout.setSidebarCollapsed(true);
  layout.resetLayoutCache(); // a reload: memory gone, storage kept
  expect(layout.getSidebarCollapsed()).toBe(true);
  layout.resetLayoutCache();
  history.replaceState(null, '', '/r/mediasession/');
  expect(layout.getSidebarCollapsed()).toBe(false);
});

test('rendered and collapsed files are per worktree and survive a reload', () => {
  layout.setRenderedView('index.bs', true);
  layout.setFileCollapsed('abc123:gen/big.js', true);
  layout.resetLayoutCache();
  layout.setLayoutWorktree('1955763');
  expect(layout.isRenderedView('index.bs')).toBe(true);
  expect(layout.isFileCollapsed('abc123:gen/big.js')).toBe(true);
  expect(layout.isFileCollapsed('def456:gen/big.js')).toBe(false); // another patch's copy
  layout.setLayoutWorktree('2053175');
  expect(layout.isRenderedView('index.bs')).toBe(false);
  layout.setLayoutWorktree('1955763');
  layout.setRenderedView('index.bs', false);
  expect(layout.isRenderedView('index.bs')).toBe(false);
});

test('savedPatchIndex follows the hash, then the position, else 0', () => {
  const patches = [{ hash: 'a' }, { hash: 'b' }, { hash: 'c' }];
  expect(layout.savedPatchIndex(patches)).toBe(0);
  layout.savePatch('b', 1);
  expect(layout.savedPatchIndex(patches)).toBe(1);
  expect(layout.savedPatchIndex([{ hash: 'x' }, { hash: 'b' }])).toBe(1);             // moved
  expect(layout.savedPatchIndex([{ hash: 'x' }, { hash: 'y' }, { hash: 'z' }])).toBe(1); // amended: same tab
  expect(layout.savedPatchIndex([{ hash: 'x' }])).toBe(0);                             // fewer patches now
});

test('a corrupt store is ignored, not fatal', () => {
  localStorage.setItem('revue-layout', '{not json');
  expect(layout.getSidebarCollapsed()).toBe(false);
  layout.setSidebarCollapsed(true);
  expect(layout.getSidebarCollapsed()).toBe(true);
});

test('where the tab is lives in sessionStorage: patch, revision view, scroll', () => {
  layout.savePatch('b', 1);
  layout.saveRevisionView({ 0: 'old1' }, { 1: { from: 'r1', to: 'r2' } });
  layout.saveScroll(640);
  expect(localStorage.getItem('revue-layout:/r/firefox/')).not.toContain('old1');
  layout.resetLayoutCache();
  layout.setLayoutWorktree('1955763');
  expect(layout.savedPatchIndex([{ hash: 'a' }, { hash: 'b' }])).toBe(1);
  expect(layout.savedRevisionView()).toEqual({ showRevision: { 0: 'old1' }, compareRevision: { 1: { from: 'r1', to: 'r2' } } });
  expect(layout.savedScroll()).toBe(640);
});

test('keeps at most 50 worktrees per project, dropping the least recently used', () => {
  const now = jest.spyOn(Date, 'now');
  for (let i = 0; i < 52; i++) {
    now.mockReturnValue(1000 + i);
    layout.setLayoutWorktree(`wt${i}`);
    layout.setRenderedView('a.md', true);
  }
  now.mockRestore();
  const stored = JSON.parse(localStorage.getItem('revue-layout:/r/firefox/'));
  expect(Object.keys(stored.worktrees)).toHaveLength(50);
  expect(stored.worktrees.wt0).toBeUndefined();
  expect(stored.worktrees.wt51).toBeDefined();
});

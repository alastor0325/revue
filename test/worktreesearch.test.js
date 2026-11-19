/**
 * @jest-environment jsdom
 */
'use strict';

// Fuzzy search in the worktree bar: the matching (public/worktreesearch.js)
// and the bar's behaviour (public/app.js initWorktreeBar).

global.fetch = jest.fn();
global.EventSource = jest.fn(() => ({ addEventListener: jest.fn(), close: jest.fn() }));

const { normalizeQuery, searchWorktrees, markHtml } = require('../public/worktreesearch');
const { initWorktreeBar } = require('../public/app');
const { WORKTREE_BAR_HTML } = require('./helpers');

const WORKTREES = [
  { worktreeName: 'firefox' },
  { worktreeName: '1955763', branch: 'bug-1955763' },
  { worktreeName: '2053175', branch: 'bug-2053175' },
  { worktreeName: '2059165', branch: 'bug-2059165' },
  { worktreeName: 'vtt-interop', branch: 'bug-1321489' },
  { worktreeName: 'vtt-wpt', branch: 'bug-2010319-webvtt-interop' },
  { worktreeName: 'cue-activation', branch: 'cue-activation-placeholder' },
];
const names = (results) => results.map((r) => r.wt.worktreeName);

describe('searchWorktrees', () => {
  test('an empty query returns every worktree in the given order', () => {
    expect(names(searchWorktrees(WORKTREES, '  '))).toEqual(WORKTREES.map((w) => w.worktreeName));
  });

  test('ranks exact > prefix > substring > subsequence', () => {
    const wts = [{ worktreeName: 'xab' }, { worktreeName: 'a-x-b' }, { worktreeName: 'abc' }, { worktreeName: 'ab' }];
    expect(names(searchWorktrees(wts, 'ab'))).toEqual(['ab', 'abc', 'xab', 'a-x-b']);
  });

  test('letters match as a subsequence that starts a word', () => {
    // Not vtt-wpt: its branch has a "v" only inside a word ("webvtt").
    expect(names(searchWorktrees(WORKTREES, 'vi'))).toEqual(['vtt-interop']);
    expect(names(searchWorktrees(WORKTREES, 'ca'))).toEqual(['cue-activation']);
    expect(names(searchWorktrees(WORKTREES, 'tt'))).toEqual(['vtt-interop', 'vtt-wpt']); // substring
    expect(names(searchWorktrees(WORKTREES, 'ie'))).toEqual(['vtt-interop', 'vtt-wpt']); // the word "interop", in the name or branch
    expect(names(searchWorktrees(WORKTREES, 'nr'))).toEqual([]); // "n…r" in "interop", but no word starts with n
  });

  test('letters across a "-" are a subsequence, not a substring, unless the query has a separator', () => {
    const wts = [{ worktreeName: 'cue-activation', branch: 'cue-activation-placeholder' }, { worktreeName: 'new-patch' }];
    // "np" is in "activatio-n-p-laceholder" only across the "-": new-patch's initials win.
    expect(names(searchWorktrees(wts, 'np'))).toEqual(['new-patch']);
    const [hit] = searchWorktrees([{ worktreeName: 'vtt-interop' }], 'vtt int');
    expect(hit.marks).toEqual([0, 1, 2, 4, 5, 6]);
    // A spaced query ranks a match across the "-" as exact, above a subsequence.
    expect(names(searchWorktrees([{ worktreeName: 'a-x-b' }, { worktreeName: 'a-b' }], 'a b'))).toEqual(['a-b', 'a-x-b']);
  });

  test('a query with a digit matches only consecutive characters', () => {
    expect(names(searchWorktrees(WORKTREES, '205'))).toEqual(['2053175', '2059165']);
    expect(names(searchWorktrees(WORKTREES, '2053'))).toEqual(['2053175']);
    expect(names(searchWorktrees(WORKTREES, '215'))).toEqual([]); // a subsequence of 2053175, not a substring
  });

  test('a pasted "Bug 1955763" or "bug-1955763" finds the worktree', () => {
    expect(normalizeQuery('Bug 1955763')).toBe('1955763');
    expect(normalizeQuery(' bug-1955763 ')).toBe('1955763');
    expect(normalizeQuery('bugfix')).toBe('bugfix'); // "bug" is kept before letters
    expect(names(searchWorktrees(WORKTREES, 'Bug 1955763'))).toEqual(['1955763']);
    // Exact on the name first, then vtt-wpt by its branch "…-webvtt-interop".
    expect(names(searchWorktrees(WORKTREES, 'VTT INTEROP'))).toEqual(['vtt-interop', 'vtt-wpt']);
  });

  test('matches the branch, and says so when the branch matched better', () => {
    const [hit] = searchWorktrees(WORKTREES, 'webvtt');
    expect(hit).toMatchObject({ field: 'branch', wt: { worktreeName: 'vtt-wpt' } });
    // The name wins a tie (both are prefixes).
    expect(searchWorktrees(WORKTREES, '1955')[0].field).toBe('name');
  });

  test('marks the matched characters of the matched field', () => {
    expect(searchWorktrees(WORKTREES, 'vtti')[0].marks).toEqual([0, 1, 2, 4]); // the "-" is skipped
    expect(markHtml('vtt-interop', [0, 1, 2, 4], (s) => s)).toBe('<b>vtt</b>-<b>i</b>nterop');
    expect(markHtml('<a>', [1], (s) => s.replace('<', '&lt;').replace('>', '&gt;'))).toBe('&lt;<b>a</b>&gt;');
  });
});

describe('worktree bar', () => {
  let switchOk;
  const pillNames = () => [...document.querySelectorAll('#worktree-pills .worktree-pill')].map((p) => p.dataset.name);
  const input = () => document.getElementById('worktree-search');
  const type = (text) => { input().value = text; input().dispatchEvent(new Event('input')); };
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const switches = () => global.fetch.mock.calls.filter(([url]) => url === 'api/switch').map(([, o]) => JSON.parse(o.body).worktreeName);
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(async () => {
    document.body.innerHTML = `<div id="top-bar">${WORKTREE_BAR_HTML}</div>
      <div id="result-overlay"></div><textarea id="note"></textarea>`;
    window.location.hash = '';
    switchOk = true;
    global.fetch.mockReset();
    global.fetch.mockImplementation((url) => {
      if (url === 'api/worktrees') return Promise.resolve({ ok: true, json: () => Promise.resolve({ current: 'vtt-interop', worktrees: WORKTREES }) });
      if (url === 'api/switch') return Promise.resolve({ ok: switchOk });
      return Promise.reject(new Error(`Unmocked: ${url}`));
    });
    await initWorktreeBar();
  });

  test('an empty query shows the current worktree first, then the rest in order', () => {
    expect(pillNames()).toEqual(['vtt-interop', 'firefox', '1955763', '2053175', '2059165', 'vtt-wpt', 'cue-activation']);
    expect(document.querySelector('.worktree-pill.active').dataset.name).toBe('vtt-interop');
    // The first other worktree is the one Enter switches to.
    expect(document.querySelector('.worktree-pill.highlighted').dataset.name).toBe('firefox');
  });

  test('typing filters the pills live, best match first, with the matched characters bold', () => {
    type('205');
    expect(pillNames()).toEqual(['2053175', '2059165']);
    expect(document.querySelector('#worktree-pills .worktree-pill').innerHTML).toContain('<b>205</b>3175');
  });

  test('a branch match shows the branch on the pill', () => {
    type('webvtt');
    const pill = document.querySelector('#worktree-pills .worktree-pill');
    expect(pill.querySelector('.worktree-pill-branch:not(.worktree-pill-branch-extra)').textContent).toBe(' · bug-2010319-webvtt-interop');
    expect(pill.title).toBe('bug-2010319-webvtt-interop');
  });

  test('no match says so', () => {
    type('zzz');
    expect(document.getElementById('worktree-pills').textContent).toBe('No worktree matches “zzz”');
    key(input(), 'Enter');
    expect(switches()).toEqual([]);
  });

  test('↓/↑ move the highlight and Enter switches to it, then the box clears and loses focus', async () => {
    type('vtt');
    input().focus();
    key(input(), 'ArrowDown'); // vtt-interop (current) is first; vtt-wpt is highlighted already
    expect(document.querySelector('.worktree-pill.highlighted').dataset.name).toBe('vtt-wpt');
    key(input(), 'ArrowUp');
    expect(document.querySelector('.worktree-pill.highlighted').dataset.name).toBe('vtt-interop');
    expect(input().getAttribute('aria-activedescendant')).toBe(document.querySelector('.worktree-pill.highlighted').id);
    key(input(), 'ArrowDown');
    global.fetch.mockImplementation((url) => Promise.resolve(url === 'api/switch'
      ? { ok: true } : { ok: true, json: () => Promise.resolve({ patches: [], worktreeName: 'vtt-wpt' }) }));
    key(input(), 'Enter');
    await flush();
    expect(switches()).toEqual(['vtt-wpt']);
    expect(window.location.hash).toBe('#vtt-wpt');
    expect(input().value).toBe('');
    expect(document.activeElement).not.toBe(input());
    expect(document.querySelector('.worktree-pill.active').dataset.name).toBe('vtt-wpt');
  });

  test('Esc clears the query, then a second Esc leaves the box', () => {
    input().focus();
    type('vtt');
    key(input(), 'Escape');
    expect(input().value).toBe('');
    expect(pillNames()).toHaveLength(WORKTREES.length);
    expect(document.activeElement).toBe(input());
    key(input(), 'Escape');
    expect(document.activeElement).not.toBe(input());
  });

  test('"/" focuses the box, but not while typing in a text field or the result overlay is open', () => {
    key(document.getElementById('note'), '/');
    expect(document.activeElement).not.toBe(input());
    document.getElementById('result-overlay').classList.add('visible');
    key(document.body, '/');
    expect(document.activeElement).not.toBe(input());
    document.getElementById('result-overlay').classList.remove('visible');
    key(document.body, '/');
    expect(document.activeElement).toBe(input());
  });

  test('clicking a pill switches; a failed switch leaves the current worktree', async () => {
    switchOk = false;
    document.querySelector('.worktree-pill[data-name="firefox"]').click();
    await flush();
    expect(switches()).toEqual(['firefox']);
    expect(document.querySelector('.worktree-pill.active').dataset.name).toBe('vtt-interop');
    expect(document.querySelector('.worktree-pill.switching')).toBeNull();
  });

  test('pills that do not fit go behind "+N", which opens a list of them', () => {
    const pills = document.getElementById('worktree-pills');
    // Lay out 100px pills in a 250px row: two fit.
    Object.defineProperty(pills, 'clientWidth', { configurable: true, get: () => 250 });
    const proto = window.HTMLElement.prototype;
    const left = Object.getOwnPropertyDescriptor(proto, 'offsetLeft');
    const width = Object.getOwnPropertyDescriptor(proto, 'offsetWidth');
    Object.defineProperty(proto, 'offsetLeft', { configurable: true, get() { return [...this.parentNode.children].indexOf(this) * 100; } });
    Object.defineProperty(proto, 'offsetWidth', { configurable: true, get: () => 100 });
    try {
      type('');
      const more = document.getElementById('worktree-more');
      const list = document.getElementById('worktree-more-list');
      expect(pillNames()).toEqual(['vtt-interop', 'firefox']);
      expect(more.hidden).toBe(false);
      expect(more.textContent).toBe('+5 ▾');
      expect(list.hidden).toBe(true);
      more.click();
      expect(list.hidden).toBe(false);
      expect([...list.children].map((p) => p.dataset.name)).toEqual(['1955763', '2053175', '2059165', 'vtt-wpt', 'cue-activation']);
      document.body.click(); // a click elsewhere closes it
      expect(list.hidden).toBe(true);
      // ↓ past the row opens the list at the highlighted one.
      key(input(), 'ArrowDown');
      expect(list.hidden).toBe(false);
      expect(list.querySelector('.highlighted').dataset.name).toBe('1955763');
    } finally {
      Object.defineProperty(proto, 'offsetLeft', left);
      Object.defineProperty(proto, 'offsetWidth', width);
    }
  });

  test('focusing the box refreshes the list, so a new worktree shows up', async () => {
    global.fetch.mockImplementation((url) => Promise.resolve({ ok: true,
      json: () => Promise.resolve({ current: 'vtt-interop', worktrees: [...WORKTREES, { worktreeName: 'brand-new' }] }) }));
    input().dispatchEvent(new Event('focus'));
    await flush();
    type('brand');
    expect(pillNames()).toEqual(['brand-new']);
  });

  test('typing the current worktree highlights it, so Enter stays instead of switching to the next match', async () => {
    type('vtt-interop');
    expect(document.querySelector('.worktree-pill.highlighted').dataset.name).toBe('vtt-interop');
    key(input(), 'Enter');
    await flush();
    expect(switches()).toEqual([]);
  });

  test('a refresh of the list keeps the highlight where the user moved it', async () => {
    type('vtt');
    key(input(), 'ArrowDown'); // vtt-interop → vtt-wpt
    expect(document.querySelector('.worktree-pill.highlighted').dataset.name).toBe('vtt-wpt');
    // The same list: nothing is redrawn.
    input().dispatchEvent(new Event('focus'));
    await flush();
    expect(document.querySelector('.worktree-pill.highlighted').dataset.name).toBe('vtt-wpt');
    // A new worktree that matches comes first; the highlight stays on vtt-wpt.
    global.fetch.mockImplementation(() => Promise.resolve({ ok: true, json: () => Promise.resolve({
      current: 'vtt-interop', worktrees: [{ worktreeName: 'vtt' }, ...WORKTREES] }) }));
    input().dispatchEvent(new Event('focus'));
    await flush();
    expect(pillNames()[0]).toBe('vtt');
    expect(document.querySelector('.worktree-pill.highlighted').dataset.name).toBe('vtt-wpt');
  });

  test('the pills are options of a listbox and not Tab stops', () => {
    expect(input().getAttribute('role')).toBe('combobox');
    expect(document.getElementById('worktree-pills').getAttribute('role')).toBe('listbox');
    const pills = [...document.querySelectorAll('.worktree-pill')];
    expect(pills.every((p) => p.getAttribute('role') === 'option' && p.tabIndex === -1)).toBe(true);
  });
});

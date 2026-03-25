/**
 * @jest-environment jsdom
 */
'use strict';

global.fetch = jest.fn();
global.EventSource = jest.fn(() => ({ addEventListener: jest.fn(), close: jest.fn() }));

const { loadAndRender, init, initWorktreeBar, getPollTimer } = require('../public/app');

function setupDOM() {
  document.body.innerHTML = `
    <div id="top-bar"></div>
    <div id="worktree-bar">
      <button id="worktree-scroll-left" class="worktree-scroll-btn">&#8249;</button>
      <div id="worktree-pills"></div>
      <button id="worktree-scroll-right" class="worktree-scroll-btn">&#8250;</button>
    </div>
    <div id="update-banner" style="display:none;"><button id="btn-reload-page"></button></div>
    <div id="header">
      <div id="header-left">
        <h1><span id="bug-id-display"></span></h1>
        <div id="worktree-path"></div>
      </div>
      <div id="submit-area">
        <button id="btn-submit"></button>
        <span id="submit-warning"></span>
        <span id="autosave-status"></span>
      </div>
    </div>
    <div id="current-prompt-bar" data-prompt=""><span id="current-prompt-label"></span>
      <button id="btn-copy-current-prompt"></button>
    </div>
    <div id="patch-tabs-bar"><div id="patch-tabs"></div></div>
    <div id="loading"></div>
    <div id="error-msg" style="display:none;"></div>
    <div id="main-layout">
      <nav id="file-nav" style="display:none;"></nav>
      <div id="files-changed" style="display:none;"></div>
    </div>
    <div id="result-overlay">
      <div id="result-modal">
        <textarea id="result-prompt"></textarea>
        <button id="btn-copy-prompt"></button>
        <button id="btn-close-modal"></button>
      </div>
    </div>`;
}

function mockFetch(diffData) {
  global.fetch.mockImplementation((url) => {
    if (url === '/api/diff') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(diffData) });
    }
    if (url === '/api/state') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    if (url === '/api/worktrees') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ current: 'bugABC', worktrees: [] }) });
    }
    return Promise.reject(new Error(`Unmocked: ${url}`));
  });
}

describe('document.title — page title reflects repo and worktree', () => {
  beforeEach(() => {
    setupDOM();
    document.title = 'Revue';
    jest.clearAllMocks();
  });

  test('sets title to repoName-worktreeName when diff loads', async () => {
    mockFetch({ repoName: 'firefox', worktreeName: 'bug-1234567', worktreePath: '/Users/dev/firefox-bug-1234567', patches: [] });
    await loadAndRender();
    expect(document.title).toBe('firefox-bug-1234567');
  });

  test('does not change title when repoName is absent', async () => {
    mockFetch({ worktreeName: 'bug-1234567', worktreePath: '/Users/dev/firefox-bug-1234567', patches: [] });
    await loadAndRender();
    expect(document.title).toBe('Revue');
  });

  test('title updates to new worktree name on next init call', async () => {
    mockFetch({ repoName: 'myrepo', worktreeName: 'feat-A', worktreePath: '/Users/dev/myrepo-feat-A', patches: [] });
    await loadAndRender();
    expect(document.title).toBe('myrepo-feat-A');

    mockFetch({ repoName: 'myrepo', worktreeName: 'feat-B', worktreePath: '/Users/dev/myrepo-feat-B', patches: [] });
    await loadAndRender();
    expect(document.title).toBe('myrepo-feat-B');
  });
});

describe('#btn-reload-page — codebase update banner', () => {
  beforeEach(() => {
    setupDOM();
    jest.clearAllMocks();
    global.navigator.clipboard = { writeText: jest.fn().mockResolvedValue(undefined) };
  });

  test('clicking reload button hides the banner and re-renders content', async () => {
    mockFetch({ repoName: 'firefox', worktreeName: 'bug-111', worktreePath: '/dev/firefox-bug-111', patches: [] });
    await init();

    // Simulate a new commit detected: banner becomes visible
    const banner = document.getElementById('update-banner');
    banner.style.display = '';

    // Fresh diff data for the reload
    mockFetch({ repoName: 'firefox', worktreeName: 'bug-111', worktreePath: '/dev/firefox-bug-111', patches: [] });
    document.getElementById('btn-reload-page').click();
    // Allow async click handler to complete
    await new Promise((r) => setTimeout(r, 0));

    expect(banner.style.display).toBe('none');
    // loadAndRender fetches /api/diff again — verify it was called
    const diffCalls = global.fetch.mock.calls.filter(([url]) => url === '/api/diff');
    expect(diffCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('#worktree-bar scroll buttons — shown/hidden based on overflow', () => {
  const WORKTREES = [
    { worktreeName: 'firefox' },
    { worktreeName: 'bug-111' },
    { worktreeName: 'bug-222' },
  ];

  beforeEach(() => {
    setupDOM();
    jest.clearAllMocks();
    global.fetch.mockImplementation((url) => {
      if (url === '/api/worktrees') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ current: 'bug-111', worktrees: WORKTREES }),
        });
      }
      return Promise.reject(new Error(`Unmocked: ${url}`));
    });
  });

  test('scroll buttons are hidden when pills fit without overflow', async () => {
    const pills = document.getElementById('worktree-pills');
    Object.defineProperty(pills, 'scrollWidth', { configurable: true, get: () => 200 });
    Object.defineProperty(pills, 'clientWidth', { configurable: true, get: () => 200 });

    await initWorktreeBar();
    await new Promise((r) => setTimeout(r, 60));

    expect(document.getElementById('worktree-scroll-left').style.display).toBe('none');
    expect(document.getElementById('worktree-scroll-right').style.display).toBe('none');
  });

  test('scroll buttons are visible and left is disabled when at scroll start', async () => {
    const pills = document.getElementById('worktree-pills');
    Object.defineProperty(pills, 'scrollWidth', { configurable: true, get: () => 800 });
    Object.defineProperty(pills, 'clientWidth', { configurable: true, get: () => 200 });
    Object.defineProperty(pills, 'scrollLeft', { configurable: true, get: () => 0 });

    await initWorktreeBar();
    await new Promise((r) => setTimeout(r, 60));

    expect(document.getElementById('worktree-scroll-left').style.display).not.toBe('none');
    expect(document.getElementById('worktree-scroll-right').style.display).not.toBe('none');
    expect(document.getElementById('worktree-scroll-left').disabled).toBe(true);
    expect(document.getElementById('worktree-scroll-right').disabled).toBe(false);
  });

  test('worktree pills are rendered inside #worktree-pills', async () => {
    await initWorktreeBar();
    const pills = document.getElementById('worktree-pills');
    const rendered = pills.querySelectorAll('.worktree-pill');
    expect(rendered).toHaveLength(WORKTREES.length);
    expect(rendered[1].classList.contains('active')).toBe(true); // bug-111 is current
  });
});

describe('#hash navigation — URL hash switches to matching worktree on load', () => {
  const WORKTREES = [
    { worktreeName: 'firefox' },
    { worktreeName: 'bug-111' },
    { worktreeName: 'bug-222' },
  ];

  beforeEach(() => {
    setupDOM();
    jest.clearAllMocks();
  });

  function mockWorktreeFetch(current, switchOk = true) {
    global.fetch.mockImplementation((url, opts) => {
      if (url === '/api/worktrees') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ current, worktrees: WORKTREES }),
        });
      }
      if (url === '/api/switch') {
        return Promise.resolve({ ok: switchOk });
      }
      return Promise.reject(new Error(`Unmocked: ${url}`));
    });
  }

  test('switches to the worktree named in the URL hash on load', async () => {
    window.location.hash = '#bug-222';
    mockWorktreeFetch('bug-111');

    await initWorktreeBar();

    const switchCalls = global.fetch.mock.calls.filter(([url]) => url === '/api/switch');
    expect(switchCalls).toHaveLength(1);
    const body = JSON.parse(switchCalls[0][1].body);
    expect(body.worktreeName).toBe('bug-222');
  });

  test('does not switch when hash already matches current worktree', async () => {
    window.location.hash = '#bug-111';
    mockWorktreeFetch('bug-111');

    await initWorktreeBar();

    const switchCalls = global.fetch.mock.calls.filter(([url]) => url === '/api/switch');
    expect(switchCalls).toHaveLength(0);
  });

  test('does not switch when hash does not match any worktree', async () => {
    window.location.hash = '#nonexistent';
    mockWorktreeFetch('bug-111');

    await initWorktreeBar();

    const switchCalls = global.fetch.mock.calls.filter(([url]) => url === '/api/switch');
    expect(switchCalls).toHaveLength(0);
  });

  test('URL hash is updated to reflect active worktree after successful switch', async () => {
    window.location.hash = '#bug-222';
    mockWorktreeFetch('bug-111');

    await initWorktreeBar();

    expect(window.location.hash).toBe('#bug-222');
  });

  test('URL hash reflects current worktree when no hash is provided', async () => {
    window.location.hash = '';
    mockWorktreeFetch('bug-111');

    await initWorktreeBar();

    expect(window.location.hash).toBe('#bug-111');
  });
});

describe('#hash navigation — hashchange event switches worktree after page load', () => {
  const WORKTREES = [
    { worktreeName: 'firefox' },
    { worktreeName: 'bug-111' },
    { worktreeName: 'bug-222' },
  ];

  function mockSwitchFetch() {
    global.fetch.mockImplementation((url) => {
      if (url === '/api/worktrees') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ current: 'bug-111', worktrees: WORKTREES }),
        });
      }
      if (url === '/api/switch') {
        return Promise.resolve({ ok: true });
      }
      if (url === '/api/diff') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ patches: [], worktreeName: 'bug-222', worktreePath: '/tmp', repoName: 'firefox' }) });
      }
      if (url === '/api/state') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      return Promise.reject(new Error(`Unmocked: ${url}`));
    });
  }

  beforeEach(() => {
    setupDOM();
    jest.clearAllMocks();
    window.location.hash = '';
    mockSwitchFetch();
  });

  test('hashchange triggers switch to the named worktree', async () => {
    await initWorktreeBar();
    jest.clearAllMocks();
    mockSwitchFetch();

    // Call the registered handler directly to avoid async event-dispatch timing issues
    window.location.hash = '#bug-222';
    await initWorktreeBar._hashHandler();

    const switchCalls = global.fetch.mock.calls.filter(([url]) => url === '/api/switch');
    expect(switchCalls).toHaveLength(1);
    expect(JSON.parse(switchCalls[0][1].body).worktreeName).toBe('bug-222');
  });

  test('hashchange to current worktree does not re-switch', async () => {
    await initWorktreeBar();
    jest.clearAllMocks();

    // bug-111 is active; navigating to it again should be a no-op
    window.location.hash = '#bug-111';
    await initWorktreeBar._hashHandler();

    const switchCalls = global.fetch.mock.calls.filter(([url]) => url === '/api/switch');
    expect(switchCalls).toHaveLength(0);
  });

  test('hashchange to unknown worktree is ignored', async () => {
    await initWorktreeBar();
    jest.clearAllMocks();

    window.location.hash = '#nonexistent';
    await initWorktreeBar._hashHandler();

    const switchCalls = global.fetch.mock.calls.filter(([url]) => url === '/api/switch');
    expect(switchCalls).toHaveLength(0);
  });
});

// ── _pollTimer is stored ────────────────────────────────────────────────────

describe('getPollTimer', () => {
  test('returns null before polling starts', () => {
    // _pollTimer is module-level; since startUpdatePolling is async and not called
    // in tests (DOMContentLoaded does not fire in jsdom), the timer stays null.
    expect(getPollTimer()).toBeNull();
  });
});

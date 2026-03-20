/**
 * @jest-environment jsdom
 */
'use strict';

global.fetch = jest.fn();
global.EventSource = jest.fn(() => ({ addEventListener: jest.fn(), close: jest.fn() }));

const { loadAndRender } = require('../public/app');

function setupDOM() {
  document.body.innerHTML = `
    <div id="top-bar"></div>
    <div id="worktree-bar"></div>
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

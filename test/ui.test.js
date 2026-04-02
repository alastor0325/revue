'use strict';

/**
 * UI integration tests — real Chromium browser, real git repo, real server.
 * Run with: npm run test:ui
 *
 * Each test navigates to the running server and interacts via Playwright.
 * The fixture has two patch commits so patch tabs, sidebar, diffs, and all
 * interactive controls are exercised against real rendered HTML.
 *
 * Tests within each describe block are stateful (they share the same page
 * and build on each other). The general-feedback and expand-context describes
 * use fresh pages so their state is clean and unaffected by prior interactions.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const { createApp, findAvailablePort } = require('../src/server');
const { git } = require('./helpers');

// ── Shared fixtures ────────────────────────────────────────────────────────

let tmpDir, mainRepoPath, workRepoPath;
let server, baseUrl;
let browser, page;

async function openFreshPage() {
  const p = await browser.newPage();
  await p.goto(baseUrl);
  await p.waitForSelector('.patch-heading', { state: 'visible' });
  return p;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-ui-'));
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
    'function hello() {\n  return "hello";\n}\n\nmodule.exports = hello;\n'
  );
  git(workRepoPath, 'add .');
  git(workRepoPath, 'commit -m "feat: add hello function"');

  fs.writeFileSync(
    path.join(workRepoPath, 'utils.js'),
    'function add(a, b) {\n  return a + b;\n}\n\nfunction mul(a, b) {\n  return a * b;\n}\n\nmodule.exports = { add, mul };\n'
  );
  git(workRepoPath, 'add .');
  git(workRepoPath, 'commit -m "feat: add math utilities"');

  const app = createApp({
    worktreeName: 'work-repo',
    worktreePath: workRepoPath,
    mainRepoPath,
  });
  const port = await findAvailablePort(19400);
  await new Promise((resolve) => { server = app.listen(port, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${port}`;

  browser = await chromium.launch({ headless: true });
  page = await openFreshPage();
}, 30000);

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}, 15000);

// ── Page structure ─────────────────────────────────────────────────────────

describe('page structure', () => {
  test('page title reflects repo and worktree', async () => {
    const title = await page.title();
    expect(title).toContain('main-repo');
    expect(title).toContain('work-repo');
  });

  test('header shows app name and worktree', async () => {
    const h1 = await page.textContent('h1');
    expect(h1).toContain('Revue');
    const wtPath = await page.textContent('#worktree-path');
    expect(wtPath).toContain('work-repo');
  });

  test('loading indicator is hidden after content loads', async () => {
    const display = await page.$eval('#loading', (el) => getComputedStyle(el).display);
    expect(display).toBe('none');
  });

  test('submit button is initially disabled', async () => {
    expect(await page.$eval('#btn-submit', (el) => el.disabled)).toBe(true);
  });

  test('submit warning message is shown initially', async () => {
    const warn = await page.textContent('#submit-warning');
    expect(warn.trim().length).toBeGreaterThan(0);
  });
});

// ── Patch tabs ─────────────────────────────────────────────────────────────

describe('patch tabs', () => {
  test('tabs bar is visible with multiple patches', async () => {
    const display = await page.$eval('#patch-tabs-bar', (el) => el.style.display);
    expect(display).not.toBe('none');
  });

  test('renders one tab per patch', async () => {
    expect((await page.$$('.patch-tab')).length).toBe(2);
  });

  test('first tab is active on load', async () => {
    const [t1, t2] = await page.$$('.patch-tab');
    expect(await t1.evaluate((el) => el.classList.contains('active'))).toBe(true);
    expect(await t2.evaluate((el) => el.classList.contains('active'))).toBe(false);
  });

  test('tab labels contain commit messages', async () => {
    const [t1, t2] = await page.$$('.patch-tab');
    expect(await t1.textContent()).toContain('feat: add hello function');
    expect(await t2.textContent()).toContain('feat: add math utilities');
  });

  test('clicking second tab makes it active', async () => {
    const [t1, t2] = await page.$$('.patch-tab');
    await t2.click();
    await page.waitForFunction(() => document.querySelectorAll('.patch-tab')[1]?.classList.contains('active'));
    expect(await t2.evaluate((el) => el.classList.contains('active'))).toBe(true);
    await t1.click();
    await page.waitForFunction(() => document.querySelectorAll('.patch-tab')[0]?.classList.contains('active'));
  });
});

// ── Sidebar (file nav) ─────────────────────────────────────────────────────

describe('sidebar', () => {
  test('file-nav is visible', async () => {
    const display = await page.$eval('#file-nav', (el) => el.style.display);
    expect(display).not.toBe('none');
  });

  test('shows "Files changed" label', async () => {
    expect(await page.textContent('.file-nav-label')).toBe('Files changed');
  });

  test('lists the file changed in the current patch', async () => {
    const items = await page.$$('.file-nav-item');
    expect(items.length).toBeGreaterThan(0);
    expect(await items[0].textContent()).toContain('feature.js');
  });

  test('collapse toggle button is present', async () => {
    expect(await page.$('.file-nav-toggle')).not.toBeNull();
  });

  test('clicking toggle collapses the sidebar', async () => {
    await page.click('.file-nav-toggle');
    await page.waitForFunction(() => document.querySelector('#file-nav')?.classList.contains('collapsed'));
    expect(await page.$eval('#file-nav', (el) => el.classList.contains('collapsed'))).toBe(true);
  });

  test('clicking toggle again expands the sidebar', async () => {
    await page.click('.file-nav-toggle');
    await page.waitForFunction(() => !document.querySelector('#file-nav')?.classList.contains('collapsed'));
    expect(await page.$eval('#file-nav', (el) => el.classList.contains('collapsed'))).toBe(false);
  });
});

// ── Diff rendering ──────────────────────────────────────────────────────────

describe('diff rendering', () => {
  test('file block is rendered with the filename', async () => {
    const text = await page.textContent('.file-header');
    expect(text).toContain('feature.js');
  });

  test('file header shows +/- stats', async () => {
    expect(await page.textContent('.file-stats .stat-add')).toMatch(/^\+\d+$/);
    expect(await page.textContent('.file-stats .stat-del')).toMatch(/^-\d+$/);
  });

  test('diff table renders added lines', async () => {
    expect((await page.$$('.line-added')).length).toBeGreaterThan(0);
  });

  test('added lines show + prefix', async () => {
    const text = await page.textContent('.line-added .ln-content');
    expect(text).toContain('+');
  });

  test('hunk header row is visible', async () => {
    const hunkHeader = await page.$('.hunk-header');
    expect(hunkHeader).not.toBeNull();
  });

  test('clicking file header collapses the diff body', async () => {
    await page.click('.file-header');
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector('.diff-body')).display === 'none'
    );
    expect(await page.$eval('.diff-body', (el) => getComputedStyle(el).display)).toBe('none');
  });

  test('clicking file header again expands the diff body', async () => {
    await page.click('.file-header');
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector('.diff-body')).display !== 'none'
    );
    expect(await page.$eval('.diff-body', (el) => getComputedStyle(el).display)).not.toBe('none');
  });
});

// ── Approve / Deny ─────────────────────────────────────────────────────────

describe('approve and deny', () => {
  test('Approve button is displayed on patch heading', async () => {
    const btn = await page.$('.btn-approve');
    expect(btn).not.toBeNull();
    expect(await btn.textContent()).toBe('Approve');
  });

  test('Deny button is displayed on patch heading', async () => {
    const btn = await page.$('.btn-deny');
    expect(btn).not.toBeNull();
    expect(await btn.textContent()).toBe('Deny');
  });

  test('clicking Approve changes button to "Approved ✓" and enables submit', async () => {
    await page.click('.btn-approve');
    await page.waitForSelector('.btn-unapprove');
    expect(await page.textContent('.btn-unapprove')).toBe('Approved ✓');
    expect(await page.$eval('#btn-submit', (el) => el.disabled)).toBe(false);
  });

  test('approved patch tab gets approved class', async () => {
    const tab = (await page.$$('.patch-tab'))[0];
    expect(await tab.evaluate((el) => el.classList.contains('approved'))).toBe(true);
  });

  test('clicking "Approved ✓" un-approves the patch', async () => {
    await page.click('.btn-unapprove');
    await page.waitForSelector('.btn-approve');
    expect(await page.textContent('.btn-approve')).toBe('Approve');
  });

  test('clicking Deny changes button to "Denied ✗"', async () => {
    await page.click('.btn-deny');
    await page.waitForSelector('.btn-undeny');
    expect(await page.textContent('.btn-undeny')).toBe('Denied ✗');
  });

  test('deny notice appears below the general comment box', async () => {
    expect(await page.$('.deny-notice')).not.toBeNull();
  });

  test('clicking "Denied ✗" un-denies and removes deny notice', async () => {
    await page.click('.btn-undeny');
    await page.waitForSelector('.btn-deny');
    expect(await page.textContent('.btn-deny')).toBe('Deny');
    expect(await page.$('.deny-notice')).toBeNull();
  });
});

// ── Commit message section ──────────────────────────────────────────────────

describe('commit message section', () => {
  test('commit message block is rendered', async () => {
    expect(await page.$('.commit-msg-block')).not.toBeNull();
  });

  test('commit message subject matches the patch commit', async () => {
    expect(await page.textContent('.commit-msg-subject')).toContain('feat: add hello function');
  });

  test('clicking commit subject opens a comment form', async () => {
    await page.click('.commit-msg-subject');
    await page.waitForSelector('.comment-form-inner');
    expect(await page.$('.comment-form-inner')).not.toBeNull();
  });

  test('comment form has Cancel, Discard draft, and Save comment buttons', async () => {
    expect(await page.$('.btn-cancel')).not.toBeNull();
    expect(await page.$('.btn-discard')).not.toBeNull();
    expect(await page.$('.btn-save')).not.toBeNull();
  });

  test('Cancel button closes the form', async () => {
    await page.click('.btn-cancel');
    await page.waitForFunction(() => !document.querySelector('.comment-form-inner'));
    expect(await page.$('.comment-form-inner')).toBeNull();
  });

  test('saving a commit message comment shows comment display', async () => {
    await page.click('.commit-msg-subject');
    await page.waitForSelector('.comment-form-inner textarea');
    await page.fill('.comment-form-inner textarea', 'Commit message needs a bug link.');
    await page.click('.btn-save');
    await page.waitForSelector('.comment-display-row');
    expect(await page.textContent('.comment-body')).toBe('Commit message needs a bug link.');
  });

  test('commit comment enables submit button', async () => {
    expect(await page.$eval('#btn-submit', (el) => el.disabled)).toBe(false);
  });

  test('deleting the commit comment removes it', async () => {
    await page.click('.btn-delete-comment');
    await page.waitForFunction(() => !document.querySelector('.comment-display-row'));
    expect(await page.$('.comment-display-row')).toBeNull();
  });
});

// ── Inline line comments ───────────────────────────────────────────────────

describe('inline line comments', () => {
  test('clicking a diff line opens the comment form', async () => {
    await page.click('.line-added .ln-content');
    await page.waitForSelector('.comment-form-row');
    expect(await page.$('.comment-form-row')).not.toBeNull();
  });

  test('comment form textarea receives focus', async () => {
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  });

  test('Cancel button closes the inline form', async () => {
    await page.click('.btn-cancel');
    await page.waitForFunction(() => !document.querySelector('.comment-form-row'));
    expect(await page.$('.comment-form-row')).toBeNull();
  });

  test('typing and saving a comment shows comment display', async () => {
    await page.click('.line-added .ln-content');
    await page.waitForSelector('.comment-form-row textarea');
    await page.fill('.comment-form-row textarea', 'This line needs a test.');
    await page.click('.btn-save');
    await page.waitForSelector('.comment-display-row');
    expect(await page.textContent('.comment-body')).toBe('This line needs a test.');
  });

  test('saved comment enables the submit button', async () => {
    expect(await page.$eval('#btn-submit', (el) => el.disabled)).toBe(false);
  });

  test('clicking × deletes the comment', async () => {
    await page.click('.btn-delete-comment');
    await page.waitForFunction(() => !document.querySelector('.comment-display-row'));
    expect(await page.$('.comment-display-row')).toBeNull();
  });
});

// ── Tab rendering stability ────────────────────────────────────────────────
// Verifies the anti-flicker fix: renderTabs() reuses existing tab DOM elements
// rather than destroying and recreating them, so tabs don't flash on state changes.

describe('tab rendering stability', () => {
  test('tab DOM elements survive tab switches', async () => {
    await page.evaluate(() => { document.querySelector('.patch-tab').__stable = true; });
    const tabs = await page.$$('.patch-tab');
    await tabs[1].click();
    await page.waitForFunction(() => document.querySelectorAll('.patch-tab')[1].classList.contains('active'));
    await tabs[0].click();
    await page.waitForFunction(() => document.querySelectorAll('.patch-tab')[0].classList.contains('active'));
    expect(await page.evaluate(() => document.querySelector('.patch-tab').__stable)).toBe(true);
  });

  test('tab DOM elements survive renderTabs calls during approve/unapprove', async () => {
    await page.evaluate(() => {
      document.querySelectorAll('.patch-tab').forEach((btn, i) => { btn.__idx = i; });
    });
    await page.click('.btn-approve');
    await page.waitForSelector('.btn-unapprove');
    await page.click('.btn-unapprove');
    await page.waitForSelector('.btn-approve');
    const idxs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.patch-tab')).map((btn) => btn.__idx)
    );
    expect(idxs).toEqual([0, 1]);
  });
});

// ── General feedback textarea ──────────────────────────────────────────────
// Uses a fresh page so submit-button state starts clean (no prior approvals/comments).

describe('general feedback', () => {
  let cleanPage;

  beforeAll(async () => { cleanPage = await openFreshPage(); }, 15000);
  afterAll(async () => { await cleanPage.close(); });

  test('general comment textarea is visible', async () => {
    const ta = await cleanPage.$('.general-comment-textarea');
    expect(ta).not.toBeNull();
    expect(await ta.evaluate((el) => getComputedStyle(el).display)).not.toBe('none');
  });

  test('typing in general comment enables submit', async () => {
    await cleanPage.fill('.general-comment-textarea', 'Overall this looks risky.');
    await cleanPage.waitForFunction(() => !document.querySelector('#btn-submit').disabled);
    expect(await cleanPage.$eval('#btn-submit', (el) => el.disabled)).toBe(false);
  });

  test('clearing general comment (only activity) disables submit', async () => {
    await cleanPage.fill('.general-comment-textarea', '');
    await cleanPage.dispatchEvent('.general-comment-textarea', 'input');
    await cleanPage.waitForFunction(() => document.querySelector('#btn-submit').disabled);
    expect(await cleanPage.$eval('#btn-submit', (el) => el.disabled)).toBe(true);
  });
});

// ── Expand context ─────────────────────────────────────────────────────────
// Uses a fresh page so the diff DOM is in its initial state (not rebuilt by
// approve/deny/comment cycles which call renderCurrentPatch multiple times).

describe('expand context', () => {
  let expandPage;

  beforeAll(async () => { expandPage = await openFreshPage(); }, 15000);
  afterAll(async () => { await expandPage.close(); });

  test('expand-context row is present in the diff', async () => {
    expect(await expandPage.$('.expand-context-row')).not.toBeNull();
  });

  test('expand button renders with a line count label', async () => {
    const btn = await expandPage.$('.btn-exp');
    expect(btn).not.toBeNull();
    expect(await btn.textContent()).toMatch(/Lines?/);
  });

  test('the bottom expand button has data-action="down"', async () => {
    // feature.js is a new 5-line file; the only expand row is at the bottom
    expect(await expandPage.$eval('.btn-exp', (el) => el.getAttribute('data-action'))).toBe('down');
  });

  test('clicking expand fires /api/filecontext and server returns empty lines past EOF', async () => {
    // Register the listener before the click so the response isn't missed.
    const responsePromise = expandPage.waitForResponse(
      (r) => r.url().includes('/api/filecontext'),
      { timeout: 8000 }
    );
    await expandPage.$eval('.btn-exp', (el) => el.click());
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const body = await response.json();
    // feature.js has 5 lines; curStart=6 is past EOF → server returns empty lines
    expect(body.lines).toHaveLength(0);
    expect(body.totalLines).toBe(5);
  });
});

// ── Expand context — larger file ───────────────────────────────────────────
// A 50-line file modified at line 25 gives two expand rows with a large gap:
//   Top:    lines 1–21 hidden (count=21 > 20) → "↑ 20 Lines" (data-action="up")
//   Bottom: lines 29–50 hidden (unknown end)  → "↓ 20 Lines" (data-action="down")
// This exercises the up button, the down button, the small (↕) button that
// appears after partial expansion, and full gap closure (row removal).

describe('expand context — larger file', () => {
  let richServer, richPage, richTmpDir;

  // Click the first expand button and wait for new context lines to appear.
  // Returns the number of .line-context rows added.
  async function clickFirstExpand() {
    const before = (await richPage.$$('.line-context')).length;
    const responsePromise = richPage.waitForResponse((r) => r.url().includes('/api/filecontext'));
    await (await richPage.$$('.expand-context-row'))[0].$eval('.btn-exp', (el) => el.click());
    await responsePromise;
    await richPage.waitForFunction((n) => document.querySelectorAll('.line-context').length > n, before);
    return (await richPage.$$('.line-context')).length - before;
  }

  beforeAll(async () => {
    richTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-ui-rich-'));
    const richMain = path.join(richTmpDir, 'main');
    const richWork = path.join(richTmpDir, 'work');

    fs.mkdirSync(richMain);
    git(richMain, 'init');
    git(richMain, 'config user.email "test@test.com"');
    git(richMain, 'config user.name "Test"');

    const lines = Array.from({ length: 50 }, (_, i) => `const L${i + 1} = ${i + 1};`);
    fs.writeFileSync(path.join(richMain, 'large.js'), lines.join('\n') + '\n');
    git(richMain, 'add .');
    git(richMain, 'commit -m "initial"');

    execSync(`git clone "${richMain}" "${richWork}"`, { encoding: 'utf8' });
    git(richWork, 'config user.email "test@test.com"');
    git(richWork, 'config user.name "Test"');

    lines[24] = `const L25 = 'modified';`;
    fs.writeFileSync(path.join(richWork, 'large.js'), lines.join('\n') + '\n');
    git(richWork, 'add .');
    git(richWork, 'commit -m "feat: modify line 25"');

    const app = createApp({ worktreeName: 'work', worktreePath: richWork, mainRepoPath: richMain });
    const port = await findAvailablePort(19500);
    await new Promise((resolve) => { richServer = app.listen(port, '127.0.0.1', resolve); });

    richPage = await browser.newPage();
    await richPage.goto(`http://127.0.0.1:${port}`);
    await richPage.waitForSelector('.patch-heading', { state: 'visible' });
  }, 30000);

  afterAll(async () => {
    await richPage?.close();
    await new Promise((resolve) => richServer?.close(resolve));
    fs.rmSync(richTmpDir, { recursive: true, force: true });
  });

  test('two expand-context rows are present (top and bottom)', async () => {
    expect((await richPage.$$('.expand-context-row')).length).toBe(2);
  });

  test('top expand button shows "↑ 20 Lines" with data-action="up"', async () => {
    const topBtn = await (await richPage.$$('.expand-context-row'))[0].$('.btn-exp');
    expect(await topBtn.textContent()).toBe('↑ 20 Lines');
    expect(await topBtn.getAttribute('data-action')).toBe('up');
  });

  test('bottom expand button shows "↓ 20 Lines" with data-action="down"', async () => {
    const bottomBtn = await (await richPage.$$('.expand-context-row'))[1].$('.btn-exp');
    expect(await bottomBtn.textContent()).toBe('↓ 20 Lines');
    expect(await bottomBtn.getAttribute('data-action')).toBe('down');
  });

  test('clicking "↑ 20 Lines" loads 20 context lines and button updates to "↕ 1 Line"', async () => {
    expect(await clickFirstExpand()).toBe(20);
    const topText = await (await richPage.$$('.expand-context-row'))[0].textContent();
    expect(topText).toContain('↕ 1 Line');
  });

  test('clicking "↕ 1 Line" loads the last line and removes the top expand row', async () => {
    expect(await clickFirstExpand()).toBe(1);
    await richPage.waitForFunction(() => document.querySelectorAll('.expand-context-row').length === 1);
  });

  test('clicking "↓ 20 Lines" loads 20 context lines and button updates to "↕ 2 Lines"', async () => {
    expect(await clickFirstExpand()).toBe(20);
    expect(await (await richPage.$('.expand-context-row')).textContent()).toContain('↕ 2 Lines');
  });

  test('clicking "↕ 2 Lines" loads last 2 lines and removes all expand rows', async () => {
    expect(await clickFirstExpand()).toBe(2);
    await richPage.waitForFunction(() => document.querySelectorAll('.expand-context-row').length === 0);
  });
});

// ── Sidebar file highlight ─────────────────────────────────────────────────
// A single patch that touches two files gives a sidebar with two nav items.
// Clicking the second item must immediately update the active highlight even
// when no scroll occurs (both blocks may already be in the viewport).

describe('sidebar file highlight', () => {
  let navServer, navPage, navTmpDir;

  beforeAll(async () => {
    navTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-ui-nav-'));
    const navMain = path.join(navTmpDir, 'main');
    const navWork = path.join(navTmpDir, 'work');

    fs.mkdirSync(navMain);
    git(navMain, 'init');
    git(navMain, 'config user.email "test@test.com"');
    git(navMain, 'config user.name "Test"');
    fs.writeFileSync(path.join(navMain, 'alpha.js'), 'const a = 1;\n');
    fs.writeFileSync(path.join(navMain, 'beta.js'), 'const b = 2;\n');
    git(navMain, 'add .');
    git(navMain, 'commit -m "initial"');

    execSync(`git clone "${navMain}" "${navWork}"`, { encoding: 'utf8' });
    git(navWork, 'config user.email "test@test.com"');
    git(navWork, 'config user.name "Test"');
    fs.writeFileSync(path.join(navWork, 'alpha.js'), 'const a = 10;\n');
    fs.writeFileSync(path.join(navWork, 'beta.js'), 'const b = 20;\n');
    git(navWork, 'add .');
    git(navWork, 'commit -m "feat: update both files"');

    const app = createApp({ worktreeName: 'work', worktreePath: navWork, mainRepoPath: navMain });
    const port = await findAvailablePort(19600);
    await new Promise((resolve) => { navServer = app.listen(port, '127.0.0.1', resolve); });

    navPage = await browser.newPage();
    await navPage.goto(`http://127.0.0.1:${port}`);
    await navPage.waitForSelector('.file-nav-item', { state: 'visible' });
  }, 30000);

  afterAll(async () => {
    await navPage?.close();
    await new Promise((resolve) => navServer?.close(resolve));
    fs.rmSync(navTmpDir, { recursive: true, force: true });
  });

  test('sidebar shows two file nav items', async () => {
    expect((await navPage.$$('.file-nav-item')).length).toBe(2);
  });

  test('first item is active on load', async () => {
    const items = await navPage.$$('.file-nav-item');
    expect(await items[0].evaluate((el) => el.classList.contains('active'))).toBe(true);
    expect(await items[1].evaluate((el) => el.classList.contains('active'))).toBe(false);
  });

  test('clicking second item immediately updates the active highlight', async () => {
    const items = await navPage.$$('.file-nav-item');
    await items[1].click();
    await navPage.waitForFunction(
      () => document.querySelectorAll('.file-nav-item')[1].classList.contains('active')
    );
    expect(await items[1].evaluate((el) => el.classList.contains('active'))).toBe(true);
    expect(await items[0].evaluate((el) => el.classList.contains('active'))).toBe(false);
  });

  test('clicking first item restores the first item as active', async () => {
    const items = await navPage.$$('.file-nav-item');
    await items[0].click();
    await navPage.waitForFunction(
      () => document.querySelectorAll('.file-nav-item')[0].classList.contains('active')
    );
    expect(await items[0].evaluate((el) => el.classList.contains('active'))).toBe(true);
    expect(await items[1].evaluate((el) => el.classList.contains('active'))).toBe(false);
  });
});

// ── Revue title link ───────────────────────────────────────────────────────

describe('Revue title link', () => {
  test('title link text is "Revue"', async () => {
    expect(await page.textContent('h1 .app-name')).toBe('Revue');
  });

  test('title link opens in a new tab', async () => {
    expect(await page.$eval('h1 .app-name', (el) => el.target)).toBe('_blank');
  });

  test('worktree-path shows the worktree directory name', async () => {
    expect(await page.textContent('#worktree-path')).toContain('work-repo');
  });
});

// ── File path format ───────────────────────────────────────────────────────

describe('file path format in sidebar and diff', () => {
  test('sidebar file item shows the filename', async () => {
    expect(await page.textContent('.file-nav-item')).toContain('feature.js');
  });

  test('diff file header shows the file path', async () => {
    expect(await page.textContent('.file-header')).toContain('feature.js');
  });

  test('sidebar dir label is absent for root-level files', async () => {
    // feature.js is at repo root — no directory prefix shown
    expect(await page.$('.file-nav-dir')).toBeNull();
  });
});

// ── Generate review prompt button ─────────────────────────────────────────

describe('generate review prompt button', () => {
  let promptPage;

  beforeAll(async () => { promptPage = await openFreshPage(); }, 15000);
  afterAll(async () => { await promptPage.close(); });

  test('button label is "Generate Review Prompt"', async () => {
    expect(await promptPage.textContent('#btn-submit')).toBe('Generate Review Prompt');
  });

  test('button is disabled and warning is visible before any feedback', async () => {
    expect(await promptPage.$eval('#btn-submit', (el) => el.disabled)).toBe(true);
    expect((await promptPage.textContent('#submit-warning')).trim().length).toBeGreaterThan(0);
  });

  test('approving a patch enables the button', async () => {
    await promptPage.click('.btn-approve');
    await promptPage.waitForSelector('.btn-unapprove');
    expect(await promptPage.$eval('#btn-submit', (el) => el.disabled)).toBe(false);
  });

  test('clicking the button fires POST /api/submit', async () => {
    const requestPromise = promptPage.waitForRequest(
      (req) => req.url().includes('/api/submit') && req.method() === 'POST'
    );
    await promptPage.click('#btn-submit');
    const req = await requestPromise;
    expect(Array.isArray(JSON.parse(req.postData()).allFeedback)).toBe(true);
  });
});

// ── Update banner ──────────────────────────────────────────────────────────
// Uses route interception: the first /api/headhash response is real (sets
// knownHash), subsequent ones return a fake different hash to trigger the banner.

describe('update banner', () => {
  let bannerPage;

  beforeAll(async () => {
    bannerPage = await browser.newPage();
    let firstCall = true;
    await bannerPage.route('**/api/headhash', (route) => {
      if (firstCall) {
        firstCall = false;
        route.continue();
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hash: 'aabbccdd00000000' }) });
      }
    });
    await bannerPage.goto(baseUrl);
    await bannerPage.waitForSelector('.patch-heading', { state: 'visible' });
  }, 15000);

  afterAll(async () => { await bannerPage?.close(); });

  test('banner is hidden on initial load', async () => {
    expect(await bannerPage.$eval('#update-banner', (el) => el.style.display)).toBe('none');
  });

  test('banner appears when HEAD hash changes', async () => {
    await bannerPage.waitForFunction(
      () => document.getElementById('update-banner').style.display !== 'none',
      { timeout: 10000 }
    );
    expect(await bannerPage.textContent('#update-banner')).toContain('Codebase updated');
  });

  test('banner contains a Reload button', async () => {
    expect(await bannerPage.textContent('#btn-reload-page')).toBe('Reload');
  });

  test('clicking Reload button hides the banner and re-renders', async () => {
    await bannerPage.click('#btn-reload-page');
    await bannerPage.waitForFunction(
      () => document.getElementById('update-banner').style.display === 'none',
      { timeout: 5000 }
    );
    expect(await bannerPage.$eval('#update-banner', (el) => el.style.display)).toBe('none');
    // Content was re-rendered — patches are still visible
    expect(await bannerPage.$('.patch-heading')).not.toBeNull();
  });
});

// ── Approved status preserved despite pending auto-save on reload ──────────
// loadAndRender() cancels the pending save timer before resetting state.
// Without the cancel, a save scheduled by the last approve/deny fires during
// loadAndRender's fetch await, writes cleared state (approved:[]) to the
// server, and the reload loads back that empty list — losing the approval.

describe('approved status preserved after reload (pending auto-save race)', () => {
  let racePage;

  beforeAll(async () => {
    racePage = await openFreshPage();
    // Start from a known-clean state
    await racePage.request.post(`${baseUrl}/api/state`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ comments: {}, generalComments: {}, approved: [], denied: [], revisions: [] }),
    });
    await racePage.evaluate(() => { document.getElementById('update-banner').style.display = ''; });
    await racePage.click('#btn-reload-page');
    await racePage.waitForSelector('.patch-heading', { state: 'visible' });
    // Let the baseline auto-save settle before the test begins
    await racePage.waitForTimeout(600);
  }, 15000);

  afterAll(async () => {
    // Reset server state so subsequent tests start clean
    if (racePage) {
      await racePage.request.post(`${baseUrl}/api/state`, {
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ comments: {}, generalComments: {}, approved: [], denied: [], revisions: [] }),
      });
      await racePage.close();
    }
  });

  test('pending auto-save is cancelled before state reset so server state is not corrupted', async () => {
    // Approve the patch and wait for the auto-save to persist it to the server
    await racePage.click('.btn-approve');
    await racePage.waitForSelector('.btn-unapprove', { timeout: 3000 });
    await racePage.waitForTimeout(600); // 500ms debounce + 100ms margin → server has approved:[hash]

    // Arm a route intercept that holds the next GET /api/state.  This stretches
    // the race window: the reload fetch stalls while the pending save timer can fire.
    let releaseGet;
    let holdNextGet = false;
    await racePage.route('**/api/state', async (route, request) => {
      if (request.method() === 'POST') {
        await route.continue();
      } else if (holdNextGet) {
        holdNextGet = false;
        await new Promise((res) => { releaseGet = res; });
        await route.continue();
      } else {
        await route.continue();
      }
    });

    try {
      // Deny the patch to queue a new pending auto-save (fires 500ms from now).
      // The server still has approved:[hash] from the save above.
      await racePage.click('.btn-deny');

      // Arm the hold and trigger reload within 500ms of the deny — before the
      // save timer fires.  Without the clearTimeout fix, the timer fires during
      // the held GET with cleared state (approved:[], denied:[]) and corrupts
      // the server's state file before the GET resolves.
      holdNextGet = true;
      await racePage.evaluate(() => { document.getElementById('update-banner').style.display = ''; });
      await racePage.click('#btn-reload-page');

      // Pause 600ms (500ms debounce + 100ms margin) so the save timer fires while the GET is held
      await racePage.waitForTimeout(600);

      // Release the GET — loadAndRender can now finish loading
      releaseGet?.();
      await racePage.waitForSelector('.patch-heading', { state: 'visible' });
      await racePage.waitForTimeout(200);

      // The server's approved list should still be intact (from the save before
      // the deny).  Without the fix the corrupt save overwrites it with [] and
      // the patch no longer shows as approved.
      expect(await racePage.$('.btn-unapprove')).not.toBeNull();
    } finally {
      await racePage.unroute('**/api/state');
    }
  });
});

// ── Result overlay ─────────────────────────────────────────────────────────
// Submitting with all patches approved fires POST /api/submit, which writes
// REVIEW_FEEDBACK_*.md and triggers the result overlay with the prompt text.

describe('result overlay', () => {
  let overlayPage;

  beforeAll(async () => {
    overlayPage = await openFreshPage();
    // Fill a general comment — works regardless of prior approval state loaded from server
    await overlayPage.fill('.general-comment-textarea', 'Looks good overall.');
    await overlayPage.waitForFunction(
      () => !document.querySelector('#btn-submit').disabled,
      { timeout: 5000 }
    );
    await overlayPage.click('#btn-submit');
    await overlayPage.waitForFunction(
      () => document.getElementById('result-overlay')?.classList.contains('visible'),
      { timeout: 15000 }
    );
  }, 60000);

  afterAll(async () => {
    await overlayPage?.close();
    try { fs.unlinkSync(path.join(workRepoPath, 'REVIEW_FEEDBACK_work-repo.md')); } catch {}
  });

  test('overlay becomes visible after successful submit', async () => {
    expect(
      await overlayPage.$eval('#result-overlay', (el) => el.classList.contains('visible'))
    ).toBe(true);
  });

  test('overlay shows the feedback file path', async () => {
    const feedbackPath = await overlayPage.textContent('#result-feedback-path');
    expect(feedbackPath.length).toBeGreaterThan(0);
    expect(feedbackPath).toContain('REVIEW_FEEDBACK');
  });

  test('overlay shows the review prompt text', async () => {
    const prompt = await overlayPage.$eval('#result-prompt', (el) => el.value);
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('worktree');
  });

  test('clicking Close hides the overlay', async () => {
    await overlayPage.click('#btn-close-modal');
    await overlayPage.waitForFunction(
      () => !document.getElementById('result-overlay').classList.contains('visible')
    );
    expect(
      await overlayPage.$eval('#result-overlay', (el) => el.classList.contains('visible'))
    ).toBe(false);
  });
});

// ── State cleared after successful submit ──────────────────────────────────
// After submitReview() succeeds, comments/approvals are cleared in-memory and
// persisted so a subsequent reload starts fresh.

describe('state cleared after submit', () => {
  let clearStatePage;

  beforeAll(async () => {
    clearStatePage = await openFreshPage();
    await clearStatePage.fill('.general-comment-textarea', 'Clean slate test comment.');
    await clearStatePage.waitForFunction(() => !document.querySelector('#btn-submit').disabled, { timeout: 5000 });
    await clearStatePage.click('#btn-submit');
    await clearStatePage.waitForFunction(
      () => document.getElementById('result-overlay')?.classList.contains('visible'),
      { timeout: 15000 }
    );
    // Close overlay so UI is fully settled
    await clearStatePage.click('#btn-close-modal');
    await clearStatePage.waitForFunction(
      () => !document.getElementById('result-overlay').classList.contains('visible')
    );
  }, 60000);

  afterAll(async () => {
    await clearStatePage?.close();
    try { fs.unlinkSync(path.join(workRepoPath, 'REVIEW_FEEDBACK_work-repo.md')); } catch {}
  });

  test('general comment textarea is empty after submit', async () => {
    const value = await clearStatePage.$eval('.general-comment-textarea', (el) => el.value);
    expect(value).toBe('');
  });

  test('submit button is disabled after submit (no remaining activity)', async () => {
    expect(await clearStatePage.$eval('#btn-submit', (el) => el.disabled)).toBe(true);
  });
});

// ── Nested file path in sidebar ────────────────────────────────────────────
// A commit touching src/helper.js should show a .file-nav-dir label in the
// sidebar with the directory prefix, and .file-nav-filename with just the
// basename.

describe('nested file path in sidebar', () => {
  let nestedServer, nestedPage, nestedTmpDir;

  beforeAll(async () => {
    nestedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-ui-nested-'));
    const nestedMain = path.join(nestedTmpDir, 'main');
    const nestedWork = path.join(nestedTmpDir, 'work');

    fs.mkdirSync(nestedMain);
    git(nestedMain, 'init');
    git(nestedMain, 'config user.email "test@test.com"');
    git(nestedMain, 'config user.name "Test"');
    fs.mkdirSync(path.join(nestedMain, 'src'));
    fs.writeFileSync(path.join(nestedMain, 'src', 'helper.js'), 'const x = 1;\n');
    git(nestedMain, 'add .');
    git(nestedMain, 'commit -m "initial"');

    execSync(`git clone "${nestedMain}" "${nestedWork}"`, { encoding: 'utf8' });
    git(nestedWork, 'config user.email "test@test.com"');
    git(nestedWork, 'config user.name "Test"');
    fs.writeFileSync(path.join(nestedWork, 'src', 'helper.js'), 'const x = 2;\n');
    git(nestedWork, 'add .');
    git(nestedWork, 'commit -m "feat: update helper"');

    const app = createApp({ worktreeName: 'work', worktreePath: nestedWork, mainRepoPath: nestedMain });
    const port = await findAvailablePort(19700);
    await new Promise((resolve) => { nestedServer = app.listen(port, '127.0.0.1', resolve); });

    nestedPage = await browser.newPage();
    await nestedPage.goto(`http://127.0.0.1:${port}`);
    await nestedPage.waitForSelector('.file-nav-item', { state: 'visible' });
  }, 30000);

  afterAll(async () => {
    await nestedPage?.close();
    await new Promise((resolve) => nestedServer?.close(resolve));
    fs.rmSync(nestedTmpDir, { recursive: true, force: true });
  });

  test('sidebar shows directory prefix in file-nav-dir label', async () => {
    expect(await nestedPage.$('.file-nav-dir')).not.toBeNull();
    expect(await nestedPage.textContent('.file-nav-dir')).toContain('src/');
  });

  test('sidebar shows only the filename in file-nav-filename', async () => {
    expect(await nestedPage.textContent('.file-nav-filename')).toBe('helper.js');
  });
});

// ── Worktree switcher bar ──────────────────────────────────────────────────
// A real git worktree (via `git worktree add`) means /api/worktrees returns
// two entries, so initWorktreeBar shows #worktree-bar with one pill per entry.

describe('worktree switcher bar', () => {
  let wtBarServer, wtBarPage, wtBarTmpDir, wtBarPort;
  const mainRepoName = 'main-repo';

  beforeAll(async () => {
    wtBarTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-ui-wtbar-'));
    const wtBarMain = path.join(wtBarTmpDir, mainRepoName);
    const wtBarWork = path.join(wtBarTmpDir, `${mainRepoName}-feature`);

    fs.mkdirSync(wtBarMain);
    git(wtBarMain, 'init');
    git(wtBarMain, 'config user.email "test@test.com"');
    git(wtBarMain, 'config user.name "Test"');
    fs.writeFileSync(path.join(wtBarMain, 'base.txt'), 'base\n');
    git(wtBarMain, 'add .');
    git(wtBarMain, 'commit -m "initial"');

    // Create a real linked worktree and add a commit so patches are visible
    git(wtBarMain, `worktree add -b feature "${wtBarWork}"`);
    fs.writeFileSync(path.join(wtBarWork, 'patch.js'), 'const x = 1;\n');
    git(wtBarWork, 'add .');
    git(wtBarWork, 'commit -m "feat: add patch"');

    const app = createApp({
      worktreeName: 'feature',
      worktreePath: wtBarWork,
      mainRepoPath: wtBarMain,
    });
    wtBarPort = await findAvailablePort(19800);
    await new Promise((resolve) => { wtBarServer = app.listen(wtBarPort, '127.0.0.1', resolve); });

    wtBarPage = await browser.newPage();
    await wtBarPage.goto(`http://127.0.0.1:${wtBarPort}`);
    await wtBarPage.waitForSelector('.patch-heading', { state: 'visible' });
  }, 30000);

  afterAll(async () => {
    await wtBarPage?.close();
    await new Promise((resolve) => wtBarServer?.close(resolve));
    fs.rmSync(wtBarTmpDir, { recursive: true, force: true });
  });

  test('worktree bar is visible when multiple worktrees exist', async () => {
    expect(await wtBarPage.$eval('#worktree-bar', (el) => el.style.display)).not.toBe('none');
  });

  test('renders one pill per worktree entry', async () => {
    const pills = await wtBarPage.$$('.worktree-pill');
    expect(pills.length).toBe(2); // main repo + feature worktree
  });

  test('active pill corresponds to the current worktree', async () => {
    const activePill = await wtBarPage.$('.worktree-pill.active');
    expect(activePill).not.toBeNull();
    expect(await activePill.getAttribute('data-name')).toBe('feature');
  });

  test('clicking an inactive pill fires POST /api/switch and makes it active', async () => {
    const switchReqPromise = wtBarPage.waitForRequest(
      (req) => req.url().includes('/api/switch') && req.method() === 'POST'
    );
    // Click the first pill (main repo — not active)
    const pills = await wtBarPage.$$('.worktree-pill');
    await pills[0].click();
    const req = await switchReqPromise;
    expect(JSON.parse(req.postData()).worktreeName).toBe(mainRepoName);
    await wtBarPage.waitForFunction(
      () => document.querySelector('.worktree-pill')?.classList.contains('active'),
      { timeout: 5000 }
    );
  });

  test('URL hash updates to reflect the active worktree after pill click', async () => {
    // history.replaceState is called asynchronously after the switch response resolves
    await wtBarPage.waitForFunction(
      (name) => window.location.hash === '#' + name,
      mainRepoName,
      { timeout: 5000 }
    );
    expect(wtBarPage.url()).toContain('#' + mainRepoName);
  });
});

// ── Error state ────────────────────────────────────────────────────────────
// When /api/diff returns a 500, loadAndRender must show #error-msg and hide
// #loading.  Verified via Playwright route interception.

describe('error state', () => {
  let errPage;

  beforeAll(async () => {
    errPage = await browser.newPage();
    await errPage.route('**/api/diff', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'git exploded' }),
      })
    );
    await errPage.goto(baseUrl);
    await errPage.waitForFunction(
      () => document.getElementById('error-msg').style.display !== 'none',
      { timeout: 5000 }
    );
  }, 15000);

  afterAll(async () => { await errPage?.close(); });

  test('error message element is visible', async () => {
    expect(await errPage.$eval('#error-msg', (el) => el.style.display)).not.toBe('none');
  });

  test('error message contains the server error text', async () => {
    expect(await errPage.textContent('#error-msg')).toContain('git exploded');
  });

  test('loading indicator is hidden after error', async () => {
    expect(await errPage.$eval('#loading', (el) => el.style.display)).toBe('none');
  });
});

// ── Submit error state ─────────────────────────────────────────────────────
// When POST /api/submit returns a server error the catch block in
// submitReview() must surface the message in #submit-warning and re-enable
// the button.  Verified via Playwright route interception.

describe('submit error state', () => {
  let errSubmitPage;

  beforeAll(async () => {
    errSubmitPage = await browser.newPage();
    await errSubmitPage.route('**/api/submit', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'disk write failed' }),
      })
    );
    await errSubmitPage.goto(baseUrl);
    await errSubmitPage.waitForSelector('.patch-heading', { state: 'visible' });
    // Enable submit if not already enabled — works regardless of state loaded from disk.
    // If previous tests saved approved state, the button is already enabled; skip approve.
    const isDisabled = await errSubmitPage.$eval('#btn-submit', (el) => el.disabled);
    if (isDisabled) {
      await errSubmitPage.click('.btn-approve');
      await errSubmitPage.waitForSelector('.btn-unapprove');
    }
    await errSubmitPage.click('#btn-submit');
    await errSubmitPage.waitForFunction(
      () => document.getElementById('submit-warning').textContent.includes('Error'),
      { timeout: 5000 }
    );
  }, 30000);

  afterAll(async () => { await errSubmitPage?.close(); });

  test('submit warning shows the server error message', async () => {
    expect(await errSubmitPage.textContent('#submit-warning')).toContain('disk write failed');
  });

  test('submit button is re-enabled after a failed submit', async () => {
    expect(await errSubmitPage.$eval('#btn-submit', (el) => el.disabled)).toBe(false);
  });
});

// ── Empty worktree display ─────────────────────────────────────────────────
// When a worktree has no commits ahead of main, the UI must show the
// .empty-worktree "No changes" element instead of patch tabs or diff content.

describe('empty worktree shows "No changes" state', () => {
  let emptyServer, emptyPage, emptyTmpDir;

  beforeAll(async () => {
    emptyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-ui-empty-'));
    const emptyMain = path.join(emptyTmpDir, 'main-repo');
    const emptyWork = path.join(emptyTmpDir, 'work-repo');

    fs.mkdirSync(emptyMain);
    git(emptyMain, 'init');
    git(emptyMain, 'config user.email "test@test.com"');
    git(emptyMain, 'config user.name "Test"');
    fs.writeFileSync(path.join(emptyMain, 'base.txt'), 'base\n');
    git(emptyMain, 'add .');
    git(emptyMain, 'commit -m "initial"');

    // Clone so origin/main exists — work repo has no commits ahead of main
    execSync(`git clone "${emptyMain}" "${emptyWork}"`, { encoding: 'utf8' });
    git(emptyWork, 'config user.email "test@test.com"');
    git(emptyWork, 'config user.name "Test"');

    const app = createApp({ worktreeName: 'work-repo', worktreePath: emptyWork, mainRepoPath: emptyMain });
    const port = await findAvailablePort(19620);
    await new Promise((resolve) => { emptyServer = app.listen(port, '127.0.0.1', resolve); });

    emptyPage = await browser.newPage();
    await emptyPage.goto(`http://127.0.0.1:${port}`);
    // Wait for the app to finish loading (loading spinner disappears)
    await emptyPage.waitForFunction(
      () => document.getElementById('loading').style.display === 'none',
      { timeout: 10000 }
    );
  }, 30000);

  afterAll(async () => {
    await emptyPage?.close();
    await new Promise((resolve) => emptyServer?.close(resolve));
    fs.rmSync(emptyTmpDir, { recursive: true, force: true });
  });

  test('shows .empty-worktree element with "No changes" text', async () => {
    const el = await emptyPage.$('.empty-worktree');
    expect(el).not.toBeNull();
    expect(await emptyPage.textContent('.empty-worktree-title')).toBe('No changes');
  });

  test('patch tabs bar is hidden when there are no patches', async () => {
    expect(await emptyPage.$eval('#patch-tabs-bar', (el) => el.style.display)).toBe('none');
  });

  test('submit button is disabled when there is nothing to review', async () => {
    expect(await emptyPage.$eval('#btn-submit', (el) => el.disabled)).toBe(true);
  });
});

// ── URL hash navigation ────────────────────────────────────────────────────
// When the page is loaded with #<worktreeName> in the URL, initWorktreeBar
// must POST /api/switch to that worktree and render its patches.

describe('URL hash navigates to the named worktree on load', () => {
  let hashServer, hashPage, hashTmpDir, hashPort;
  const mainName = 'hash-main';

  beforeAll(async () => {
    hashTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-ui-hash-'));
    const hashMain = path.join(hashTmpDir, mainName);
    const hashWork = path.join(hashTmpDir, `${mainName}-feature`);

    fs.mkdirSync(hashMain);
    git(hashMain, 'init');
    git(hashMain, 'config user.email "test@test.com"');
    git(hashMain, 'config user.name "Test"');
    fs.writeFileSync(path.join(hashMain, 'base.txt'), 'base\n');
    git(hashMain, 'add .');
    git(hashMain, 'commit -m "initial"');

    // Linked worktree with one commit ahead of main
    git(hashMain, `worktree add -b feature "${hashWork}"`);
    fs.writeFileSync(path.join(hashWork, 'patch.js'), 'const x = 1;\n');
    git(hashWork, 'add .');
    git(hashWork, 'commit -m "feat: patch"');

    // Server starts on the main repo (no patches), but the URL hash will direct to 'feature'
    const app = createApp({ worktreeName: mainName, worktreePath: hashMain, mainRepoPath: hashMain });
    hashPort = await findAvailablePort(19650);
    await new Promise((resolve) => { hashServer = app.listen(hashPort, '127.0.0.1', resolve); });

    hashPage = await browser.newPage();
    // Load the page with #feature in the URL — initWorktreeBar should auto-switch
    await hashPage.goto(`http://127.0.0.1:${hashPort}#feature`);
    // Wait until either patches or empty state is rendered
    await hashPage.waitForFunction(
      () => document.getElementById('loading').style.display === 'none',
      { timeout: 15000 }
    );
  }, 30000);

  afterAll(async () => {
    await hashPage?.close();
    await new Promise((resolve) => hashServer?.close(resolve));
    fs.rmSync(hashTmpDir, { recursive: true, force: true });
  });

  test('active worktree pill matches the hash target after load', async () => {
    const activePill = await hashPage.$('.worktree-pill.active');
    expect(activePill).not.toBeNull();
    expect(await activePill.getAttribute('data-name')).toBe('feature');
  });

  test('diff content reflects the hash-targeted worktree patches', async () => {
    // 'feature' has one commit ahead; .patch-heading should be visible
    const heading = await hashPage.$('.patch-heading');
    expect(heading).not.toBeNull();
  });
});

describe('current-prompt-bar appears after all patches reviewed and submitted', () => {
  let promptBarPage;

  beforeAll(async () => {
    promptBarPage = await openFreshPage();

    // Approve the first patch (active by default).
    // At this point there are 0 .btn-unapprove elements, so waitForSelector is unambiguous.
    if (await promptBarPage.$('.btn-approve')) {
      await promptBarPage.click('.btn-approve');
      await promptBarPage.waitForSelector('.btn-unapprove');
    }

    // Switch to second patch and approve it too.
    const tabs = await promptBarPage.$$('.patch-tab');
    await tabs[1].click();
    await promptBarPage.waitForFunction(() =>
      document.querySelectorAll('.patch-tab')[1].classList.contains('active')
    );
    // Use a count-based wait: patch 1 may already have a .btn-unapprove in the DOM,
    // so waitForSelector would resolve immediately before patch 2 is actually approved.
    if (await promptBarPage.$('.btn-approve')) {
      const countBefore = await promptBarPage.$$eval('.btn-unapprove', (els) => els.length);
      await promptBarPage.click('.btn-approve');
      await promptBarPage.waitForFunction(
        (n) => document.querySelectorAll('.btn-unapprove').length > n,
        countBefore,
      );
    }

    // Submit — all patches are now approved
    await promptBarPage.click('#btn-submit');
    await promptBarPage.waitForFunction(
      () => document.getElementById('result-overlay')?.classList.contains('visible'),
      { timeout: 15000 }
    );
  }, 60000);

  afterAll(async () => {
    await promptBarPage?.close();
    try { fs.unlinkSync(path.join(workRepoPath, 'REVIEW_FEEDBACK_work-repo.md')); } catch {}
  });

  test('current-prompt-bar is visible when all patches are approved and prompt is set', async () => {
    expect(
      await promptBarPage.$eval('#current-prompt-bar', (el) => el.style.display)
    ).not.toBe('none');
  });
});

// ── Inline comment edit — re-open shows original text ──────────────────────
// Clicking an existing comment body opens the form pre-filled with the
// saved text (not the draft), so the reviewer can see what they wrote.

describe('inline comment edit — re-open shows original text', () => {
  let editPage;

  beforeAll(async () => { editPage = await openFreshPage(); }, 15000);
  afterAll(async () => { await editPage?.close(); });

  test('save a line comment then click its body to re-open the form pre-filled', async () => {
    await editPage.click('.line-added .ln-content');
    await editPage.waitForSelector('.comment-form-row textarea');
    await editPage.fill('.comment-form-row textarea', 'Original comment text');
    await editPage.click('.btn-save');
    await editPage.waitForSelector('.comment-display-row');

    // Click the comment body — removes display, opens form pre-filled
    await editPage.click('.comment-body');
    await editPage.waitForSelector('.comment-form-row textarea');

    const value = await editPage.$eval('.comment-form-row textarea', (el) => el.value);
    expect(value).toBe('Original comment text');
  });

  test('canceling the edit form does not lose the saved comment', async () => {
    // Still in edit form from previous test — type new text then cancel
    await editPage.fill('.comment-form-row textarea', 'Changed text');
    await editPage.click('.btn-cancel');
    await editPage.waitForFunction(() => !document.querySelector('.comment-form-row'));

    // Approve then unapprove to trigger renderCurrentPatch() and re-show comment display
    await editPage.click('.btn-approve');
    await editPage.waitForSelector('.btn-unapprove');
    await editPage.click('.btn-unapprove');
    await editPage.waitForSelector('.btn-approve');
    await editPage.waitForSelector('.comment-display-row');

    expect(await editPage.textContent('.comment-body')).toBe('Original comment text');
  });
});

// ── Draft comment persistence in memory ────────────────────────────────────
// Typing in a form and clicking Cancel stores the text as a draft.
// The draft row appears and clicking it re-opens the form pre-filled.
// Clicking "Discard draft" removes the draft entirely.

describe('draft comment persistence in memory', () => {
  let draftPage;

  beforeAll(async () => { draftPage = await openFreshPage(); }, 15000);
  afterAll(async () => { await draftPage?.close(); });

  test('canceling after typing shows a .comment-draft-row with the draft text', async () => {
    await draftPage.click('.line-added .ln-content');
    await draftPage.waitForSelector('.comment-form-row textarea');
    await draftPage.fill('.comment-form-row textarea', 'Draft text here');
    await draftPage.click('.btn-cancel');
    await draftPage.waitForSelector('.comment-draft-row');
    expect(await draftPage.textContent('.comment-draft-body')).toBe('Draft text here');
  });

  test('clicking the draft row reopens the form pre-filled with the draft text', async () => {
    await draftPage.click('.comment-draft-inner');
    await draftPage.waitForSelector('.comment-form-row textarea');
    const value = await draftPage.$eval('.comment-form-row textarea', (el) => el.value);
    expect(value).toBe('Draft text here');
  });

  test('clicking "Discard draft" removes the draft row and clears the draft', async () => {
    await draftPage.click('.btn-discard');
    await draftPage.waitForFunction(() => !document.querySelector('.comment-form-row'));
    expect(await draftPage.$('.comment-draft-row')).toBeNull();
  });
});

// ── General comment textarea disabled when patch is approved ───────────────
// When a patch is approved the general comment textarea must be disabled so
// the reviewer cannot accidentally add feedback to an already-approved patch.

describe('general comment textarea disabled when patch is approved', () => {
  let approvedPage;

  beforeAll(async () => { approvedPage = await openFreshPage(); }, 15000);
  afterAll(async () => { await approvedPage?.close(); });

  test('textarea is enabled before approval', async () => {
    expect(await approvedPage.$eval('.general-comment-textarea', (el) => el.disabled)).toBe(false);
  });

  test('textarea is disabled after approving the patch', async () => {
    await approvedPage.click('.btn-approve');
    await approvedPage.waitForSelector('.btn-unapprove');
    expect(await approvedPage.$eval('.general-comment-textarea', (el) => el.disabled)).toBe(true);
  });

  test('textarea is re-enabled after unapproving the patch', async () => {
    await approvedPage.click('.btn-unapprove');
    await approvedPage.waitForSelector('.btn-approve');
    expect(await approvedPage.$eval('.general-comment-textarea', (el) => el.disabled)).toBe(false);
  });
});

// ── Tab badge shows comment count, disappears on approve ───────────────────
// A .tab-badge is shown in the patch tab when there are comments and the
// patch is not approved.  Approving removes the badge.
// Uses an isolated server to avoid state contamination from prior tests.

describe('tab badge shows comment count and disappears on approve', () => {
  let badgeServer, badgePage, badgeTmpDir;

  beforeAll(async () => {
    badgeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-ui-badge-'));
    const badgeMain = path.join(badgeTmpDir, 'main');
    const badgeWork = path.join(badgeTmpDir, 'work');

    fs.mkdirSync(badgeMain);
    git(badgeMain, 'init');
    git(badgeMain, 'config user.email "test@test.com"');
    git(badgeMain, 'config user.name "Test"');
    fs.writeFileSync(path.join(badgeMain, 'base.txt'), 'base\n');
    git(badgeMain, 'add .');
    git(badgeMain, 'commit -m "initial"');

    execSync(`git clone "${badgeMain}" "${badgeWork}"`, { encoding: 'utf8' });
    git(badgeWork, 'config user.email "test@test.com"');
    git(badgeWork, 'config user.name "Test"');
    // Two commits so the tabs bar renders (the badge lives inside tab elements)
    fs.writeFileSync(path.join(badgeWork, 'patch.js'), 'function hello() {}\n');
    git(badgeWork, 'add .');
    git(badgeWork, 'commit -m "feat: add hello"');
    fs.writeFileSync(path.join(badgeWork, 'utils.js'), 'function add(a, b) { return a + b; }\n');
    git(badgeWork, 'add .');
    git(badgeWork, 'commit -m "feat: add utils"');

    const app = createApp({ worktreeName: 'work', worktreePath: badgeWork, mainRepoPath: badgeMain });
    const port = await findAvailablePort(19950);
    await new Promise((resolve) => { badgeServer = app.listen(port, '127.0.0.1', resolve); });

    badgePage = await browser.newPage();
    await badgePage.goto(`http://127.0.0.1:${port}`);
    await badgePage.waitForSelector('.patch-heading', { state: 'visible' });
  }, 30000);

  afterAll(async () => {
    await badgePage?.close();
    await new Promise((resolve) => badgeServer?.close(resolve));
    fs.rmSync(badgeTmpDir, { recursive: true, force: true });
  });

  test('no tab badge before any comments', async () => {
    expect(await badgePage.$('.tab-badge')).toBeNull();
  });

  test('saving a line comment stores it (tab badge updates on next approve/unapprove cycle)', async () => {
    // setComment does not call renderTabs; badge only refreshes on approve/unapprove cycles.
    await badgePage.click('.line-added .ln-content');
    await badgePage.waitForSelector('.comment-form-row textarea');
    await badgePage.fill('.comment-form-row textarea', 'Badge test comment');
    await badgePage.click('.btn-save');
    await badgePage.waitForSelector('.comment-display-row');
  });

  test('tab badge is absent when the patch is approved (renderTabs called, isApproved=true)', async () => {
    await badgePage.click('.btn-approve');
    await badgePage.waitForSelector('.btn-unapprove');
    expect(await badgePage.$('.tab-badge')).toBeNull();
  });

  test('tab badge shows count 1 after unapproving (renderTabs reveals comment count)', async () => {
    await badgePage.click('.btn-unapprove');
    await badgePage.waitForSelector('.btn-approve');
    await badgePage.waitForSelector('.tab-badge');
    expect(await badgePage.textContent('.tab-badge')).toBe('1');
  });
});

// ── Copy prompt button ─────────────────────────────────────────────────────
// After submitting, the result overlay shows a "Copy prompt" button.
// Clicking it copies the prompt text and changes the label to "Copied!".

describe('copy prompt button changes label to "Copied!"', () => {
  let copyPage;

  beforeAll(async () => {
    // addInitScript runs before page scripts — clipboard mock is in place
    // before app.js wires up the copy button handler.
    copyPage = await browser.newPage();
    await copyPage.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        get: () => ({ writeText: () => Promise.resolve() }),
        configurable: true,
      });
    });
    await copyPage.goto(baseUrl);
    await copyPage.waitForSelector('.patch-heading', { state: 'visible' });

    await copyPage.fill('.general-comment-textarea', 'Copy prompt test.');
    await copyPage.waitForFunction(() => !document.querySelector('#btn-submit').disabled);
    await copyPage.click('#btn-submit');
    await copyPage.waitForFunction(
      () => document.getElementById('result-overlay')?.classList.contains('visible'),
      { timeout: 15000 }
    );
  }, 60000);

  afterAll(async () => {
    await copyPage?.close();
    try { fs.unlinkSync(path.join(workRepoPath, 'REVIEW_FEEDBACK_work-repo.md')); } catch {}
  });

  test('"Copy prompt" button reverts to "Copy prompt" label after auto-copy', async () => {
    // submitReview auto-copies the prompt (changes label to "Copied!"); wait for the 2s revert
    await copyPage.waitForFunction(
      () => document.getElementById('btn-copy-prompt').textContent === 'Copy prompt',
      { timeout: 5000 }
    );
    expect(await copyPage.textContent('#btn-copy-prompt')).toBe('Copy prompt');
  });

  test('clicking "Copy prompt" changes label to "Copied!"', async () => {
    await copyPage.click('#btn-copy-prompt');
    await copyPage.waitForFunction(
      () => document.getElementById('btn-copy-prompt').textContent === 'Copied!'
    );
    expect(await copyPage.textContent('#btn-copy-prompt')).toBe('Copied!');
  });
});

// ── Revision compare mode ──────────────────────────────────────────────────
// When a patch was previously saved with an older commit hash and then
// amended (new hash), detectRevisionChanges() adds a second revision entry.
// getRevisionList() returns 2 entries → revision toggle bar is shown.
// Clicking ⇄ enters compare mode (two bars, active ⇄); clicking ⇄ again exits.

describe('revision compare mode', () => {
  let revCompServer, revCompPage, revCompTmpDir;

  beforeAll(async () => {
    revCompTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-ui-revcomp-'));
    const revCompMain = path.join(revCompTmpDir, 'main');
    const revCompWork = path.join(revCompTmpDir, 'work');

    fs.mkdirSync(revCompMain);
    git(revCompMain, 'init');
    git(revCompMain, 'config user.email "test@test.com"');
    git(revCompMain, 'config user.name "Test"');
    fs.writeFileSync(path.join(revCompMain, 'base.txt'), 'base\n');
    git(revCompMain, 'add .');
    git(revCompMain, 'commit -m "initial"');

    execSync(`git clone "${revCompMain}" "${revCompWork}"`, { encoding: 'utf8' });
    git(revCompWork, 'config user.email "test@test.com"');
    git(revCompWork, 'config user.name "Test"');
    fs.writeFileSync(path.join(revCompWork, 'patch.js'), 'const v = 1;\n');
    git(revCompWork, 'add .');
    git(revCompWork, 'commit -m "feat: initial patch"');

    const oldHash = git(revCompWork, 'rev-parse HEAD');

    // Pre-write state with oldHash as the only known revision so
    // detectRevisionChanges() will detect a change when the hash differs.
    const stateFile = path.join(revCompWork, 'REVIEW_STATE_work.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      revisions: [{ savedAt: '2024-01-01T00:00:00.000Z', patches: [{ hash: oldHash, message: 'feat: initial patch' }] }],
    }), 'utf8');

    // Amend the commit so the HEAD hash changes
    fs.writeFileSync(path.join(revCompWork, 'patch.js'), 'const v = 2;\n');
    git(revCompWork, 'add .');
    git(revCompWork, 'commit --amend --no-edit');

    const app = createApp({ worktreeName: 'work', worktreePath: revCompWork, mainRepoPath: revCompMain });
    const port = await findAvailablePort(19900);
    await new Promise((resolve) => { revCompServer = app.listen(port, '127.0.0.1', resolve); });

    revCompPage = await browser.newPage();
    await revCompPage.goto(`http://127.0.0.1:${port}`);
    await revCompPage.waitForSelector('.patch-heading', { state: 'visible' });
  }, 30000);

  afterAll(async () => {
    await revCompPage?.close();
    await new Promise((resolve) => revCompServer?.close(resolve));
    fs.rmSync(revCompTmpDir, { recursive: true, force: true });
  });

  test('revision toggle bar is visible when two revisions exist', async () => {
    expect(await revCompPage.$('.revision-toggle-bar')).not.toBeNull();
  });

  test('latest revision (· current) is the first button — leftmost', async () => {
    const firstBtnText = await revCompPage.$eval(
      '.revision-toggle-scroll .btn-toggle-revision:first-child',
      (el) => el.textContent
    );
    expect(firstBtnText).toContain('current');
  });

  test('no left fade when at scrollLeft=0 — first button fully visible', async () => {
    const maskImage = await revCompPage.$eval(
      '.revision-toggle-scroll',
      (el) => el.style.maskImage
    );
    expect(maskImage).toBe('');
  });

  test('⇄ compare button is present and not active', async () => {
    const btn = await revCompPage.$('.btn-compare-toggle');
    expect(btn).not.toBeNull();
    expect(await btn.evaluate((el) => el.classList.contains('active'))).toBe(false);
  });

  test('⇄ compare button is a direct child of the bar, not inside the scroll', async () => {
    const isInsideScroll = await revCompPage.$eval('.btn-compare-toggle', (btn) =>
      btn.closest('.revision-toggle-scroll') !== null
    );
    expect(isInsideScroll).toBe(false);
    const isInsideBar = await revCompPage.$eval('.btn-compare-toggle', (btn) =>
      btn.closest('.revision-toggle-bar') !== null
    );
    expect(isInsideBar).toBe(true);
  });

  test('clicking ⇄ enters compare mode — two revision bars and active ⇄ button', async () => {
    await revCompPage.click('.btn-compare-toggle');
    await revCompPage.waitForFunction(
      () => document.querySelector('.btn-compare-toggle.active') !== null
    );
    expect((await revCompPage.$$('.revision-toggle-bar')).length).toBe(2);
    expect(await revCompPage.$('.btn-compare-toggle.active')).not.toBeNull();
  });

  test('clicking ⇄ (active) exits compare mode — one revision bar, non-active ⇄', async () => {
    await revCompPage.click('.btn-compare-toggle.active');
    await revCompPage.waitForFunction(
      () => document.querySelector('.btn-compare-toggle.active') === null
    );
    expect((await revCompPage.$$('.revision-toggle-bar')).length).toBe(1);
    expect(await revCompPage.$('.btn-compare-toggle')).not.toBeNull();
  });
});

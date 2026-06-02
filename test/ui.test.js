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

// Reset the shared REVIEW_STATE file so the page starts from a clean slate.
// Must wait for the page's first auto-save (scheduled by detectRevisionChanges
// on load) to settle, otherwise that pending save races with our POST and
// overwrites it via loadAndRender's flushSave during the reload below.
async function resetSharedState(p) {
  await p.waitForTimeout(600);
  await p.request.post(`${baseUrl}/api/state`, {
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ comments: {}, generalComments: {}, approved: [], denied: [], drafts: {}, revisions: [] }),
  });
  await p.reload();
  await p.waitForSelector('.patch-heading', { state: 'visible' });
  await p.waitForTimeout(600);
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

// ── Patch heading last-modified date ────────────────────────────────────────
// The heading shows the commit's last-modified time, left-aligned, at the same
// height as the Approve/Deny buttons. Uses a fresh page so the heading is in
// its initial rendered state.

describe('patch heading last-modified date', () => {
  let datePage;

  beforeAll(async () => { datePage = await openFreshPage(); }, 15000);
  afterAll(async () => { await datePage.close(); });

  test('heading shows a last-modified date element', async () => {
    const dateEl = await datePage.$('.patch-heading .patch-heading-date');
    expect(dateEl).not.toBeNull();
  });

  test('the date reads as a real timestamp with a year', async () => {
    const text = await datePage.textContent('.patch-heading .patch-heading-date');
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toMatch(/\d{4}/); // includes the year
  });

  test('the date carries a "Last modified" tooltip', async () => {
    expect(await datePage.$eval('.patch-heading .patch-heading-date', (el) => el.title)).toBe('Last modified');
  });

  test('the date sits to the left of the action buttons', async () => {
    const ok = await datePage.evaluate(() => {
      const heading = document.querySelector('.patch-heading');
      const date = heading.querySelector('.patch-heading-date').getBoundingClientRect();
      const actions = heading.querySelector('.patch-heading-actions').getBoundingClientRect();
      // Same row (vertically overlapping) and the date is left of the buttons.
      const sameRow = date.top < actions.bottom && actions.top < date.bottom;
      return sameRow && date.left < actions.left;
    });
    expect(ok).toBe(true);
  });
});

// ── Sticky patch heading ────────────────────────────────────────────────────
// The heading (with Approve/Deny) is pinned under the top bar so it stays
// reachable while scrolling a long diff. A tall single-file patch in a short
// viewport guarantees the page scrolls.

describe('sticky patch heading', () => {
  let shServer, shPage, shTmpDir;

  beforeAll(async () => {
    shTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-ui-sticky-'));
    const shMain = path.join(shTmpDir, 'main');
    const shWork = path.join(shTmpDir, 'work');

    fs.mkdirSync(shMain);
    git(shMain, 'init');
    git(shMain, 'config user.email "test@test.com"');
    git(shMain, 'config user.name "Test"');
    fs.writeFileSync(path.join(shMain, 'big.js'), 'const x = 0;\n');
    git(shMain, 'add .');
    git(shMain, 'commit -m "initial"');

    execSync(`git clone "${shMain}" "${shWork}"`, { encoding: 'utf8' });
    git(shWork, 'config user.email "test@test.com"');
    git(shWork, 'config user.name "Test"');
    const big = Array.from({ length: 80 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';
    fs.writeFileSync(path.join(shWork, 'big.js'), big);
    git(shWork, 'add .');
    git(shWork, 'commit -m "feat: a long patch"');

    const app = createApp({ worktreeName: 'work', worktreePath: shWork, mainRepoPath: shMain });
    const port = await findAvailablePort(20200);
    await new Promise((resolve) => { shServer = app.listen(port, '127.0.0.1', resolve); });

    shPage = await browser.newPage({ viewport: { width: 900, height: 500 } });
    await shPage.goto(`http://127.0.0.1:${port}`);
    await shPage.waitForSelector('.patch-heading', { state: 'visible' });
  }, 30000);

  afterAll(async () => {
    await shPage?.close();
    await new Promise((resolve) => shServer?.close(resolve));
    fs.rmSync(shTmpDir, { recursive: true, force: true });
  });

  test('patch heading uses sticky positioning', async () => {
    const pos = await shPage.$eval('.patch-heading', (el) => getComputedStyle(el).position);
    expect(pos).toBe('sticky');
  });

  test('heading does not shift between rest and scrolled (no jump)', async () => {
    await shPage.evaluate(() => window.scrollTo(0, 0));
    await shPage.waitForFunction(() => window.scrollY === 0);
    const atRest = await shPage.$eval('.patch-heading', (el) => el.getBoundingClientRect().top);
    await shPage.evaluate(() => window.scrollTo(0, 600));
    await shPage.waitForFunction(() => window.scrollY > 200);
    const scrolled = await shPage.$eval('.patch-heading', (el) => el.getBoundingClientRect().top);
    // The heading occupies the same spot whether at the top or scrolled — it
    // starts flush under the top bar, so there is no slide-up-then-pin jump.
    expect(Math.abs(atRest - scrolled)).toBeLessThanOrEqual(1);
  });

  test('heading stays pinned under the top bar after scrolling down', async () => {
    await shPage.evaluate(() => window.scrollTo(0, 700));
    await shPage.waitForFunction(() => window.scrollY > 200);
    const { headingTop, topBarH } = await shPage.evaluate(() => ({
      headingTop: document.querySelector('.patch-heading').getBoundingClientRect().top,
      topBarH: document.getElementById('top-bar').getBoundingClientRect().height,
    }));
    // Pinned: the heading sits right at the bottom edge of the top bar.
    expect(Math.abs(headingTop - topBarH)).toBeLessThanOrEqual(4);
  });

  test('Approve is fully in view while scrolled down, and toggles when clicked', async () => {
    await shPage.evaluate(() => window.scrollTo(0, 700));
    const inView = await shPage.evaluate(() => {
      const r = document.querySelector('.btn-approve').getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    });
    expect(inView).toBe(true); // reachable without scrolling back up
    await shPage.click('.btn-approve');
    await shPage.waitForSelector('.btn-unapprove');
    expect(await shPage.textContent('.btn-unapprove')).toBe('Approved ✓');
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

// ── Keyboard shortcuts — patch tabs ─────────────────────────────────────────
// Left/Right arrows move between patch tabs. Uses a fresh page so the active
// tab starts at the first patch regardless of prior tests' interactions.

describe('keyboard shortcuts — patch tabs', () => {
  let kbPage;

  beforeAll(async () => { kbPage = await openFreshPage(); }, 15000);
  afterAll(async () => { await kbPage.close(); });

  test('ArrowRight switches to the next patch tab', async () => {
    await kbPage.keyboard.press('ArrowRight');
    await kbPage.waitForFunction(() => document.querySelectorAll('.patch-tab')[1]?.classList.contains('active'));
    expect(await kbPage.$$eval('.patch-tab', (tabs) => tabs[1].classList.contains('active'))).toBe(true);
  });

  test('ArrowRight at the last tab stays on the last tab', async () => {
    await kbPage.keyboard.press('ArrowRight');
    await kbPage.waitForTimeout(50);
    expect(await kbPage.$$eval('.patch-tab', (tabs) => tabs[1].classList.contains('active'))).toBe(true);
  });

  test('ArrowLeft switches back to the previous patch tab', async () => {
    await kbPage.keyboard.press('ArrowLeft');
    await kbPage.waitForFunction(() => document.querySelectorAll('.patch-tab')[0]?.classList.contains('active'));
    expect(await kbPage.$$eval('.patch-tab', (tabs) => tabs[0].classList.contains('active'))).toBe(true);
  });

  test('ArrowLeft at the first tab stays on the first tab', async () => {
    await kbPage.keyboard.press('ArrowLeft');
    await kbPage.waitForTimeout(50);
    expect(await kbPage.$$eval('.patch-tab', (tabs) => tabs[0].classList.contains('active'))).toBe(true);
  });

  test('arrow keys are ignored while a textarea is focused', async () => {
    await kbPage.focus('.general-comment-textarea');
    await kbPage.keyboard.press('ArrowRight');
    await kbPage.waitForTimeout(50);
    // The keypress belongs to the textarea, not the switcher — tab 0 stays active.
    expect(await kbPage.$$eval('.patch-tab', (tabs) => tabs[0].classList.contains('active'))).toBe(true);
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

  // Regression: when top-bar height changes after the initial render (e.g.
  // web-font swap, banner toggle, viewport resize), the sticky sidebar must
  // re-anchor to the new top-bar height instead of remaining at the stale
  // offset captured at first paint.
  test('sidebar top tracks top-bar height when banner appears', async () => {
    const stickyPage = await openFreshPage();
    try {
      const initial = await stickyPage.evaluate(() => ({
        topBar: Math.ceil(document.getElementById('top-bar').getBoundingClientRect().height),
        nav: Math.round(document.getElementById('file-nav').getBoundingClientRect().top),
      }));
      expect(initial.nav).toBe(initial.topBar);

      await stickyPage.evaluate(() => {
        document.getElementById('update-banner').style.display = '';
      });

      await stickyPage.waitForFunction((before) => {
        const cur = Math.ceil(document.getElementById('top-bar').getBoundingClientRect().height);
        if (cur <= before) return false;
        const cssVar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--top-bar-height'));
        return cssVar === cur;
      }, initial.topBar);

      const after = await stickyPage.evaluate(() => ({
        topBar: Math.ceil(document.getElementById('top-bar').getBoundingClientRect().height),
        nav: Math.round(document.getElementById('file-nav').getBoundingClientRect().top),
      }));

      expect(after.topBar).toBeGreaterThan(initial.topBar);
      expect(after.nav).toBe(after.topBar);
    } finally {
      await stickyPage.close();
    }
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

// ── Keyboard shortcuts — file navigation ────────────────────────────────────
// A single patch touching three tall files in a short viewport. The files are
// large enough that the page scrolls, so the scroll-driven highlight reliably
// settles on the file the arrow key brought into view. We navigate between the
// first and middle file: the last file in a patch can't be scrolled all the
// way to the top of the viewport, so its highlight never settles active — an
// existing property of the scroll-based sidebar, unrelated to the shortcut.

describe('keyboard shortcuts — file navigation', () => {
  let kbNavServer, kbNavPage, kbNavTmpDir;
  const FILES = ['alpha', 'beta', 'gamma'];

  beforeAll(async () => {
    kbNavTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-ui-kbnav-'));
    const kbNavMain = path.join(kbNavTmpDir, 'main');
    const kbNavWork = path.join(kbNavTmpDir, 'work');

    fs.mkdirSync(kbNavMain);
    git(kbNavMain, 'init');
    git(kbNavMain, 'config user.email "test@test.com"');
    git(kbNavMain, 'config user.name "Test"');
    const body = (p) => Array.from({ length: 60 }, (_, i) => `const ${p}${i} = ${i};`).join('\n') + '\n';
    for (const f of FILES) fs.writeFileSync(path.join(kbNavMain, `${f}.js`), body(f[0]));
    git(kbNavMain, 'add .');
    git(kbNavMain, 'commit -m "initial"');

    execSync(`git clone "${kbNavMain}" "${kbNavWork}"`, { encoding: 'utf8' });
    git(kbNavWork, 'config user.email "test@test.com"');
    git(kbNavWork, 'config user.name "Test"');
    for (const f of FILES) {
      fs.writeFileSync(path.join(kbNavWork, `${f}.js`), body(f[0]).replace(`const ${f[0]}0 = 0;`, `const ${f[0]}0 = 9;`));
    }
    git(kbNavWork, 'add .');
    git(kbNavWork, 'commit -m "feat: update three files"');

    const app = createApp({ worktreeName: 'work', worktreePath: kbNavWork, mainRepoPath: kbNavMain });
    const port = await findAvailablePort(19900);
    await new Promise((resolve) => { kbNavServer = app.listen(port, '127.0.0.1', resolve); });

    // A short viewport guarantees the page scrolls so the scroll-driven file
    // highlight tracks the arrow-key navigation.
    kbNavPage = await browser.newPage({ viewport: { width: 1000, height: 600 } });
    await kbNavPage.goto(`http://127.0.0.1:${port}`);
    await kbNavPage.waitForSelector('.file-nav-item', { state: 'visible' });
  }, 30000);

  afterAll(async () => {
    await kbNavPage?.close();
    await new Promise((resolve) => kbNavServer?.close(resolve));
    fs.rmSync(kbNavTmpDir, { recursive: true, force: true });
  });

  test('sidebar shows three file nav items with the first active', async () => {
    const items = await kbNavPage.$$('.file-nav-item');
    expect(items.length).toBe(3);
    expect(await items[0].evaluate((el) => el.classList.contains('active'))).toBe(true);
  });

  // The arrow key reuses the nav item's click → smooth-scroll path; the scroll
  // handler settles the highlight on the file actually scrolled into view, so
  // wait for the scroll to finish before asserting the final selection.
  test('ArrowDown moves the active file to the next item', async () => {
    await kbNavPage.keyboard.press('ArrowDown');
    await kbNavPage.waitForTimeout(600);
    await kbNavPage.waitForFunction(
      () => document.querySelectorAll('.file-nav-item')[1].classList.contains('active')
    );
    const items = await kbNavPage.$$('.file-nav-item');
    expect(await items[1].evaluate((el) => el.classList.contains('active'))).toBe(true);
  });

  test('ArrowUp moves the active file back to the previous item', async () => {
    await kbNavPage.keyboard.press('ArrowUp');
    await kbNavPage.waitForTimeout(600);
    await kbNavPage.waitForFunction(
      () => document.querySelectorAll('.file-nav-item')[0].classList.contains('active')
    );
    const items = await kbNavPage.$$('.file-nav-item');
    expect(await items[0].evaluate((el) => el.classList.contains('active'))).toBe(true);
  });
});

// ── Keyboard shortcuts — active tab scrolls into view ───────────────────────
// Many patches in a narrow viewport overflow the tab bar's width, so the
// last tab starts off-screen. Switching to it must scroll the bar to reveal
// it — otherwise the reviewer has to hunt for the active tab by dragging.

describe('keyboard shortcuts — active tab scrolls into view', () => {
  let tabScrollServer, tabScrollPage, tabScrollTmpDir;
  const PATCH_COUNT = 8;

  beforeAll(async () => {
    tabScrollTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-ui-tabscroll-'));
    const tsMain = path.join(tabScrollTmpDir, 'main');
    const tsWork = path.join(tabScrollTmpDir, 'work');

    fs.mkdirSync(tsMain);
    git(tsMain, 'init');
    git(tsMain, 'config user.email "test@test.com"');
    git(tsMain, 'config user.name "Test"');
    fs.writeFileSync(path.join(tsMain, 'base.txt'), 'base\n');
    git(tsMain, 'add .');
    git(tsMain, 'commit -m "initial"');

    execSync(`git clone "${tsMain}" "${tsWork}"`, { encoding: 'utf8' });
    git(tsWork, 'config user.email "test@test.com"');
    git(tsWork, 'config user.name "Test"');
    for (let i = 0; i < PATCH_COUNT; i++) {
      fs.writeFileSync(path.join(tsWork, `file${i}.js`), `const v${i} = ${i};\n`);
      git(tsWork, 'add .');
      git(tsWork, `commit -m "feat: add a reasonably long patch subject number ${i}"`);
    }

    const app = createApp({ worktreeName: 'work', worktreePath: tsWork, mainRepoPath: tsMain });
    const port = await findAvailablePort(20000);
    await new Promise((resolve) => { tabScrollServer = app.listen(port, '127.0.0.1', resolve); });

    // Narrow viewport so the eight tabs overflow the bar's width.
    tabScrollPage = await browser.newPage({ viewport: { width: 520, height: 700 } });
    await tabScrollPage.goto(`http://127.0.0.1:${port}`);
    await tabScrollPage.waitForSelector('.patch-tab', { state: 'visible' });
  }, 30000);

  afterAll(async () => {
    await tabScrollPage?.close();
    await new Promise((resolve) => tabScrollServer?.close(resolve));
    fs.rmSync(tabScrollTmpDir, { recursive: true, force: true });
  });

  test('the tab bar overflows its visible width', async () => {
    expect((await tabScrollPage.$$('.patch-tab')).length).toBe(PATCH_COUNT);
    const overflows = await tabScrollPage.$eval('#patch-tabs-bar', (bar) => bar.scrollWidth > bar.clientWidth + 1);
    expect(overflows).toBe(true);
  });

  test('the last tab is off-screen before navigating to it', async () => {
    const visible = await tabScrollPage.evaluate(() => {
      const bar = document.getElementById('patch-tabs-bar');
      const tabs = document.querySelectorAll('.patch-tab');
      const t = tabs[tabs.length - 1].getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      return t.right <= b.right + 1;
    });
    expect(visible).toBe(false);
  });

  // Poll the visibility condition rather than waiting a fixed time: a long
  // smooth scroll across many tabs can take longer than any single timeout.
  const lastTabVisible = () => {
    const bar = document.getElementById('patch-tabs-bar');
    const tabs = document.querySelectorAll('.patch-tab');
    const t = tabs[tabs.length - 1].getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    return t.left >= b.left - 1 && t.right <= b.right + 1;
  };
  const firstTabVisible = () => {
    const bar = document.getElementById('patch-tabs-bar');
    const t = document.querySelectorAll('.patch-tab')[0].getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    return t.left >= b.left - 1 && t.right <= b.right + 1;
  };

  test('ArrowRight to the last tab scrolls it fully into view', async () => {
    for (let i = 0; i < PATCH_COUNT - 1; i++) {
      await tabScrollPage.keyboard.press('ArrowRight');
    }
    await tabScrollPage.waitForFunction(() => {
      const tabs = document.querySelectorAll('.patch-tab');
      return tabs[tabs.length - 1].classList.contains('active');
    });
    await tabScrollPage.waitForFunction(lastTabVisible);
    expect(await tabScrollPage.evaluate(lastTabVisible)).toBe(true);
  });

  test('ArrowLeft back to the first tab scrolls it into view', async () => {
    for (let i = 0; i < PATCH_COUNT - 1; i++) {
      await tabScrollPage.keyboard.press('ArrowLeft');
    }
    await tabScrollPage.waitForFunction(() =>
      document.querySelectorAll('.patch-tab')[0].classList.contains('active')
    );
    await tabScrollPage.waitForFunction(firstTabVisible);
    expect(await tabScrollPage.evaluate(firstTabVisible)).toBe(true);
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
// loadAndRender() flushes any pending auto-save before resetting state so
// that unsaved approvals/denials land on disk and are restored after reload.
// Previously the timer was just cancelled, which silently discarded changes
// made in the 500 ms window before the user hit reload.

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

  test('approval made within 500 ms before reload is preserved (flush-before-reset)', async () => {
    // Approve the patch but reload immediately — before the 500 ms debounce fires.
    // The fix flushes the pending save before resetting state, so the server
    // receives approved:[hash] and the patch stays approved after reload.
    await racePage.click('.btn-approve');
    await racePage.waitForSelector('.btn-unapprove', { timeout: 3000 });

    // Trigger reload within 500ms (no waitForTimeout) so the approval hasn't been saved yet
    await racePage.evaluate(() => { document.getElementById('update-banner').style.display = ''; });
    await racePage.click('#btn-reload-page');
    await racePage.waitForSelector('.patch-heading', { state: 'visible' });
    await racePage.waitForTimeout(200);

    // The approval should have been flushed before the reset, so it survives the reload.
    expect(await racePage.$('.btn-unapprove')).not.toBeNull();
  });

  test('pending deny flushed on reload — last intent wins, not last saved state', async () => {
    // Approve and let it save to server
    await racePage.click('.btn-unapprove'); // undo any prior approve
    await racePage.waitForTimeout(600);
    await racePage.click('.btn-approve');
    await racePage.waitForSelector('.btn-unapprove', { timeout: 3000 });
    await racePage.waitForTimeout(600); // server now has approved:[hash]

    // Deny the patch (pending save queued, not yet sent to server)
    await racePage.click('.btn-deny');
    await racePage.waitForSelector('.btn-undeny', { timeout: 3000 });

    // Reload immediately — the flush-before-reset saves the deny to the server
    await racePage.evaluate(() => { document.getElementById('update-banner').style.display = ''; });
    await racePage.click('#btn-reload-page');
    await racePage.waitForSelector('.patch-heading', { state: 'visible' });
    await racePage.waitForTimeout(200);

    // The deny should be preserved (flushed before reset), not the old approved state
    expect(await racePage.$('.btn-undeny')).not.toBeNull();
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

// ── Post-submit heading class sync ────────────────────────────────────────
// After generating the review prompt, ALL patch elements must be rebuilt so
// that non-active patches do not retain stale heading classes (e.g. a denied
// heading that was cleared when denied state was wiped on submit).
//
// Regression: submitReview() previously called renderCurrentPatch() which
// only rebuilt the currently-visible patch; switching to another patch after
// submit would reveal a stale heading with the pre-submit styling.

describe('patch heading classes updated for all patches after submit', () => {
  let syncPage;

  beforeAll(async () => {
    syncPage = await openFreshPage();

    // Deny patch 0 while on it (starts as active).
    await syncPage.click('.btn-deny');
    await syncPage.waitForFunction(() =>
      document.querySelectorAll('.patch-tab')[0].classList.contains('denied')
    );

    // Switch to patch 1 — submit will fire with currentPatchIdx = 1,
    // so only patch 1 would be rebuilt if the bug were still present.
    await syncPage.$$('.patch-tab').then(([, t1]) => t1.click());
    await syncPage.waitForFunction(() =>
      document.querySelectorAll('.patch-tab')[1].classList.contains('active')
    );

    // Submit button is enabled because denied.size > 0.
    await syncPage.waitForFunction(() => !document.querySelector('#btn-submit').disabled);
    await syncPage.click('#btn-submit');
    await syncPage.waitForFunction(
      () => document.getElementById('result-overlay')?.classList.contains('visible'),
      { timeout: 15000 }
    );
    await syncPage.click('#btn-close-modal');
    await syncPage.waitForFunction(
      () => !document.getElementById('result-overlay').classList.contains('visible')
    );
  }, 60000);

  afterAll(async () => {
    await syncPage?.close();
    try { fs.unlinkSync(path.join(workRepoPath, 'REVIEW_FEEDBACK_work-repo.md')); } catch {}
  });

  test('denied heading removed from non-active patch after submit', async () => {
    // Switch to patch 0, which was denied before submit and cleared after.
    await syncPage.$$('.patch-tab').then(([t0]) => t0.click());
    await syncPage.waitForFunction(() =>
      document.querySelectorAll('.patch-tab')[0].classList.contains('active')
    );

    const hasDenied = await syncPage.$eval(
      '.patch-heading',
      (el) => el.classList.contains('patch-heading-denied')
    );
    expect(hasDenied).toBe(false);
  });

  test('denied tab class removed after submit', async () => {
    const hasDenied = await syncPage.$eval(
      '.patch-tab',
      (el) => el.classList.contains('denied')
    );
    expect(hasDenied).toBe(false);
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
    // Earlier describes (e.g. submit error state) may leave approvals on
    // disk.  Without a reset, this describe would start with patch 1 already
    // approved and the .btn-approve selector would match only the hidden
    // patch-2 button.
    await resetSharedState(promptBarPage);

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

  beforeAll(async () => {
    editPage = await openFreshPage();
    await resetSharedState(editPage);
  }, 15000);
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

  test('canceling the edit form keeps the in-progress draft visible AND preserves the saved comment on disk', async () => {
    // Still in edit form from previous test — type new text then cancel
    await editPage.fill('.comment-form-row textarea', 'Changed text');
    await editPage.click('.btn-cancel');
    await editPage.waitForFunction(() => !document.querySelector('.comment-form-row'));

    // The cancel does NOT save, but the in-progress edit is still the
    // user's latest intent — show it as a draft row so they can find it.
    await editPage.waitForSelector('.comment-draft-row');
    const draftBody = await editPage.textContent('.comment-draft-row .comment-body');
    expect(draftBody).toContain('Changed text');

    // And the saved comment hasn't been touched on disk.
    const state = await editPage.request.get(`${baseUrl}/api/state`).then((r) => r.json());
    const allComments = Object.values(state.comments).flatMap((byFile) =>
      Object.values(byFile).flatMap((byKey) => Object.values(byKey))
    );
    expect(allComments.find((c) => c.text === 'Original comment text')).toBeTruthy();

    // Cleanup: explicitly discard the draft so subsequent describes don't
    // see it bleed across.
    await editPage.click('.comment-draft-row .comment-draft-inner');
    await editPage.waitForSelector('.comment-form-row textarea');
    await editPage.click('.btn-discard');
    await editPage.waitForFunction(() => !document.querySelector('.comment-form-row'));
  });
});

// ── Draft comment persistence in memory ────────────────────────────────────
// Typing in a form and clicking Cancel stores the text as a draft.
// The draft row appears and clicking it re-opens the form pre-filled.
// Clicking "Discard draft" removes the draft entirely.

describe('draft comment persistence in memory', () => {
  let draftPage;

  beforeAll(async () => {
    draftPage = await openFreshPage();
    await resetSharedState(draftPage);
  }, 15000);
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

  beforeAll(async () => {
    approvedPage = await openFreshPage();
    await resetSharedState(approvedPage);
  }, 15000);
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

    // Earlier describes may have left state on disk with patches approved;
    // that disables the general-comment textarea and breaks the fill below.
    await resetSharedState(copyPage);

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
    // Midday mid-year so the formatted year is 2024 regardless of the test
    // browser's timezone (a midnight-UTC value can render as the prior year).
    fs.writeFileSync(stateFile, JSON.stringify({
      revisions: [{ savedAt: '2024-06-15T12:00:00.000Z', patches: [{ hash: oldHash, message: 'feat: initial patch' }] }],
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

  test('current revision button shows the commit date, matching the heading', async () => {
    const headingDate = (await revCompPage.textContent('.patch-heading .patch-heading-date')).trim();
    const currentRevDate = (await revCompPage.$eval(
      '.revision-toggle-scroll .btn-toggle-revision:first-child .rev-btn-date',
      (el) => el.textContent
    )).trim();
    expect(headingDate.length).toBeGreaterThan(0);
    // Same source (committer date), same formatter → identical strings.
    expect(currentRevDate).toBe(headingDate);
  });

  test('older revision without a commit date falls back to its saved time', async () => {
    // The pre-written Rev 1 snapshot has savedAt 2024-01-01 and no date field.
    const oldestRevDate = await revCompPage.$eval(
      '.revision-toggle-scroll .btn-toggle-revision:last-child .rev-btn-date',
      (el) => el.textContent
    );
    expect(oldestRevDate).toContain('2024');
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

// ── Revision comparison file scoping ───────────────────────────────────────
// The compare view must show only files the current (to) revision changes. An
// older revision touched two files; the amended current one touches just one.
// Comparing them must show only that one file — the other is not part of what
// this revision changes.

describe('revision comparison file scoping', () => {
  let scServer, scPage, scTmpDir;

  beforeAll(async () => {
    scTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-ui-scope-'));
    const scMain = path.join(scTmpDir, 'main');
    const scWork = path.join(scTmpDir, 'work');

    fs.mkdirSync(scMain);
    git(scMain, 'init');
    git(scMain, 'config user.email "test@test.com"');
    git(scMain, 'config user.name "Test"');
    fs.writeFileSync(path.join(scMain, 'fileA.js'), 'const a = 0;\n');
    fs.writeFileSync(path.join(scMain, 'fileB.js'), 'const b = 0;\n');
    git(scMain, 'add .');
    git(scMain, 'commit -m "initial"');

    execSync(`git clone "${scMain}" "${scWork}"`, { encoding: 'utf8' });
    git(scWork, 'config user.email "test@test.com"');
    git(scWork, 'config user.name "Test"');

    // Old revision changes BOTH files.
    fs.writeFileSync(path.join(scWork, 'fileA.js'), 'const a = 1;\n');
    fs.writeFileSync(path.join(scWork, 'fileB.js'), 'const b = 1;\n');
    git(scWork, 'add .');
    git(scWork, 'commit -m "feat: change A and B"');
    const oldHash = git(scWork, 'rev-parse HEAD');

    // Record the old revision in state so a comparison target exists.
    fs.writeFileSync(
      path.join(scWork, 'REVIEW_STATE_work.json'),
      JSON.stringify({
        revisions: [{ savedAt: '2024-06-15T12:00:00.000Z', patches: [{ hash: oldHash, message: 'feat: change A and B' }] }],
      }),
      'utf8'
    );

    // Amend so the current revision changes ONLY fileA (fileB back to base).
    // Stage just the source files — `git add .` would sweep the REVIEW_STATE
    // file written above into the commit.
    fs.writeFileSync(path.join(scWork, 'fileB.js'), 'const b = 0;\n');
    fs.writeFileSync(path.join(scWork, 'fileA.js'), 'const a = 2;\n');
    git(scWork, 'add fileA.js fileB.js');
    git(scWork, 'commit --amend --no-edit');

    const app = createApp({ worktreeName: 'work', worktreePath: scWork, mainRepoPath: scMain });
    const port = await findAvailablePort(20100);
    await new Promise((resolve) => { scServer = app.listen(port, '127.0.0.1', resolve); });

    scPage = await browser.newPage();
    await scPage.goto(`http://127.0.0.1:${port}`);
    await scPage.waitForSelector('.patch-heading', { state: 'visible' });
  }, 30000);

  afterAll(async () => {
    await scPage?.close();
    await new Promise((resolve) => scServer?.close(resolve));
    fs.rmSync(scTmpDir, { recursive: true, force: true });
  });

  test('compare view shows only the file the current revision changes', async () => {
    // Two revisions exist → the compare (⇄) button is shown.
    await scPage.waitForSelector('.btn-compare-toggle');
    await scPage.click('.btn-compare-toggle');
    // Wait for the comparison diff to load its file blocks.
    await scPage.waitForSelector('.diff-compare-readonly .file-block');
    const paths = await scPage.$$eval(
      '.diff-compare-readonly .file-header .file-path',
      (els) => els.map((e) => e.textContent)
    );
    expect(paths).toEqual(['fileA.js']); // fileB.js (changed only by the old rev) is excluded
  });
});

// ── Approval persistence across reload — diff fingerprint ──────────────────
// These tests exercise the core rule: approval survives a reload when the
// diff content is unchanged (e.g. commit message amend, rebase), but is
// cleared when the actual code changes.
//
// Uses a fresh isolated repo/server so git mutations don't affect other tests.

describe('approval after reload — diff fingerprint', () => {
  let fpTmpDir, fpMainPath, fpWorkPath;
  let fpServer, fpBaseUrl;

  beforeAll(async () => {
    fpTmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-fp-'));
    fpMainPath = path.join(fpTmpDir, 'main');
    fpWorkPath = path.join(fpTmpDir, 'work');

    fs.mkdirSync(fpMainPath);
    git(fpMainPath, 'init');
    git(fpMainPath, 'config user.email "test@test.com"');
    git(fpMainPath, 'config user.name "Test"');
    fs.writeFileSync(path.join(fpMainPath, 'base.txt'), 'base\n');
    git(fpMainPath, 'add .');
    git(fpMainPath, 'commit -m "initial"');

    execSync(`git clone "${fpMainPath}" "${fpWorkPath}"`, { encoding: 'utf8' });
    git(fpWorkPath, 'config user.email "test@test.com"');
    git(fpWorkPath, 'config user.name "Test"');

    fs.writeFileSync(path.join(fpWorkPath, 'patch.js'), 'function foo() {\n  return 1;\n}\n');
    git(fpWorkPath, 'add .');
    git(fpWorkPath, 'commit -m "feat: add foo"');

    const app = createApp({ worktreeName: 'work', worktreePath: fpWorkPath, mainRepoPath: fpMainPath });
    const port = await findAvailablePort(19500);
    await new Promise((resolve) => { fpServer = app.listen(port, '127.0.0.1', resolve); });
    fpBaseUrl = `http://127.0.0.1:${port}`;
  }, 30000);

  afterAll(async () => {
    await new Promise((resolve) => fpServer?.close(resolve));
    fs.rmSync(fpTmpDir, { recursive: true, force: true });
  });

  async function openFpPage() {
    const p = await browser.newPage();
    await p.goto(fpBaseUrl);
    await p.waitForSelector('.patch-heading', { state: 'visible' });
    return p;
  }

  async function resetFpState(p) {
    // Wait for the page's first auto-save (scheduled by detectRevisionChanges
    // on load) to settle; otherwise the loadAndRender triggered by the reload
    // click below will flushSave the stale in-memory state, overwriting our POST.
    await p.waitForTimeout(600);
    await p.request.post(`${fpBaseUrl}/api/state`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ comments: {}, generalComments: {}, approved: [], denied: [], revisions: [] }),
    });
    await p.evaluate(() => { document.getElementById('update-banner').style.display = ''; });
    await p.click('#btn-reload-page');
    await p.waitForSelector('.patch-heading', { state: 'visible' });
    await p.waitForTimeout(600); // let baseline auto-save settle
  }

  test('approval survives reload when only commit message changes (same diff)', async () => {
    const p = await openFpPage();
    await resetFpState(p);

    await p.click('.btn-approve');
    await p.waitForSelector('.btn-unapprove', { timeout: 3000 });
    await p.waitForTimeout(600); // approval saved to disk

    // Amend only the commit message — diff content unchanged
    git(fpWorkPath, 'commit --amend -m "feat: add foo (refined message)"');

    await p.evaluate(() => { document.getElementById('update-banner').style.display = ''; });
    await p.click('#btn-reload-page');
    await p.waitForSelector('.patch-heading', { state: 'visible' });
    await p.waitForTimeout(200);

    expect(await p.$('.btn-unapprove')).not.toBeNull();
    await p.close();
  }, 15000);

  test('approval cleared on reload when code is changed in the commit', async () => {
    const p = await openFpPage();
    await resetFpState(p);

    await p.click('.btn-approve');
    await p.waitForSelector('.btn-unapprove', { timeout: 3000 });
    await p.waitForTimeout(600);

    // Amend the commit with an actual code change
    fs.appendFileSync(path.join(fpWorkPath, 'patch.js'), '// new line\n');
    git(fpWorkPath, 'add patch.js');
    git(fpWorkPath, 'commit --amend --no-edit');

    await p.evaluate(() => { document.getElementById('update-banner').style.display = ''; });
    await p.click('#btn-reload-page');
    await p.waitForSelector('.patch-heading', { state: 'visible' });
    await p.waitForTimeout(200);

    expect(await p.$('.btn-approve')).not.toBeNull();
    await p.close();
  }, 15000);
});

// ── Draft persistence and multi-tab sync ──────────────────────────────────
// Drafts (unsaved comment textarea text) must survive page reload, and a stale
// background tab must not clobber a comment saved in another tab.

describe('draft persistence and multi-tab sync', () => {
  let dpTmpDir, dpMainPath, dpWorkPath;
  let dpServer, dpBaseUrl, dpContext;

  beforeAll(async () => {
    dpTmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-draft-'));
    dpMainPath = path.join(dpTmpDir, 'main');
    dpWorkPath = path.join(dpTmpDir, 'work');

    fs.mkdirSync(dpMainPath);
    git(dpMainPath, 'init');
    git(dpMainPath, 'config user.email "test@test.com"');
    git(dpMainPath, 'config user.name "Test"');
    fs.writeFileSync(path.join(dpMainPath, 'base.txt'), 'base\n');
    git(dpMainPath, 'add .');
    git(dpMainPath, 'commit -m "initial"');

    execSync(`git clone "${dpMainPath}" "${dpWorkPath}"`, { encoding: 'utf8' });
    git(dpWorkPath, 'config user.email "test@test.com"');
    git(dpWorkPath, 'config user.name "Test"');

    fs.writeFileSync(path.join(dpWorkPath, 'sample.js'), 'function foo() {\n  return 1;\n}\n');
    git(dpWorkPath, 'add .');
    git(dpWorkPath, 'commit -m "feat: add foo"');

    const app = createApp({ worktreeName: 'work', worktreePath: dpWorkPath, mainRepoPath: dpMainPath });
    const port = await findAvailablePort(19600);
    await new Promise((resolve) => { dpServer = app.listen(port, '127.0.0.1', resolve); });
    dpBaseUrl = `http://127.0.0.1:${port}`;

    // Single context so two pages share BroadcastChannel + storage (multi-tab scenario)
    dpContext = await browser.newContext();
  }, 30000);

  afterAll(async () => {
    await dpContext?.close();
    await new Promise((resolve) => dpServer?.close(resolve));
    fs.rmSync(dpTmpDir, { recursive: true, force: true });
  });

  async function openDpPage() {
    const p = await dpContext.newPage();
    await p.goto(dpBaseUrl);
    await p.waitForSelector('.patch-heading', { state: 'visible' });
    return p;
  }

  async function resetDpState(p) {
    await p.request.post(`${dpBaseUrl}/api/state`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ comments: {}, generalComments: {}, approved: [], denied: [], drafts: {}, revisions: [] }),
    });
    await p.reload();
    await p.waitForSelector('.patch-heading', { state: 'visible' });
  }

  test('per-line draft survives page reload', async () => {
    const p = await openDpPage();
    await resetDpState(p);

    await p.click('.line-added .ln-content');
    await p.waitForSelector('.comment-form-row textarea');
    // Use type() so the input event fires (fill() may bypass per-key input events for non-debounced UIs)
    await p.locator('.comment-form-row textarea').type('WIP draft text');
    await p.waitForTimeout(700); // 500ms debounce + buffer

    await p.reload();
    await p.waitForSelector('.patch-heading', { state: 'visible' });

    await p.waitForSelector('.comment-draft-row');
    expect(await p.textContent('.comment-draft-row .comment-body')).toContain('WIP draft text');
    await p.close();
  }, 20000);

  // Regression: editing a saved comment and clicking another line used to
  // leave the original line blank — the saved-comment row was removed when
  // the form opened, and renderDraftDisplay bailed because a saved comment
  // existed.  The user's in-progress edit was invisible.
  test('edit a saved comment, click another line — draft stays visible on the original line', async () => {
    const p = await openDpPage();
    await resetDpState(p);

    // 1. Save an initial comment on line 0.
    const lines = p.locator('.line-added .ln-content');
    await lines.first().click();
    await p.waitForSelector('.comment-form-row textarea');
    await p.fill('.comment-form-row textarea', 'Original');
    await p.click('.btn-save');
    await p.waitForSelector('.comment-display-row');

    // 2. Click the saved-comment body to open it for editing.
    await p.locator('.comment-display-row .comment-body').first().click();
    await p.waitForSelector('.comment-form-row textarea');

    // 3. Type an edit (do NOT save).
    const ta = p.locator('.comment-form-row textarea');
    await ta.press('End');
    await ta.type(' EDIT');
    await p.waitForTimeout(600); // let the debounced draft save settle

    // 4. Click on a different added line — the form moves, the edit must
    //    remain visible as a draft row on the original line.
    await lines.nth(1).click();
    await p.waitForSelector('.comment-form-row textarea'); // form opens on the new line
    await p.waitForTimeout(200);

    const draftBodies = await p.locator('.comment-draft-row .comment-body').allTextContents();
    expect(draftBodies.some((t) => t.includes('Original') && t.includes('EDIT'))).toBe(true);
    await p.close();
  }, 25000);

  test('commit-message draft survives page reload', async () => {
    const p = await openDpPage();
    await resetDpState(p);

    await p.click('.commit-msg-subject');
    await p.waitForSelector('.comment-form-inner textarea');
    await p.locator('.comment-form-inner textarea').type('WIP commit msg draft');
    await p.waitForTimeout(700);

    await p.reload();
    await p.waitForSelector('.patch-heading', { state: 'visible' });

    await p.waitForSelector('.comment-draft-row');
    expect(await p.textContent('.comment-draft-row .comment-body')).toContain('WIP commit msg draft');
    await p.close();
  }, 20000);

  test('Generate Review Prompt clears drafts from disk', async () => {
    const p = await openDpPage();
    await resetDpState(p);

    // Save a real comment so submit is enabled
    await p.click('.line-added .ln-content');
    await p.waitForSelector('.comment-form-row textarea');
    await p.fill('.comment-form-row textarea', 'real comment');
    await p.click('.btn-save');
    await p.waitForSelector('.comment-display-row');

    // Open commit-message form and type a draft (do NOT click Save)
    await p.click('.commit-msg-subject');
    await p.waitForSelector('.comment-form-inner textarea');
    await p.locator('.comment-form-inner textarea').type('WIP to be cleared');
    await p.waitForTimeout(700); // draft auto-saved to disk

    // Sanity: draft is on disk before submit
    let state = await p.request.get(`${dpBaseUrl}/api/state`).then((r) => r.json());
    expect(Object.values(state.drafts || {}).some((v) => v.includes('WIP to be cleared'))).toBe(true);

    await p.click('#btn-submit');
    await p.waitForSelector('#result-overlay.visible', { timeout: 10000 });
    await p.click('#btn-close-modal');
    await p.waitForTimeout(700);

    state = await p.request.get(`${dpBaseUrl}/api/state`).then((r) => r.json());
    expect(state.drafts || {}).toEqual({});
    await p.close();
  }, 25000);

  test('saved comment in tab A appears in tab B without manual reload', async () => {
    const pageA = await openDpPage();
    await resetDpState(pageA);
    const pageB = await openDpPage(); // opens after reset, sees clean state

    await pageA.click('.line-added .ln-content');
    await pageA.waitForSelector('.comment-form-row textarea');
    await pageA.fill('.comment-form-row textarea', 'A says hi');
    await pageA.click('.btn-save');
    await pageA.waitForSelector('.comment-display-row');

    await pageB.waitForSelector('.comment-display-row', { timeout: 5000 });
    expect(await pageB.textContent('.comment-display-row .comment-body')).toBe('A says hi');

    await pageA.close();
    await pageB.close();
  }, 25000);

  test('stale tab does not clobber a saved comment from another tab', async () => {
    // Regression test: without sync, tab B's stale in-memory state would
    // overwrite tab A's saved comment when B triggers any auto-save
    // (approve, deny, type, etc.).
    const pageA = await openDpPage();
    await resetDpState(pageA);
    const pageB = await openDpPage();

    await pageA.click('.line-added .ln-content');
    await pageA.waitForSelector('.comment-form-row textarea');
    await pageA.fill('.comment-form-row textarea', 'A saved this');
    await pageA.click('.btn-save');
    await pageA.waitForSelector('.comment-display-row');
    await pageA.waitForTimeout(800); // give broadcast + B's refetch time to land

    // B does an innocuous auto-saving action
    await pageB.click('.btn-approve');
    await pageB.waitForSelector('.btn-unapprove');
    await pageB.waitForTimeout(800);

    const state = await pageA.request.get(`${dpBaseUrl}/api/state`).then((r) => r.json());
    const allComments = Object.values(state.comments).flatMap((byFile) =>
      Object.values(byFile).flatMap((byKey) => Object.values(byKey))
    );
    expect(allComments.find((c) => c.text === 'A saved this')).toBeTruthy();

    await pageA.close();
    await pageB.close();
  }, 25000);

  // Cross-tab approval should propagate the new state to peer tabs without
  // requiring a reload: button labels, diff readonly, GC textarea disabled.
  test('approve in tab A propagates to tab B without reload', async () => {
    const pageA = await openDpPage();
    await resetDpState(pageA);
    const pageB = await openDpPage();

    await pageA.click('.btn-approve');
    await pageA.waitForSelector('.btn-unapprove');
    await pageB.waitForSelector('.btn-unapprove', { timeout: 5000 });
    expect(await pageB.locator('.btn-unapprove').textContent()).toContain('Approved');
    expect(await pageB.locator('.general-comment-textarea').isDisabled()).toBe(true);

    await pageA.close();
    await pageB.close();
  }, 25000);

  // Tab B has a comment form open on the same line tab A is about to mutate.
  // The form-open guard must prevent B's form (and its typing) from being
  // ripped out from under the user.
  test('open form on the same line survives a remote save on that line', async () => {
    const pageA = await openDpPage();
    await resetDpState(pageA);
    const pageB = await openDpPage();

    // pageB opens a form on the first added line and starts typing.
    await pageB.locator('.line-added .ln-content').first().click();
    await pageB.waitForSelector('.comment-form-row textarea');
    await pageB.locator('.comment-form-row textarea').type('B mid-typing');

    // pageA also targets the same first added line and saves a comment.
    await pageA.locator('.line-added .ln-content').first().click();
    await pageA.waitForSelector('.comment-form-row textarea');
    await pageA.fill('.comment-form-row textarea', 'A saves first');
    await pageA.click('.btn-save');
    await pageA.waitForSelector('.comment-display-row');
    await pageB.waitForTimeout(400);

    // B's form must still be present and hold the original text.
    expect(await pageB.locator('.comment-form-row textarea').inputValue()).toBe('B mid-typing');

    await pageA.close();
    await pageB.close();
  }, 25000);

  // Tab B has an open comment form mid-typing on line L1.  Tab A saves a
  // comment on a DIFFERENT line.  Tab B's open form (and its in-progress
  // text) must survive the broadcast — Task 2's open-form-preservation.
  test('open comment form survives a remote save on a different line', async () => {
    const pageA = await openDpPage();
    await resetDpState(pageA);
    const pageB = await openDpPage();

    // pageB opens a form on the first added line and starts typing.
    await pageB.locator('.line-added .ln-content').first().click();
    await pageB.waitForSelector('.comment-form-row textarea');
    await pageB.locator('.comment-form-row textarea').type('typing in B');

    // pageA saves a real comment on a different added line.
    await pageA.locator('.line-added .ln-content').nth(1).click();
    await pageA.waitForSelector('.comment-form-row textarea');
    await pageA.fill('.comment-form-row textarea', 'A on line 2');
    await pageA.click('.btn-save');
    await pageA.waitForSelector('.comment-display-row');
    await pageB.waitForTimeout(400); // give the broadcast time to land in B

    // B's form should still be open with the original text.
    const taValue = await pageB.locator('.comment-form-row textarea').inputValue();
    expect(taValue).toBe('typing in B');
    // And A's comment should be visible in B's DOM on the OTHER line.
    expect(await pageB.locator('.comment-display-row').count()).toBe(1);

    await pageA.close();
    await pageB.close();
  }, 25000);

  // Tab B has the general-comment textarea focused and is typing.  Tab A
  // changes the same patch's general comment.  B's typing must survive.
  test('focused general-comment textarea is not stomped by a remote update', async () => {
    const pageA = await openDpPage();
    await resetDpState(pageA);
    const pageB = await openDpPage();

    // Focus and type in B's general-comment textarea.
    await pageB.locator('.general-comment-textarea').focus();
    await pageB.locator('.general-comment-textarea').type('B is typing here');

    // A also types into the general-comment textarea; the debounce posts it.
    await pageA.locator('.general-comment-textarea').fill('A overwrote');
    await pageA.waitForTimeout(800); // 500 ms debounce + buffer for broadcast

    // B's value must be its own typing, not A's.
    const bVal = await pageB.locator('.general-comment-textarea').inputValue();
    expect(bVal).toBe('B is typing here');

    await pageA.close();
    await pageB.close();
  }, 25000);

  // The headline regression for delta endpoints: two tabs saving comments on
  // different lines at essentially the same time both persist.  Before delta
  // endpoints, each tab's POST /api/state wrote a full snapshot and whichever
  // tab flushed last would clobber the other.
  test('two tabs saving comments on different lines simultaneously — both survive', async () => {
    const pageA = await openDpPage();
    await resetDpState(pageA);
    const pageB = await openDpPage();

    // pageA on the first added line, pageB on a later one so the lineKey differs.
    await pageA.locator('.line-added .ln-content').first().click();
    await pageB.locator('.line-added .ln-content').nth(1).click();
    await pageA.waitForSelector('.comment-form-row textarea');
    await pageB.waitForSelector('.comment-form-row textarea');
    await pageA.fill('.comment-form-row textarea', 'A on line 1');
    await pageB.fill('.comment-form-row textarea', 'B on line 2');

    // Save both as close together as the test runner allows; the delta
    // endpoint lock + per-entry write means both must end up on disk.
    await Promise.all([
      pageA.click('.btn-save'),
      pageB.click('.btn-save'),
    ]);
    await pageA.waitForSelector('.comment-display-row');
    await pageB.waitForSelector('.comment-display-row');
    await pageA.waitForTimeout(400); // let broadcast + remote sync settle

    const state = await pageA.request.get(`${dpBaseUrl}/api/state`).then((r) => r.json());
    const allComments = Object.values(state.comments).flatMap((byFile) =>
      Object.values(byFile).flatMap((byKey) => Object.values(byKey))
    );
    expect(allComments.find((c) => c.text === 'A on line 1')).toBeTruthy();
    expect(allComments.find((c) => c.text === 'B on line 2')).toBeTruthy();

    await pageA.close();
    await pageB.close();
  }, 25000);

  // Three tabs, mixed sequence of edits, then assert each tab's DOM and the
  // server's JSON state all agree.  This is the plan's Task 4 end-to-end
  // consistency check — the broadest "do all transports keep N tabs in
  // lockstep?" assertion.
  test('three tabs editing concurrently end in identical state on every tab and on disk', async () => {
    const pageA = await openDpPage();
    await resetDpState(pageA);
    const pageB = await openDpPage();
    const pageC = await openDpPage();

    // A on line 1
    await pageA.locator('.line-added .ln-content').first().click();
    await pageA.waitForSelector('.comment-form-row textarea');
    await pageA.fill('.comment-form-row textarea', 'A1');
    await pageA.click('.btn-save');
    await pageA.waitForSelector('.comment-display-row');

    // B on line 2
    await pageB.locator('.line-added .ln-content').nth(1).click();
    await pageB.waitForSelector('.comment-form-row textarea');
    await pageB.fill('.comment-form-row textarea', 'B2');
    await pageB.click('.btn-save');
    await pageB.waitForSelector('.comment-display-row');

    // C approves
    await pageC.click('.btn-approve');
    await pageC.waitForSelector('.btn-unapprove');

    // Let SSE deliver to all peers.
    await pageA.waitForTimeout(600);

    const state = await pageA.request.get(`${dpBaseUrl}/api/state`).then((r) => r.json());
    expect(state.approved).toContain((await pageA.locator('.patch-heading-hash').first().textContent()).trim());
    const allComments = Object.values(state.comments).flatMap((byFile) =>
      Object.values(byFile).flatMap((byKey) => Object.values(byKey))
    );
    expect(allComments.find((c) => c.text === 'A1')).toBeTruthy();
    expect(allComments.find((c) => c.text === 'B2')).toBeTruthy();

    // Every tab should show both comment rows and the approved state.
    for (const p of [pageA, pageB, pageC]) {
      await p.waitForSelector('.comment-display-row', { timeout: 5000 });
      expect(await p.locator('.comment-display-row').count()).toBe(2);
      expect(await p.locator('.btn-unapprove').count()).toBe(1);
    }

    await pageA.close();
    await pageB.close();
    await pageC.close();
  }, 30000);

  // Two separate browser contexts do NOT share a BroadcastChannel, so this
  // test proves the SSE transport delivers cross-window/cross-machine.
  test('cross-context sync via SSE: save in A visible in B without reload', async () => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      await pageA.goto(dpBaseUrl);
      await pageA.waitForSelector('.patch-heading', { state: 'visible' });
      await pageA.request.post(`${dpBaseUrl}/api/state`, {
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ comments: {}, generalComments: {}, approved: [], denied: [], drafts: {}, revisions: [] }),
      });
      await pageA.reload();
      await pageA.waitForSelector('.patch-heading', { state: 'visible' });
      await pageB.goto(dpBaseUrl);
      await pageB.waitForSelector('.patch-heading', { state: 'visible' });

      await pageA.click('.line-added .ln-content');
      await pageA.waitForSelector('.comment-form-row textarea');
      await pageA.fill('.comment-form-row textarea', 'cross-context hi');
      await pageA.click('.btn-save');
      await pageA.waitForSelector('.comment-display-row');

      await pageB.waitForSelector('.comment-display-row', { timeout: 5000 });
      expect(await pageB.textContent('.comment-display-row .comment-body')).toBe('cross-context hi');
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  }, 25000);
});

// ── docs/index.html interactive demo ──────────────────────────────────────
// The demo mocks every endpoint the real client uses.  When a new endpoint
// is added (e.g. delta saves in MULTI_TAB_SYNC_PLAN.md Task 1a) the mock has
// to be updated or the demo silently shows "Save failed" on every action.
// This test serves the static files and clicks Save end-to-end so the
// regression is caught automatically next time.

describe('docs/index.html interactive demo', () => {
  let demoServer, demoBaseUrl, demoPage;

  beforeAll(async () => {
    // eslint-disable-next-line global-require
    const express = require('express');
    const projectRoot = path.join(__dirname, '..');
    const app = express();
    app.use(express.static(projectRoot));
    const port = await findAvailablePort(19700);
    await new Promise((resolve) => { demoServer = app.listen(port, '127.0.0.1', resolve); });
    demoBaseUrl = `http://127.0.0.1:${port}`;

    demoPage = await browser.newPage();
    await demoPage.goto(`${demoBaseUrl}/docs/index.html`);
    await demoPage.waitForSelector('.patch-heading', { state: 'visible', timeout: 10000 });
  }, 30000);

  afterAll(async () => {
    await demoPage?.close();
    await new Promise((resolve) => demoServer?.close(resolve));
  });

  test('demo loads and renders the mock patches', async () => {
    // Demo has six mock patches (Bug 1234567 Parts 1-6).
    const tabCount = await demoPage.locator('.patch-tab').count();
    expect(tabCount).toBe(6);
  });

  test('saving a comment in the demo does not surface "Save failed"', async () => {
    // Part 1 is approved in the mock state which puts the diff in readonly
    // mode (clicks ignored).  Switch to Part 2 (denied, editable) first.
    await demoPage.locator('.patch-tab').nth(1).click();
    await demoPage.waitForFunction(
      () => document.querySelectorAll('.patch-tab')[1].classList.contains('active')
    );
    // `.line-added` exists in every patch's DOM (hidden when not active).
    // Filter to the visible one so Playwright's actionability check passes.
    await demoPage.locator('.line-added .ln-content').locator('visible=true').first().click();
    await demoPage.waitForSelector('.comment-form-row textarea');
    await demoPage.fill('.comment-form-row textarea', 'demo comment');
    await demoPage.locator('.comment-form-row .btn-save').click();
    await demoPage.waitForSelector('.comment-display-row');
    await demoPage.waitForTimeout(300);

    const status = (await demoPage.locator('#autosave-status').textContent()).trim();
    expect(status).not.toBe('Save failed');
  }, 30000);

  test('approving a patch in the demo does not surface "Save failed"', async () => {
    // Same hidden-vs-visible filtering as above: every patch panel has its
    // own approve/unapprove button in the DOM, but only one is visible.
    const btn = demoPage.locator('.patch-heading-actions .btn-approve, .patch-heading-actions .btn-unapprove')
      .locator('visible=true').first();
    await btn.click();
    await demoPage.waitForTimeout(300);
    const status = (await demoPage.locator('#autosave-status').textContent()).trim();
    expect(status).not.toBe('Save failed');
  }, 30000);

  // Diff lines must show `!=`, `==`, `>=`, `->` as the raw two characters,
  // never as JetBrains Mono's combined ligature glyphs.  In a code-review
  // tool, what the reviewer sees has to match what is in the file.
  test('diff line content renders with programming ligatures disabled', async () => {
    const cs = await demoPage.locator('.ln-content').first()
      .evaluate((el) => getComputedStyle(el).fontVariantLigatures);
    expect(cs).toBe('none');
  }, 30000);

  // The browser must successfully fetch and render the favicon — a regression
  // that breaks the SVG (malformed XML, wrong path) would show up here as a
  // failed image load.
  test('favicon link resolves to a valid SVG document', async () => {
    const href = await demoPage.locator('link[rel="icon"]').getAttribute('href');
    expect(href).toBeTruthy();
    const absolute = new URL(href, demoPage.url()).toString();
    const res = await demoPage.request.get(absolute);
    expect(res.status()).toBe(200);
    const ct = res.headers()['content-type'] || '';
    expect(ct).toMatch(/svg\+xml|application\/octet-stream|image\/svg/);
    const text = await res.text();
    expect(text).toMatch(/<svg[\s\S]*<\/svg>/);
    expect(text).toMatch(/>R</);
  }, 30000);

  // The "Revue" wordmark is the masthead — it must render visibly larger
  // than the inline #bug-id-display next to it, and it must be set in the
  // mono font so it reads as a logotype for a code-review tool.  A
  // regression that shrinks the wordmark or swaps the family back to sans
  // would be caught here.
  test('.app-name wordmark is rendered larger and in the mono family', async () => {
    const wordmark = await demoPage.locator('.app-name').boundingBox();
    const bugId    = await demoPage.locator('#bug-id-display').boundingBox();
    expect(wordmark.height).toBeGreaterThanOrEqual(20);
    expect(wordmark.height).toBeGreaterThan(bugId.height + 4);
    const computed = await demoPage.locator('.app-name').evaluate((el) => ({
      fontSize: parseFloat(getComputedStyle(el).fontSize),
      fontFamily: getComputedStyle(el).fontFamily,
    }));
    expect(computed.fontSize).toBe(24);
    expect(computed.fontFamily).toMatch(/JetBrains Mono/i);
  }, 30000);

  // The autosave indicator must occupy the same box regardless of which
  // message it currently shows — otherwise the header pulses every time a
  // save settles.  Measures bounding box across all four content states and
  // asserts they are identical.
  test('#autosave-status bounding box is identical across "", "Saving…", "Saved", "Save failed"', async () => {
    const states = ['', 'Saving…', 'Saved', 'Save failed'];
    const boxes = [];
    for (const text of states) {
      await demoPage.evaluate((t) => {
        document.querySelector('#autosave-status').textContent = t;
      }, text);
      // Yield a frame so layout settles before we measure.
      await demoPage.waitForTimeout(50);
      boxes.push(await demoPage.locator('#autosave-status').boundingBox());
    }
    // Every state should report the same x / y / width / height.
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i]).toEqual(boxes[0]);
    }
    // And the autosave's right edge must equal the submit button's right edge.
    const submitBox = await demoPage.locator('#btn-submit').boundingBox();
    expect(boxes[0].x + boxes[0].width).toBeCloseTo(submitBox.x + submitBox.width, 1);
    // Reset so subsequent tests don't see leftover text.
    await demoPage.evaluate(() => { document.querySelector('#autosave-status').textContent = ''; });
  }, 30000);
});

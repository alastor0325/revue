/**
 * @jest-environment jsdom
 */
'use strict';

// Bug numbers and URLs in commit titles and messages become links.

global.fetch = jest.fn();
global.EventSource = jest.fn(() => ({ addEventListener: jest.fn(), close: jest.fn() }));

const { linkifyText, renderCommitMessageSection } = require('../public/renderer');
const { state } = require('../public/state');

const MOZILLA = [{ pattern: '\\bbug\\s+(\\d{3,8})\\b', url: 'https://bugzilla.mozilla.org/show_bug.cgi?id=$1' }];
const GITHUB = [{ pattern: '(?<![\\w&/])#(\\d+)\\b', url: 'https://github.com/w3c/mediasession/issues/$1' }];

const links = (html) => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return [...d.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
};

describe('linkifyText', () => {
  test('links "Bug NNN" to Bugzilla with the Mozilla rule', () => {
    expect(links(linkifyText('Bug 1955763 - Part 1: Keep durations. r?#media', MOZILLA))).toEqual([
      ['Bug 1955763', 'https://bugzilla.mozilla.org/show_bug.cgi?id=1955763'],
    ]);
    expect(links(linkifyText('see bug 123456 and Bug 7654321', MOZILLA))).toEqual([
      ['bug 123456', 'https://bugzilla.mozilla.org/show_bug.cgi?id=123456'],
      ['Bug 7654321', 'https://bugzilla.mozilla.org/show_bug.cgi?id=7654321'],
    ]);
  });

  test('links URLs, leaving trailing punctuation and unmatched ")" outside', () => {
    expect(links(linkifyText('Differential Revision: https://phabricator.services.mozilla.com/D338964'))).toEqual([
      ['https://phabricator.services.mozilla.com/D338964', 'https://phabricator.services.mozilla.com/D338964'],
    ]);
    const html = linkifyText('(see https://example.org/a.html). And https://example.org/q?a=1&b=2, done');
    expect(links(html)).toEqual([
      ['https://example.org/a.html', 'https://example.org/a.html'],
      ['https://example.org/q?a=1&b=2', 'https://example.org/q?a=1&b=2'],
    ]);
    expect(html).toContain('</a>). And');
  });

  test('a reference inside a URL is not linked twice', () => {
    // "bug 1234" starts inside the first URL, so only the two URLs are links.
    expect(links(linkifyText('https://example.org/bug 1234 https://bugzilla.mozilla.org/show_bug.cgi?id=1955763', MOZILLA))).toHaveLength(2);
    expect(links(linkifyText('https://github.com/w3c/mediasession/pull/378#issuecomment-1', GITHUB))).toHaveLength(1);
  });

  test('links nothing but URLs when the repo has no known tracker', () => {
    expect(links(linkifyText('Fix WebKit bug 123456 (#12), see https://example.org', []))).toEqual([
      ['https://example.org', 'https://example.org'],
    ]);
  });

  test('links "#123" to the GitHub repo with the GitHub rule', () => {
    expect(links(linkifyText('Let an audible AudioContext activate a media session (#378)', GITHUB))).toEqual([
      ['#378', 'https://github.com/w3c/mediasession/issues/378'],
    ]);
    expect(links(linkifyText('color: #fff; a&#39;b; x#12', GITHUB))).toEqual([]);
  });

  test('escapes everything else', () => {
    const html = linkifyText('<img src=x onerror=alert(1)> Bug 123', MOZILLA);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('commit message section', () => {
  test('a link opens its page and does not start a comment', () => {
    state.linkRules = MOZILLA; // from /api/diff in the app
    const container = document.createElement('div');
    renderCommitMessageSection(container, 'abc123', 'Bug 1955763 - Fix it\n\nDifferential Revision: https://phabricator.services.mozilla.com/D1', false);
    const [subjectLink, bodyLink] = container.querySelectorAll('a.commit-link');
    expect(subjectLink.href).toBe('https://bugzilla.mozilla.org/show_bug.cgi?id=1955763');
    expect(bodyLink.target).toBe('_blank');
    bodyLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(container.querySelector('textarea')).toBeNull();
    container.querySelector('.commit-msg-text').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(container.querySelector('textarea')).not.toBeNull();
  });
});

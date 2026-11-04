'use strict';

// Which issue references link where, from a repo's git remotes (src/links.js).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { linkRules, linkRulesFromRemotes } = require('../src/links');
const { git } = require('./helpers');

const BUGZILLA = 'https://bugzilla.mozilla.org/show_bug.cgi?id=$1';

test('Firefox (any Mozilla remote) links "Bug NNN" to Bugzilla, and not #N', () => {
  for (const url of ['https://github.com/mozilla-firefox/firefox', 'git@github.com:mozilla-firefox/firefox.git',
    'https://hg.mozilla.org/mozilla-central', 'hg::https://hg.mozilla.org/mozilla-unified']) {
    expect(linkRulesFromRemotes({ origin: url }).map((r) => r.url)).toEqual([BUGZILLA]);
  }
});

test('a GitHub fork links #N to upstream; otherwise to origin', () => {
  expect(linkRulesFromRemotes({
    origin: 'https://github.com/alastor0325/mediasession.git', upstream: 'https://github.com/w3c/mediasession.git',
  })[0].url).toBe('https://github.com/w3c/mediasession/issues/$1');
  expect(linkRulesFromRemotes({ origin: 'git@github.com:alastor0325/revue.git' })[0].url)
    .toBe('https://github.com/alastor0325/revue/issues/$1');
});

test('no tracker for other hosts or no remotes', () => {
  expect(linkRulesFromRemotes({ origin: 'https://gitlab.com/a/b.git' })).toEqual([]);
  expect(linkRulesFromRemotes({})).toEqual([]);
});

test('linkRules reads the remotes of a real repo', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-links-'));
  try {
    git(repo, 'init');
    git(repo, 'remote add origin https://github.com/mozilla-firefox/firefox');
    expect(linkRules(repo).map((r) => r.url)).toEqual([BUGZILLA]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

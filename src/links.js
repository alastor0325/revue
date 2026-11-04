'use strict';

// Which issue references in commit text link where, decided per repo from its
// git remotes, so a reference is only linked when we know its tracker:
//   - Mozilla repos (Firefox): "Bug 1234567" -> Bugzilla.
//   - Other GitHub repos: "#123" -> that repo's issues/PRs.  The `upstream`
//     remote wins over `origin`: in a fork, PR numbers are upstream's.
// Anything else gets no rules (URLs are still linked by the client).
// The client applies the rules (public/renderer.js linkifyText).

const { execFileSync } = require('child_process');

const MOZILLA_REMOTE = /github\.com[/:]mozilla-firefox\/|hg\.mozilla\.org|mozilla-central|mozilla-unified|gecko-dev/i;
const GITHUB_REMOTE = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

/** { name: url } of the repo's fetch remotes, or {} if it has none / isn't git. */
function remotes(repo) {
  let out = '';
  try { out = execFileSync('git', ['-C', repo, 'remote', '-v'], { encoding: 'utf8' }); } catch { return {}; }
  const byName = {};
  for (const line of out.split('\n')) {
    const [name, url, kind] = line.split(/\s+/);
    if (name && url && kind === '(fetch)') byName[name] = url;
  }
  return byName;
}

/**
 * Link rules for commit text in `repo`: [{ pattern, url }] where `pattern` is
 * a regex source (matched case-insensitively) and `url` has `$1` for its
 * first group.
 */
function linkRulesFromRemotes(byName) {
  const urls = Object.values(byName);
  if (urls.some((u) => MOZILLA_REMOTE.test(u))) {
    return [{ pattern: '\\bbug\\s+(\\d{3,8})\\b', url: 'https://bugzilla.mozilla.org/show_bug.cgi?id=$1' }];
  }
  const gh = [byName.upstream, byName.origin, ...urls].map((u) => u && GITHUB_REMOTE.exec(u)).find(Boolean);
  if (gh) return [{ pattern: '(?<![\\w&/])#(\\d+)\\b', url: `https://github.com/${gh[1]}/${gh[2]}/issues/$1` }];
  return [];
}

const cache = new Map(); // repo -> rules (remotes rarely change; a daemon restart refreshes)
function linkRules(repo) {
  if (!cache.has(repo)) cache.set(repo, linkRulesFromRemotes(remotes(repo)));
  return cache.get(repo);
}

module.exports = { linkRules, linkRulesFromRemotes };

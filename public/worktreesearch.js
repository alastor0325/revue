// Fuzzy search over the worktree bar (public/app.js initWorktreeBar).  Pure,
// so it can be unit-tested.
//
// A worktree matches on its name or its branch, or else on the title of one
// of its patches (`titles`, from /api/worktrees/titles; see matchTitle).
// Matching ignores case, spaces, "-" and "_", so a pasted "Bug 1955763" or
// "bug-1955763" finds the worktree "1955763".  Results rank exact > prefix > substring > subsequence;
// a query with a digit never matches as a subsequence (bug numbers share
// most digits, so "205" would match nearly every one).  Letters match as a
// substring only where they are together in the name, unless the query has
// a separator too ("vtt interop"); otherwise across a "-" they count as a
// subsequence (e.g. "np" is "n…p" in "activation-placeholder").

const SKIP = /[\s_-]/;

// `s` without the skipped characters, lowercased, and for each kept
// character its index in `s` (to mark the matched characters of `s`).
function fold(s) {
  let text = '';
  const at = [];
  for (let i = 0; i < s.length; i++) {
    if (SKIP.test(s[i])) continue;
    text += s[i].toLowerCase();
    at.push(i);
  }
  return { text, at };
}

/** The query as matched: folded, without a leading "bug" before a number. */
export function normalizeQuery(q) {
  return fold(String(q).replace(/^\s*bug[\s_-]*(?=\d)/i, '')).text;
}

const EXACT = 4, PREFIX = 3, SUBSTRING = 2, SUBSEQUENCE = 1;

// Whether the character of `s` at `i` starts a word.
const wordStart = (s, i) => i === 0 || /[^a-z0-9]/i.test(s[i - 1]);

// The first run of `q` (normalized) in `s` that `accept(pos, at)` takes:
// { score, marks } or null, where `marks` are the indices of the matched
// characters of `s` and `pos` indexes the folded text.
function matchRun(s, q, accept) {
  const { text, at } = fold(s);
  for (let pos = text.indexOf(q); pos >= 0; pos = text.indexOf(q, pos + 1)) {
    if (!accept(pos, at)) continue;
    const score = text === q ? EXACT : pos === 0 ? PREFIX : SUBSTRING;
    return { score, marks: at.slice(pos, pos + q.length) };
  }
  return null;
}

// Match `q` (normalized) in a name or branch `s`: { score, marks } or null.
// `spaced`: the query had a separator, so it may match across one.
function matchField(s, q, spaced) {
  const digits = /\d/.test(q);
  // Folding joins the words; letters must not match across a gap.
  const run = matchRun(s, q, (pos, at) => digits || spaced || at[pos + q.length - 1] - at[pos] === q.length - 1);
  if (run || digits) return run;
  const { text, at } = fold(s);
  // Subsequence, starting where a word of `s` starts.
  const first = [...text].findIndex((c, i) => c === q[0] && wordStart(s, at[i]));
  if (first < 0) return null;
  const marks = [at[first]];
  let i = first + 1;
  for (const c of q.slice(1)) {
    while (i < text.length && text[i] !== c) i++;
    if (i === text.length) return null;
    marks.push(at[i++]);
  }
  return { score: SUBSEQUENCE, marks };
}

// A patch title matches only from a query of 3+ characters, as a run that
// starts a word and may run across spaces ("mediasession" is "Media
// Session"); as initials or word parts it would match nearly any title.  The
// reviewer tags at its end ("r=…", "r?…", "a=…", "DONTBUILD") don't count.
const TITLE_MIN = 3;
const TITLE_TAGS = /(\s+(r[=?]|a=)\S*|\s+DONTBUILD)+$/;

// The best-matching title of `titles` (the newest on a tie):
// { title, fullTitle, score, marks }, where `title` is without its tags.
function matchTitle(titles, q) {
  let best = null;
  for (const fullTitle of titles) {
    const title = fullTitle.replace(TITLE_TAGS, '');
    const m = matchRun(title, q, (pos, at) => wordStart(title, at[pos]));
    if (m && (!best || m.score > best.score)) best = { title, fullTitle, ...m };
  }
  return best;
}

/**
 * The worktrees matching `query`, best first (`titles`: worktree name → its
 * patch titles), as
 * { wt, field: 'name' | 'branch' | 'title', marks, score, title, fullTitle },
 * where `marks` index the matched field (`title` is the matched title);
 * every name or branch match ranks above every title match, and ties keep
 * the given order.  An empty query returns every worktree in the given order.
 */
export function searchWorktrees(worktrees, query, titles = {}) {
  const q = normalizeQuery(query);
  if (!q) return worktrees.map((wt) => ({ wt, field: 'name', marks: [] }));
  const spaced = SKIP.test(String(query).trim());
  const hits = [];
  for (const wt of worktrees) {
    const name = matchField(wt.worktreeName, q, spaced);
    const branch = wt.branch ? matchField(wt.branch, q, spaced) : null;
    // The name wins a tie: it is what the pill shows.
    const best = branch && (!name || branch.score > name.score) ? { field: 'branch', ...branch } : name && { field: 'name', ...name };
    if (best) hits.push({ wt, ...best });
    else if (q.length >= TITLE_MIN) {
      const title = matchTitle(titles[wt.worktreeName] || [], q);
      if (title) hits.push({ wt, field: 'title', ...title });
    }
  }
  const tier = (hit) => (hit.field === 'title' ? 0 : 1);
  return hits.sort((a, b) => tier(b) - tier(a) || b.score - a.score); // stable: ties keep their order
}

/**
 * The part of `text` around its `marks` (about `width` characters, from the
 * start of a word), with "…" where it is cut: { text, marks } with the marks
 * moved to match.
 */
export function snippet(text, marks, width = 36) {
  if (text.length <= width) return { text, marks };
  const lo = marks[0];
  const hi = marks[marks.length - 1];
  // Some context before the match, then back to the start of that word.
  let start = Math.max(0, Math.min(lo - Math.floor((width - (hi - lo)) / 3), text.length - width));
  while (start > 0 && /\S/.test(text[start - 1])) start--;
  const end = Math.min(text.length, start + Math.max(width, hi - start + 1));
  const head = start > 0 ? '…' : '';
  return {
    text: head + text.slice(start, end) + (end < text.length ? '…' : ''),
    marks: marks.map((i) => i - start + head.length),
  };
}

/** `text` as HTML, with the characters at `marks` in <b>. */
export function markHtml(text, marks, escapeHtml) {
  const set = new Set(marks);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    out += set.has(i) ? `<b>${escapeHtml(text[i])}</b>` : escapeHtml(text[i]);
  }
  return out.replace(/<\/b><b>/g, '');
}

if (typeof module !== 'undefined') {
  module.exports = { normalizeQuery, searchWorktrees, markHtml, snippet };
}

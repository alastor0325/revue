// Fuzzy search over the worktree bar (public/app.js initWorktreeBar).  Pure,
// so it can be unit-tested.
//
// A worktree matches on its name or its branch.  Matching ignores case,
// spaces, "-" and "_", so a pasted "Bug 1955763" or "bug-1955763" finds the
// worktree "1955763".  Results rank exact > prefix > substring > subsequence;
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

// Match `q` (normalized) in `s`: { score, marks } or null, where `marks` are
// the indices of the matched characters of `s`.  `spaced`: the query had a
// separator, so it may match across one.
function matchField(s, q, spaced) {
  const { text, at } = fold(s);
  const digits = /\d/.test(q);
  const pos = text.indexOf(q);
  // Folding joins the words; a letter query must not match across a gap.
  if (pos >= 0 && (digits || spaced || at[pos + q.length - 1] - at[pos] === q.length - 1)) {
    const score = text === q ? EXACT : pos === 0 ? PREFIX : SUBSTRING;
    return { score, marks: at.slice(pos, pos + q.length) };
  }
  if (digits) return null;
  // Subsequence, starting where a word of `s` starts.
  const first = [...text].findIndex((c, i) => c === q[0] && (at[i] === 0 || /[^a-z0-9]/i.test(s[at[i] - 1])));
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

/**
 * The worktrees matching `query`, best first, as
 * { wt, field: 'name' | 'branch', marks, score }; ties keep the given order.  An
 * empty query returns every worktree in the given order.
 */
export function searchWorktrees(worktrees, query) {
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
  }
  return hits.sort((a, b) => b.score - a.score); // stable: ties keep their order
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
  module.exports = { normalizeQuery, searchWorktrees, markHtml };
}

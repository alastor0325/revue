// Syntax highlighting for diff lines, using the vendored highlight.js bundle
// (public/vendor/highlight.min.js).  Everything except loadHighlighter() is
// pure so it can be unit-tested with an injected highlighter.
//
// A hunk is highlighted one *side* at a time — the new side (context + added
// lines) and the old side (context + removed lines) — as a single block, so a
// multi-line comment or string that spans several diff lines is still coloured
// correctly.  The block's HTML is then split back into one fragment per line.

let hljs = null;

/** Load the vendored highlighter.  Rendering falls back to plain text if this fails. */
export async function loadHighlighter() {
  try {
    hljs = (await import('./vendor/highlight.min.js')).default;
  } catch (err) {
    console.warn('Syntax highlighting unavailable:', err);
  }
}

/** Test seam: install (or clear, with null) the highlighter. */
export function setHighlighter(h) {
  hljs = h;
  canonical.clear();
}

// Only the cases where highlight.js's own aliases are wrong or missing for
// Firefox code; any other extension is looked up as-is.  Headers are C++ (not
// C), IDL-like formats read well as C++, moz.build / moz.configure are Python.
const OVERRIDES = {
  h: 'cpp', inl: 'cpp', idl: 'cpp', webidl: 'cpp', ipdl: 'cpp', ipdlh: 'cpp',
  m: 'objectivec', jsm: 'javascript', xul: 'xml',
  build: 'python', mozbuild: 'python', configure: 'python',
  'makefile.in': 'makefile',
};

/** highlight.js language for a file path, or null when it can't be highlighted. */
export function languageFor(filePath) {
  if (!hljs) return null;
  // A Jinja template ("prompt.md.j2") is highlighted as the file it produces
  // (same suffixes as src/render.js TEMPLATE_EXT).
  const base = filePath.split('/').pop().toLowerCase().replace(/\.(j2|jinja2?)$/, '');
  const ext = base.includes('.') ? base.split('.').pop() : base; // "Makefile" → "makefile"
  const lang = OVERRIDES[base] || OVERRIDES[ext] || ext;
  return hljs.getLanguage(lang) ? lang : null;
}

// Canonical highlight.js language name per alias ("h" → "cpp", "md" →
// "markdown"), cached because renderFile runs again on every re-render.
const canonical = new Map();

/**
 * "language-<canonical name>" for the file's language, or null when it isn't
 * highlighted.  It goes on the diff table so style.css can give each format
 * its own token rules; it is the same class highlight.js puts on code embedded
 * in another file (e.g. a <script> in HTML), so those rules cover that too.
 */
export function languageClass(filePath) {
  const lang = languageFor(filePath);
  if (!lang) return null;
  if (!canonical.has(lang)) {
    const grammar = hljs.getLanguage(lang);
    canonical.set(lang, hljs.listLanguages().find((n) => hljs.getLanguage(n) === grammar) || lang);
  }
  return `language-${canonical.get(lang)}`;
}

/**
 * Split highlight.js HTML into one fragment per source line.  Spans that are
 * open at a newline are closed at the end of that line and reopened at the
 * start of the next, so every fragment is balanced on its own.
 */
export function splitHighlightedLines(html) {
  const lines = [];
  const open = [];
  let cur = '';
  const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) { open.push(m[1]); cur += m[1]; }
    else if (m[2]) { open.pop(); cur += m[2]; }
    else if (m[3]) { lines.push(cur + '</span>'.repeat(open.length)); cur = open.join(''); }
    else cur += m[4];
  }
  lines.push(cur);
  return lines;
}

// Skip highlighting very large hunks (e.g. generated files) to keep rendering fast.
const MAX_CHARS = 200000;

function highlightBlock(texts, lang) {
  const code = texts.join('\n');
  try {
    const out = splitHighlightedLines(hljs.highlight(code, { language: lang, ignoreIllegals: true }).value);
    return out.length === texts.length ? out : null;
  } catch {
    return null;
  }
}

// Highlight the lines of one side of a hunk (all lines except `skipType`) as a
// single block.  Returns an array indexed like `lines` (holes for skipped
// lines), or null if highlighting failed.
function highlightSide(lines, lang, skipType) {
  const idx = [];
  lines.forEach((l, i) => { if (l.type !== skipType) idx.push(i); });
  if (idx.length === 0) return [];
  const html = highlightBlock(idx.map((i) => lines[i].content), lang);
  if (!html) return null;
  const out = [];
  idx.forEach((i, k) => { out[i] = html[k]; });
  return out;
}

/**
 * Highlighted HTML for each diff line ({ type, content }), aligned with
 * `lines`, or null when the file's language is unknown, the highlighter isn't
 * loaded, or highlighting fails — callers then render escaped plain text.
 * Removed lines come from the old side (context + removed); every other line
 * from the new side (context + added).
 */
export function highlightDiffLines(lines, filePath) {
  // The patch view is rebuilt on approve/deny, compare toggles and refreshes;
  // the hunk's `lines` array survives those, so reuse its highlighted HTML.
  const hit = cache.get(lines);
  if (hit && hit.filePath === filePath && hit.hljs === hljs) return hit.out;

  const lang = languageFor(filePath);
  let out = null;
  if (lang && lines.reduce((n, l) => n + l.content.length, 0) <= MAX_CHARS) {
    // Context lines are tokenised on both sides: the old side needs them to
    // track state (e.g. a removed line inside a comment), but their HTML is
    // taken from the new side.
    const newSide = highlightSide(lines, lang, 'removed');
    const oldSide = lines.some((l) => l.type === 'removed') ? highlightSide(lines, lang, 'added') : [];
    if (newSide && oldSide) out = lines.map((l, i) => (l.type === 'removed' ? oldSide : newSide)[i]);
  }
  cache.set(lines, { filePath, hljs, out });
  return out;
}

const cache = new WeakMap(); // hunk lines array → { filePath, hljs, out }

if (typeof module !== 'undefined') {
  module.exports = { loadHighlighter, setHighlighter, languageFor, languageClass, splitHighlightedLines, highlightDiffLines };
}

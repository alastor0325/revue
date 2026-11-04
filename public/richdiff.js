// Rendered ("rich") diff of a Markdown or Bikeshed file, like GitHub's rich
// diff: the new rendered document, with added blocks marked and removed
// blocks put back in place, struck through.  The server renders both sides
// (GET api/rendered); this module diffs them block by block.
//
// The page is shown in an iframe sandboxed WITHOUT allow-scripts, so nothing
// in the rendered document (Bikeshed's own scripts, raw HTML in Markdown) can
// run; allow-same-origin only lets this module read and mark its DOM.

const BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,dt,dd,pre,blockquote,tr,figcaption,summary';
// Bikeshed's generated sections change whenever a definition, reference or
// section is added anywhere; their entries would repeat every real change.
const GENERATED = '#toc, #index, #idl-index, #references, #issues-index, #property-index, ul.index';
// Generated decoration inside a block, not part of its content: section
// numbers ("3.2.") renumber after every inserted section.
const DECORATION = '.secno, .self-link, .content-index-link';

// A block's own text: its text without nested blocks (compared on their own)
// or decoration.  An <li> step that also holds a nested <ol> is keyed on its
// step text alone.
function ownText(el) {
  let text = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 3) text += node.nodeValue;
    else if (node.nodeType === 1 && !node.matches(BLOCK_SELECTOR) && !node.matches(DECORATION)) text += ownText(node);
  }
  return text;
}

/**
 * Comparison key for a block: its own text, whitespace-collapsed (kept as-is
 * for <pre>), with section numbers in references ("see § 4.2") dropped — they
 * all shift when a section is inserted, without the text changing.
 */
export function blockKey(el) {
  const text = ownText(el).replace(/§\s*[\d.]+/g, '§');
  return el.tagName === 'PRE' ? text : text.replace(/\s+/g, ' ').trim();
}

/** The document's diffable blocks, in order: blocks with their own text, outside generated sections. */
export function diffBlocks(doc) {
  return [...doc.body.querySelectorAll(BLOCK_SELECTOR)]
    .filter((el) => !el.closest(GENERATED) && blockKey(el) !== '');
}

// Beyond this many cells the LCS table gets too big; treat the middle as rewritten.
const MAX_LCS_CELLS = 4e6;

/**
 * Edit script between two key sequences: [{ op: 'same', a, b } | { op: 'del', a } | { op: 'add', b }]
 * (a/b are indices into `a`/`b`), in document order.  Common prefix and suffix
 * are trimmed first, so the usual small edit to a large spec stays cheap.
 */
export function diffSequences(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ op: 'same', a: i, b: i });

  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    for (let i = 0; i < n; i++) ops.push({ op: 'del', a: pre + i });
    for (let j = 0; j < m; j++) ops.push({ op: 'add', b: pre + j });
  } else {
    // Compare small integer ids in the DP, not (possibly long) block strings.
    const ids = new Map();
    const id = (k) => { if (!ids.has(k)) ids.set(k, ids.size); return ids.get(k); };
    const A = Int32Array.from({ length: n }, (_, i) => id(a[pre + i]));
    const B = Int32Array.from({ length: m }, (_, j) => id(b[pre + j]));
    // lcs[i][j] = LCS length of A[i..] and B[j..]
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = A[i] === B[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { ops.push({ op: 'same', a: pre + i, b: pre + j }); i++; j++; }
      // On a tie, delete first: a replaced block reads old-then-new.
      else if (i < n && (j === m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) { ops.push({ op: 'del', a: pre + i }); i++; }
      else { ops.push({ op: 'add', b: pre + j }); j++; }
    }
  }
  for (let k = suf; k > 0; k--) ops.push({ op: 'same', a: a.length - k, b: b.length - k });
  return ops;
}

/**
 * Mark `newDoc` against `oldDoc`: added blocks get .revue-added, removed
 * blocks are imported from `oldDoc` and inserted where they were, with
 * .revue-removed (without their nested blocks, which are diffed on their
 * own).  Returns the marked elements in document order.
 */
export function markChanges(newDoc, oldDoc) {
  const nb = diffBlocks(newDoc);
  const ob = diffBlocks(oldDoc);
  const ops = diffSequences(ob.map(blockKey), nb.map(blockKey));
  const changed = [];
  let removed = [];
  const placeRemoved = (before) => {
    for (const el of removed) {
      const copy = newDoc.importNode(el, true);
      for (const nested of copy.querySelectorAll(BLOCK_SELECTOR)) nested.remove();
      copy.classList.add('revue-removed');
      if (before) before.before(copy);
      else if (nb.length) nb[nb.length - 1].after(copy);
      else newDoc.body.appendChild(copy);
      changed.push(copy);
    }
    removed = [];
  };
  for (const o of ops) {
    if (o.op === 'del') { removed.push(ob[o.a]); continue; }
    placeRemoved(nb[o.b]);
    if (o.op === 'add') { nb[o.b].classList.add('revue-added'); changed.push(nb[o.b]); }
  }
  placeRemoved(null);
  return changed;
}

const MARK_STYLE = `
.revue-added { background: rgba(46, 160, 67, 0.18) !important; box-shadow: inset 4px 0 0 #2ea043; }
.revue-removed { background: rgba(248, 81, 73, 0.15) !important; box-shadow: inset 4px 0 0 #f85149;
  text-decoration: line-through; text-decoration-color: rgba(248, 81, 73, 0.8); }
.revue-current { outline: 2px solid #58a6ff; outline-offset: 2px; }`;

// Scroll the frame's own viewport to `el` (scrollIntoView would also scroll
// the review page around the iframe).
function scrollFrameTo(doc, el, where = 'center') {
  const view = doc.defaultView;
  const top = el.getBoundingClientRect().top + view.scrollY;
  view.scrollTo(0, where === 'center' ? top - view.innerHeight / 3 : top - 8);
}

// srcdoc has no URL of its own, so the page's links resolve against revue's
// address.  Point them at the published document (`base`, for specs) so they
// read and open as there.  In-page anchors are tagged first so clicks still
// scroll the frame.  Images are left alone: loading them from the published
// site would show its version, not the reviewed commit's.
function pointLinksAt(doc, base) {
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (href.startsWith('#')) a.dataset.revueAnchor = decodeURIComponent(href.slice(1));
    if (base) { try { a.href = new URL(href, base).href; } catch { /* leave malformed links */ } }
  }
}

// Tagged anchors scroll the frame; links to another site open in a new tab.
// Anything that resolves to revue's own origin (a relative link with no
// published address) stays inert, and the frame never navigates away.
function wireLinks(doc) {
  doc.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    if (a.dataset.revueAnchor != null) {
      const target = doc.getElementById(a.dataset.revueAnchor);
      if (target) scrollFrameTo(doc, target, 'start');
      return;
    }
    const url = new URL(a.href);
    if (/^https?:$/.test(url.protocol) && url.origin !== window.location.origin) window.open(url.href, '_blank', 'noopener');
  });
}

// Per file (by hash + path): the fetched pages and where the reviewer was, so
// the frequent re-renders of the patch view don't refetch or jump back.
const views = new Map();

/**
 * Fill `container` with the rendered diff of `file` at commit `hash`
 * (`oldFile` on the parent side, for renames).
 */
export async function mountRichView(container, { hash, file, oldFile }) {
  const key = `${hash}:${file}`;
  let view = views.get(key);
  if (!view) {
    view = { data: null, cur: -1, scrollY: 0 };
    views.set(key, view);
  }
  if (!view.data) {
    container.innerHTML = '<div class="diff-revision-loading">Rendering…</div>';
    const q = new URLSearchParams({ hash, file, ...(oldFile && oldFile !== file && { oldFile }) });
    try {
      const res = await fetch(`api/rendered?${q}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      view.data = data;
    } catch (err) {
      const msg = Object.assign(document.createElement('div'), {
        className: 'diff-revision-loading rich-error', textContent: `Rendered view unavailable: ${err.message}`,
      });
      container.replaceChildren(msg);
      return;
    }
  }
  const { data } = view;

  const bar = document.createElement('div');
  bar.className = 'rich-bar';
  const label = document.createElement('span');
  label.className = 'rich-count';
  const prev = Object.assign(document.createElement('button'), { className: 'rich-nav', textContent: '‹', title: 'Previous change' });
  const next = Object.assign(document.createElement('button'), { className: 'rich-nav', textContent: '›', title: 'Next change' });
  bar.append(label, prev, next);

  const frame = document.createElement('iframe');
  frame.className = 'rich-frame';
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.title = `Rendered ${file}`;
  container.replaceChildren(bar, frame);

  frame.addEventListener('load', () => {
    const doc = frame.contentDocument;
    const win = doc.defaultView;
    const style = doc.createElement('style');
    style.textContent = MARK_STYLE;
    doc.head.appendChild(style);
    wireLinks(doc);
    // After marking, so removed blocks copied in from the old page get it too.
    const finish = () => { pointLinksAt(doc, data.base); win.scrollTo(0, view.scrollY); };
    win.addEventListener('scroll', () => { view.scrollY = win.scrollY; }, { passive: true });

    prev.hidden = next.hidden = true;
    if (!data.old || !data.new) {
      label.textContent = data.old ? 'Deleted file' : 'New file';
      if (!data.new) for (const el of diffBlocks(doc)) el.classList.add('revue-removed');
      finish();
      return;
    }
    const changed = markChanges(doc, new DOMParser().parseFromString(data.old, 'text/html'));
    if (changed.length === 0) {
      label.textContent = 'No rendered changes';
      finish();
      return;
    }
    label.textContent = `${changed.length} change${changed.length === 1 ? '' : 's'}`;
    prev.hidden = next.hidden = false;
    const go = (d) => {
      changed[view.cur]?.classList.remove('revue-current');
      view.cur = (view.cur + d + changed.length) % changed.length;
      changed[view.cur].classList.add('revue-current');
      scrollFrameTo(doc, changed[view.cur]);
    };
    prev.onclick = () => go(-1);
    next.onclick = () => go(1);
    pointLinksAt(doc, data.base);
    if (view.cur < 0) {
      go(1); // first open: jump to the first change
    } else {
      view.cur = Math.min(view.cur, changed.length - 1);
      changed[view.cur].classList.add('revue-current');
      win.scrollTo(0, view.scrollY);
    }
  }, { once: true });
  frame.srcdoc = data.new || data.old;
}

if (typeof module !== 'undefined') {
  module.exports = { diffBlocks, blockKey, diffSequences, markChanges, mountRichView };
}

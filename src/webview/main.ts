import * as toastui from '@toast-ui/editor';
import '@toast-ui/editor/dist/toastui-editor.css';
import html2pdf from 'html2pdf.js';

// Toast UI exposes the Editor class as a default (UMD) export.
const Editor: any = (toastui as any).default ?? (toastui as any).Editor ?? toastui;

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

let editor: any;
let applyingRemote = false;
let suppressChange = false;
let initializing = true;
// Only a genuine user input (typing/paste) may write back — so viewing or
// switching modes never dirties the file (and the tab closes without a prompt).
let userTyping = false;
let lastSent = '';
let frontmatter = '';
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

let currentMode: 'pretty' | 'markdown' = 'pretty';
let fontSize = 18;
let maxWidth = '80ch';
let exportFilename = 'document.pdf';

const $ = (id: string) => document.getElementById(id);

/** Split YAML frontmatter off the top so Toast UI never round-trips (and
 *  mangles) it. The frontmatter is preserved byte-for-byte. */
function splitFrontmatter(text: string): { fm: string; body: string } {
  const m = /^(---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?)/.exec(text);
  return m ? { fm: m[1], body: text.slice(m[1].length) } : { fm: '', body: text };
}

/** The full markdown the document should hold = preserved frontmatter + body. */
function currentMarkdown(): string {
  return frontmatter + (editor ? editor.getMarkdown() : '');
}

/** Runs `fn` without letting the resulting Toast 'change' post an edit (used
 *  for mode switches, which re-serialize but aren't user edits). */
function withSuppressed(fn: () => void): void {
  suppressChange = true;
  try {
    fn();
  } finally {
    setTimeout(() => {
      suppressChange = false;
    }, 60);
  }
}

function changeMode(m: 'markdown' | 'wysiwyg'): void {
  if (typeof editor?.changeMode === 'function') {
    editor.changeMode(m, true);
  } else if (typeof editor?.setMode === 'function') {
    editor.setMode(m);
  }
}

/** The element that actually scrolls in the current mode — used to keep the
 *  reading position across a Pretty↔Markdown switch (Toast otherwise jumps to
 *  the bottom of the page). */
function scrollableEditorEl(): HTMLElement | null {
  let el: HTMLElement | null = editorContentEl();
  while (el && el !== document.body) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 2) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

function setMode(mode: 'pretty' | 'markdown'): void {
  if (mode === currentMode) {
    return;
  }
  // Remember where we are so the switch doesn't jump to the bottom of the page.
  const before = scrollableEditorEl();
  const ratio =
    before && before.scrollHeight > before.clientHeight
      ? before.scrollTop / (before.scrollHeight - before.clientHeight)
      : 0;

  currentMode = mode;
  userTyping = false; // a mode switch is never a user edit
  document.querySelectorAll('#modeToggle button').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.mode === mode);
  });
  withSuppressed(() => {
    if (mode === 'markdown') {
      changeMode('markdown'); // raw Markdown source editing
      if (typeof editor?.changePreviewStyle === 'function') {
        editor.changePreviewStyle('tab'); // source-focused, no split preview
      }
    } else {
      changeMode('wysiwyg'); // Pretty = editable rendered view
    }
  });
  // The editable DOM is rebuilt — re-assert spellcheck and restore the position.
  setTimeout(() => {
    applySpellcheck(spellcheckOn);
    const after = scrollableEditorEl();
    if (after && after.scrollHeight > after.clientHeight) {
      after.scrollTop = ratio * (after.scrollHeight - after.clientHeight);
    }
  }, 0);
}

function applyFontSize(px: number): void {
  fontSize = px;
  let el = $('proser-fs') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'proser-fs';
    document.head.appendChild(el);
  }
  el.textContent =
    `.toastui-editor-contents{font-size:${px}px !important;}` +
    `.toastui-editor-md-container .toastui-editor,.toastui-editor-md-container .ProseMirror{font-size:${px}px !important;}`;
  const label = $('fontSize');
  if (label) {
    label.textContent = String(px);
  }
}

/** Caps the prose to a comfortable book measure and centers it in the pane —
 *  no page frame or border, just an even-guttered column. Width is best given
 *  in `ch` (characters per line — `80ch` is the generous book default; ~60–75
 *  is the print sweet spot) so the measure stays book-like as you zoom. Also
 *  accepts `px`/`rem`/`em`/`mm`/`cm`/`in`/`%`, or `none` for full width;
 *  anything unrecognized falls back to the `80ch` default. */
function applyMaxWidth(value: string): void {
  const raw = (value || '').trim().toLowerCase();
  const safe =
    raw === 'none' || raw === ''
      ? 'none'
      : /^\d+(\.\d+)?(ch|px|rem|em|mm|cm|in|%)$/.test(raw)
        ? raw
        : '80ch';
  maxWidth = safe;
  let el = $('proser-mw') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'proser-mw';
    document.head.appendChild(el);
  }
  if (safe === 'none') {
    el.textContent = ''; // full width — no column cap
    return;
  }
  // Center the text to a comfortable measure with SYMMETRIC PADDING rather than
  // max-width + auto margins. This keeps the editor's scroll area full-width, so
  // the scrollbar sits at the far right of the frame instead of beside the text.
  // A minimum gutter keeps breathing room on narrow panes. The footer is left
  // unconstrained on purpose — its stats/model sit at the frame's far edges.
  const gutter = `max(24px, calc((100% - ${safe}) / 2))`;
  el.textContent =
    `.toastui-editor-ww-container .toastui-editor-contents,` +
    `.toastui-editor-md-container .ProseMirror{` +
    `max-width:none !important;margin-left:0 !important;margin-right:0 !important;` +
    `padding-left:${gutter} !important;padding-right:${gutter} !important;` +
    `box-sizing:border-box;}`;
}

/** Shows the active AI model in the footer (within the page frame); click to switch. */
function renderModel(name: string): void {
  const el = $('model');
  if (!el) {
    return;
  }
  el.textContent = !name || name === 'off' ? '✦ AI: off' : '✦ ' + name;
  el.title = name === 'off' ? 'Set up an AI model' : `AI model: ${name} — click to switch`;
}

let spellcheckOn = true;

/** Reflects spell-check state on the toolbar toggle and (re)paints Proser's own
 *  inline squiggles. We disable the native contenteditable spellchecker — it
 *  doesn't render in VS Code webviews and would only risk duplicate underlines;
 *  our squiggles come from Proser's dictionary via the host. Re-run after the
 *  editor mounts since the ProseMirror nodes don't exist until then. */
function applySpellcheck(on: boolean): void {
  spellcheckOn = on;
  document.body.classList.toggle('spellcheck-on', on);
  document.querySelectorAll<HTMLElement>('.ProseMirror').forEach((node) => {
    node.setAttribute('spellcheck', 'false');
  });
  const btn = $('spellToggle');
  if (btn) {
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  paintMisspellings(); // repaint when on, clear when off
}

/** User flipped the toggle: update this view and tell the host to flip the
 *  `proser.spellcheck.enabled` setting (which also drives the Spelling sidebar). */
function toggleSpellcheck(): void {
  applySpellcheck(!spellcheckOn);
  vscode.postMessage({ type: 'toggleSpellcheck', enabled: spellcheckOn });
}

function changeFont(delta: number): void {
  const next = Math.max(12, Math.min(28, fontSize + delta));
  if (next !== fontSize) {
    applyFontSize(next);
    vscode.postMessage({ type: 'setFontSize', size: next });
  }
}

function abToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

async function exportPdf(): Promise<void> {
  if (!editor) {
    return;
  }
  const container = document.createElement('div');
  container.id = 'proser-pdf-export';
  container.className = 'toastui-editor-contents';
  container.style.cssText = 'padding:28px;width:800px;';
  container.innerHTML = editor.getHTML();

  // Force black-on-white for print — beats the id-less theme overrides
  // (`.toastui-editor-contents *`) via higher (id-based) specificity.
  const style = document.createElement('style');
  style.textContent =
    '#proser-pdf-export,#proser-pdf-export *{color:#111111 !important;background-color:transparent !important;border-color:#dddddd !important;}' +
    '#proser-pdf-export{background:#ffffff !important;}' +
    '#proser-pdf-export a{color:#0645ad !important;}' +
    '#proser-pdf-export code,#proser-pdf-export pre{background:#f4f4f4 !important;color:#111111 !important;}' +
    '#proser-pdf-export h1,#proser-pdf-export h2{border-bottom-color:#dddddd !important;}' +
    '#proser-pdf-export blockquote{border-left-color:#cccccc !important;color:#555555 !important;}';

  document.head.appendChild(style);
  document.body.appendChild(container);
  try {
    const opts = {
      margin: 10,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };
    const buf: ArrayBuffer = await (html2pdf() as any)
      .set(opts)
      .from(container)
      .outputPdf('arraybuffer');
    vscode.postMessage({ type: 'exportPdf', data: abToBase64(buf), filename: exportFilename });
  } catch (err) {
    vscode.postMessage({ type: 'exportError', message: String((err as Error)?.message ?? err) });
  } finally {
    container.remove();
    style.remove();
  }
}

function renderStats(s: any): void {
  const fmt = (n: number) => (n || 0).toLocaleString();
  const el = $('stats');
  if (el && s) {
    el.textContent =
      `${fmt(s.words)} words · ${fmt(s.characters)} chars · ${s.minutes} min read · ${fmt(s.lines)} lines`;
  }
}

// ---- Pretty-view context menu + anchored suggestion card ----
let pendingSelText = '';
let pendingSelection: any = null;
let pendingRect: DOMRect | null = null;
let pendingReviseText = '';
let pendingReviseInstruction = '';
let ctxMenu: HTMLElement | undefined;
let suggestCard: HTMLElement | undefined;
let reviseCard: HTMLElement | undefined;
let reviseStage: 'prompt' | 'manage' | 'results' | null = null;
let savedPrompts: Array<{ name: string; prompt: string }> = [];

function ensureMenu(): HTMLElement {
  if (ctxMenu) {
    return ctxMenu;
  }
  const menu = document.createElement('div');
  menu.id = 'proser-ctx';
  menu.innerHTML =
    '<div class="fmt">' +
    '<button data-fmt="bold" title="Bold (Ctrl+B)"><b>B</b></button>' +
    '<button data-fmt="italic" title="Italic (Ctrl+I)"><i>I</i></button>' +
    '<button data-fmt="underline" title="Underline (Ctrl+U)"><u>U</u></button>' +
    '<button data-fmt="strike" title="Strikethrough"><s>S</s></button>' +
    '<button data-fmt="code" title="Inline code">&lt;/&gt;</button>' +
    '</div>' +
    '<button data-act="synonyms">Synonyms</button>' +
    '<button data-act="antonyms">Antonyms</button>' +
    '<button data-act="revise">Revise with AI</button>';
  menu.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  menu.addEventListener('click', (e) => {
    e.stopPropagation(); // don't let this click reach the "click outside" closer
    const target = e.target as HTMLElement;
    // Formatting buttons (icons may wrap inner <b>/<i>/… so match the nearest).
    const fmtBtn = target.closest('[data-fmt]') as HTMLElement | null;
    if (fmtBtn) {
      applyFormat(fmtBtn.dataset.fmt || ''); // leave the menu open for chained toggles
      return;
    }
    const act = (target.closest('[data-act]') as HTMLElement | null)?.dataset.act;
    hideMenu();
    if (act === 'synonyms' || act === 'antonyms') {
      vscode.postMessage({
        type: 'thesaurusRequest',
        kind: act,
        word: pendingSelText,
        sentence: sentenceContext()
      });
    } else if (act === 'revise') {
      pendingReviseText = pendingSelText;
      showRevisePrompt('');
    }
  });
  document.body.appendChild(menu);
  ctxMenu = menu;
  return menu;
}

/** A single word — no internal whitespace and no hyphen — is the only thing the thesaurus can look up. */
function isSingleWord(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && !/[\s-]/.test(t);
}

function openMenu(x: number, y: number): void {
  const menu = ensureMenu();
  // Synonyms/Antonyms only make sense for a single word — disable them for
  // multi-word selections and hyphenated phrases. "Revise with AI" still works.
  const wordEligible = isSingleWord(pendingSelText);
  menu
    .querySelectorAll<HTMLButtonElement>('[data-act="synonyms"], [data-act="antonyms"]')
    .forEach((btn) => {
      btn.disabled = !wordEligible;
    });
  // Show first so it's measurable, then keep it inside the viewport: clamp to the
  // right edge, and flip it ABOVE the cursor when it would overflow the bottom
  // (e.g. selecting near the foot of the page). Done before paint, so no flash.
  menu.style.display = 'block';
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - mw - 8)) + 'px';
  menu.style.top = (y + mh > window.innerHeight - 8 ? Math.max(8, y - mh) : y) + 'px';
}
function hideMenu(): void {
  if (ctxMenu) {
    ctxMenu.style.display = 'none';
  }
}

/** Wraps the live selection with `before`/`after`, using the editor's CURRENT
 *  selection coordinates — so it works for both the menu and keyboard shortcuts
 *  (the menu preserves the selection via mousedown-preventDefault). */
function wrapSelection(before: string, after: string): void {
  const sel = typeof editor.getSelectedText === 'function' ? editor.getSelectedText() : '';
  if (!sel) {
    return;
  }
  let range: [number, number] | null = null;
  try {
    range = editor.getSelection();
  } catch {
    range = null;
  }
  const wrapped = before + sel + after;
  try {
    if (range) {
      editor.replaceSelection(wrapped, range[0], range[1]);
    } else {
      editor.replaceSelection(wrapped);
    }
  } catch {
    editor.replaceSelection(wrapped);
  }
}

/** Applies an inline format to the current selection. Bold/italic/strike/code
 *  use Toast's built-in commands (which toggle cleanly in the rendered view);
 *  underline has no Markdown form, so it wraps the selection in an `<u>` tag —
 *  one of Toast's supported inline-HTML marks. */
function applyFormat(cmd: string): void {
  if (!editor || !cmd) {
    return;
  }
  userTyping = true; // a real edit — let it sync to the document
  if (cmd === 'underline') {
    wrapSelection('<u>', '</u>');
  } else {
    try {
      editor.exec(cmd); // 'bold' | 'italic' | 'strike' | 'code'
    } catch {
      /* unknown command — ignore */
    }
  }
  scheduleRepaintSpell(); // text changed — re-anchor spelling squiggles
}

function sentenceContext(): string {
  const s = window.getSelection();
  const node = s && s.anchorNode;
  const el = node ? (node.nodeType === 3 ? node.parentElement : (node as HTMLElement)) : null;
  const full = el ? (el.textContent || '').trim() : '';
  const MAX = 500;
  if (full.length <= MAX) {
    return full;
  }
  // Long paragraph: keep a window centered on the looked-up word so its context
  // isn't truncated away before reaching the model.
  const at = pendingSelText ? full.toLowerCase().indexOf(pendingSelText.toLowerCase()) : -1;
  if (at < 0) {
    return full.slice(0, MAX);
  }
  const start = Math.max(0, at - Math.floor((MAX - pendingSelText.length) / 2));
  return full.slice(start, start + MAX);
}

function hideSuggestions(): void {
  if (suggestCard) {
    suggestCard.remove();
    suggestCard = undefined;
  }
}
function hideRevise(): void {
  if (reviseCard) {
    reviseCard.remove();
    reviseCard = undefined;
  }
  reviseStage = null;
}
function hideAll(): void {
  hideMenu();
  hideSuggestions();
  hideRevise();
}

/** Replaces the original selection with `text` (a synonym or a revision). Reads
 *  the editor's LIVE selection at apply time — for a word detected under the
 *  pointer, the selection syncs into the editor asynchronously, so coordinates
 *  captured at right-click can be stale and would insert the fix beside the word
 *  instead of replacing it. The cards keep that selection alive (mousedown
 *  preventDefault). Falls back to the captured selection if the live read fails. */
function applyReplacement(text: string): void {
  if (!editor) {
    return;
  }
  userTyping = true; // a real edit — let it sync to the document
  let range = pendingSelection;
  try {
    const live = editor.getSelection();
    if (live) {
      range = live;
    }
  } catch {
    /* keep the captured selection */
  }
  try {
    if (range) {
      editor.replaceSelection(text, range[0], range[1]);
    } else {
      editor.replaceSelection(text);
    }
  } catch {
    editor.replaceSelection(text);
  }
  pendingSelection = null;
  hideAll();
}

/** Positions a popup card just below the word/passage (or above if it'd overflow). */
function positionCard(card: HTMLElement, rect: DOMRect | null): void {
  if (!rect) {
    card.style.left = '40px';
    card.style.top = '60px';
    return;
  }
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - card.offsetWidth - 8));
  let top = rect.bottom + 6;
  if (top + card.offsetHeight > window.innerHeight - 8) {
    top = Math.max(8, rect.top - card.offsetHeight - 6);
  }
  card.style.left = left + 'px';
  card.style.top = top + 'px';
}

/** Anchored card under the word: top 3 colored options + More + Reject all. */
function showSuggestions(words: string[], word: string, source?: string): void {
  hideSuggestions();
  const TOP = 3;
  const card = document.createElement('div');
  card.id = 'proser-suggest';
  card.addEventListener('mousedown', (e) => e.preventDefault()); // keep the word selected

  const title = document.createElement('div');
  title.className = 'psg-title';
  title.textContent = source ? `Replace “${word}”  ·  ${source}` : `Replace “${word}”`;
  card.appendChild(title);

  const makeOpt = (w: string, cls: string) => {
    const b = document.createElement('button');
    b.className = 'psg-opt ' + cls;
    b.textContent = w;
    b.addEventListener('click', () => applyReplacement(w));
    return b;
  };

  const top = document.createElement('div');
  top.className = 'psg-options';
  words.slice(0, TOP).forEach((w, i) => top.appendChild(makeOpt(w, 'c' + i)));
  card.appendChild(top);

  const more = document.createElement('div');
  more.className = 'psg-more';
  words.slice(TOP).forEach((w) => more.appendChild(makeOpt(w, 'cx')));
  card.appendChild(more);

  const actions = document.createElement('div');
  actions.className = 'psg-actions';
  if (words.length > TOP) {
    const moreBtn = document.createElement('button');
    moreBtn.className = 'psg-link';
    moreBtn.textContent = `More options (${words.length - TOP})`;
    moreBtn.addEventListener('click', () => {
      more.style.display = 'flex';
      moreBtn.style.display = 'none';
    });
    actions.appendChild(moreBtn);
  }
  const reject = document.createElement('button');
  reject.className = 'psg-link';
  reject.textContent = 'Reject all';
  reject.addEventListener('click', hideSuggestions);
  actions.appendChild(reject);
  card.appendChild(actions);

  document.body.appendChild(card);
  suggestCard = card;
  positionCard(card, pendingRect);
}

/** Small DOM helper. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** Creates the revise card shell with a header (title + right-side actions). */
function reviseShell(titleText: string): { card: HTMLElement; actions: HTMLElement } {
  hideRevise();
  const card = el('div');
  card.id = 'proser-revise';
  const head = el('div', 'prv-head');
  head.appendChild(el('span', 'prv-title', titleText));
  const actions = el('div', 'prv-actions');
  head.appendChild(actions);
  const close = el('button', 'prv-close', '✕');
  close.title = 'Close';
  close.addEventListener('click', () => hideRevise());
  head.appendChild(close);
  card.appendChild(head);
  // Clicks inside the card (incl. buttons that rebuild it into another stage)
  // must not reach the document "click outside" closer.
  card.addEventListener('click', (e) => e.stopPropagation());
  document.body.appendChild(card);
  reviseCard = card;
  return { card, actions };
}

function link(label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'psg-link', label);
  b.addEventListener('click', onClick);
  return b;
}

/** Sends the revision request with the chosen instruction; results replace this. */
function runRevise(instruction: string): void {
  if (!pendingReviseText) {
    return;
  }
  pendingReviseInstruction = instruction.trim();
  hideRevise();
  vscode.postMessage({
    type: 'reviseRequest',
    text: pendingReviseText,
    instruction: pendingReviseInstruction
  });
}

/** Renders the quick-slot chips into `slots` (re-used on prompt updates). */
function renderSlots(slots: HTMLElement): void {
  slots.textContent = '';
  if (savedPrompts.length === 0) {
    slots.appendChild(el('div', 'prv-empty', 'No saved prompts yet — write one above and Save it.'));
    return;
  }
  for (const p of savedPrompts) {
    const chip = el('button', 'prv-chip', p.name);
    chip.title = p.prompt;
    chip.addEventListener('click', () => runRevise(p.prompt));
    slots.appendChild(chip);
  }
}

/** Stage 1 — the prompt input under the selection: instruction + quick slots. */
function showRevisePrompt(prefill: string): void {
  const { card, actions } = reviseShell('Revise');
  reviseStage = 'prompt';
  actions.appendChild(link('Manage', () => showReviseManage()));

  const ta = el('textarea', 'prv-input') as HTMLTextAreaElement;
  ta.placeholder = 'Describe the change… (or pick a saved prompt below)';
  ta.value = prefill;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      runRevise(ta.value);
    }
  });
  card.appendChild(ta);

  const runrow = el('div', 'prv-runrow');
  runrow.appendChild(el('span', 'prv-hint', '⏎ to run · ⇧⏎ for a new line'));
  const run = el('button', 'prv-run', 'Revise');
  run.addEventListener('click', () => runRevise(ta.value));
  runrow.appendChild(run);
  card.appendChild(runrow);

  const slotsHead = el('div', 'prv-slots-label');
  slotsHead.style.display = 'flex';
  slotsHead.style.justifyContent = 'space-between';
  slotsHead.style.alignItems = 'center';
  slotsHead.appendChild(el('span', undefined, 'Quick prompts'));
  slotsHead.appendChild(link('＋ Save current', () => showReviseManage(ta.value.trim())));
  card.appendChild(slotsHead);

  const slots = el('div', 'prv-slots');
  renderSlots(slots);
  card.appendChild(slots);

  positionCard(card, pendingRect);
  ta.focus();
}

/** Stage 2 — manage (CRUD) the saved prompts. `seedText` pre-fills a new row. */
function showReviseManage(seedText?: string): void {
  const { card, actions } = reviseShell('Manage prompts');
  reviseStage = 'manage';
  actions.appendChild(link('Cancel', () => showRevisePrompt('')));

  const list = el('div', 'prv-manage');
  const addRow = (name: string, prompt: string, focusName = false) => {
    const row = el('div', 'prv-mrow');
    const nameI = el('input', 'prv-mname') as HTMLInputElement;
    nameI.type = 'text';
    nameI.placeholder = 'Name';
    nameI.value = name;
    const textI = el('textarea', 'prv-mtext') as HTMLTextAreaElement;
    textI.placeholder = 'Prompt instruction…';
    textI.value = prompt;
    const del = el('button', 'prv-del', '✕');
    del.title = 'Delete';
    del.addEventListener('click', () => row.remove());
    row.appendChild(nameI);
    row.appendChild(textI);
    row.appendChild(del);
    list.appendChild(row);
    if (focusName) {
      nameI.focus();
    }
  };
  for (const p of savedPrompts) {
    addRow(p.name, p.prompt);
  }
  if (seedText) {
    addRow('', seedText, true);
  }
  card.appendChild(list);

  const add = el('button', 'prv-add', '＋ Add prompt');
  add.addEventListener('click', () => addRow('', '', true));
  card.appendChild(add);

  const runrow = el('div', 'prv-runrow');
  runrow.appendChild(link('Cancel', () => showRevisePrompt('')));
  const save = el('button', 'prv-run', 'Save');
  save.addEventListener('click', () => {
    const next: Array<{ name: string; prompt: string }> = [];
    list.querySelectorAll('.prv-mrow').forEach((row) => {
      const name = (row.querySelector('.prv-mname') as HTMLInputElement)?.value.trim() ?? '';
      const prompt = (row.querySelector('.prv-mtext') as HTMLTextAreaElement)?.value.trim() ?? '';
      if (name && prompt) {
        next.push({ name, prompt });
      }
    });
    savedPrompts = next; // optimistic; host echoes the sanitized list back
    vscode.postMessage({ type: 'promptsSave', prompts: next });
    showRevisePrompt('');
  });
  runrow.appendChild(save);
  card.appendChild(runrow);

  positionCard(card, pendingRect);
}

/** Stage 3 — the revision results: options with Accept, plus retry controls. */
function showRevise(options: string[]): void {
  const { card, actions } = reviseShell(
    `Revise — ${options.length} option${options.length > 1 ? 's' : ''}`
  );
  reviseStage = 'results';
  actions.appendChild(link('Edit prompt', () => showRevisePrompt(pendingReviseInstruction)));
  actions.appendChild(link('More options', () => runRevise(pendingReviseInstruction)));
  actions.appendChild(link('Reject all', hideRevise));

  options.forEach((opt, i) => {
    const row = el('div', 'prv-opt c' + (i % 3));
    row.appendChild(el('div', 'prv-text', opt));
    const accept = el('button', 'prv-accept', 'Accept');
    accept.addEventListener('click', () => applyReplacement(opt));
    row.appendChild(accept);
    card.appendChild(row);
  });

  positionCard(card, pendingRect);
}

document.addEventListener('click', (e) => {
  hideMenu();
  const t = e.target as Node;
  if (suggestCard && !suggestCard.contains(t)) {
    hideSuggestions();
  }
  // The Revise card stays open on outside clicks (it's a multi-step flow with a
  // text input) — close it explicitly with the ✕, "Reject all", or Escape.
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideAll();
  }
});
window.addEventListener('blur', hideMenu);

function initEditor(fullText: string): void {
  const { fm, body } = splitFrontmatter(fullText);
  frontmatter = fm;
  editor = new Editor({
    el: $('editor'),
    initialEditType: 'wysiwyg',
    previewStyle: 'vertical',
    initialValue: body,
    usageStatistics: false,
    hideModeSwitch: true,
    toolbarItems: [],
    height: '100%'
  });
  lastSent = currentMarkdown();

  // Mark genuine user edits; arrow keys / focus / programmatic changes don't
  // fire 'input', so they never set this.
  const editorEl = $('editor');
  if (editorEl) {
    editorEl.addEventListener('input', () => (userTyping = true), true);
    editorEl.addEventListener('paste', () => (userTyping = true), true);
    // Right-click on a selection → Proser menu; no selection → native menu.
    editorEl.addEventListener(
      'contextmenu',
      (e: MouseEvent) => {
        if (currentMode !== 'pretty' || !editor) {
          return;
        }
        const sel = typeof editor.getSelectedText === 'function' ? editor.getSelectedText() : '';
        const selTrim = (sel || '').trim();

        // Spelling first: right-click on a flagged word (selected, or just under
        // the pointer) → suggestions + Add to dictionary.
        if (spellcheckOn && misspelledWords.size > 0) {
          let word = '';
          let range: Range | null = null;
          if (selTrim && isSingleWord(selTrim) && misspelledWords.has(selTrim)) {
            const ds = window.getSelection();
            word = selTrim;
            range = ds && ds.rangeCount ? ds.getRangeAt(0) : null;
          } else {
            const hit = wordRangeAtPoint(e.clientX, e.clientY);
            if (hit && misspelledWords.has(hit.word)) {
              word = hit.word;
              range = hit.range;
            }
          }
          if (word && range) {
            e.preventDefault();
            hideMenu();
            // Select the word so a chosen suggestion replaces exactly it.
            const ds = window.getSelection();
            if (ds) {
              ds.removeAllRanges();
              ds.addRange(range);
            }
            pendingSelText = word;
            try {
              pendingSelection = editor.getSelection();
            } catch {
              pendingSelection = null;
            }
            pendingRect = range.getBoundingClientRect();
            showSpellCard(word, spellSuggestions.get(word) ?? []);
            return;
          }
        }

        if (!selTrim) {
          // No selection — use the word under the pointer, so you can right-click
          // a word for synonyms/antonyms (and revise/format) without selecting it.
          const hit = wordRangeAtPoint(e.clientX, e.clientY);
          if (!hit || !hit.word) {
            hideMenu();
            return; // not on a word → let the native menu show
          }
          e.preventDefault();
          const ds = window.getSelection();
          if (ds) {
            ds.removeAllRanges();
            ds.addRange(hit.range); // select the word so the menu's actions target it
          }
          pendingSelText = hit.word;
          try {
            pendingSelection = editor.getSelection();
          } catch {
            pendingSelection = null;
          }
          pendingRect = hit.range.getBoundingClientRect();
          openMenu(e.clientX, e.clientY);
          return;
        }
        e.preventDefault();
        pendingSelText = selTrim;
        try {
          pendingSelection = editor.getSelection();
        } catch {
          pendingSelection = null;
        }
        const domSel = window.getSelection();
        pendingRect = domSel && domSel.rangeCount ? domSel.getRangeAt(0).getBoundingClientRect() : null;
        openMenu(e.clientX, e.clientY);
      },
      true
    );
  }

  editor.on('change', () => {
    scheduleRepaintSpell(); // keep squiggles aligned to the edited text
    if (applyingRemote || initializing || suppressChange || !userTyping) {
      lastSent = currentMarkdown();
      return;
    }
    userTyping = false;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      const md = currentMarkdown();
      if (md === lastSent) {
        return;
      }
      lastSent = md;
      vscode.postMessage({ type: 'edit', text: md });
    }, 300);
  });

  applySpellcheck(spellcheckOn); // ProseMirror nodes exist now — set the attribute

  setTimeout(() => {
    initializing = false;
  }, 400);
}

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data;
  if (!msg) {
    return;
  }
  if (msg.type === 'update') {
    const fullText: string = msg.text ?? '';
    if (!editor) {
      initEditor(fullText);
    } else if (fullText !== currentMarkdown()) {
      const { fm, body } = splitFrontmatter(fullText);
      applyingRemote = true;
      frontmatter = fm;
      editor.setMarkdown(body, false);
      lastSent = currentMarkdown();
      applyingRemote = false;
      scheduleRepaintSpell(); // content replaced — re-anchor squiggles
    }
    if (pendingReveal) {
      const t = pendingReveal;
      pendingReveal = '';
      setTimeout(() => revealText(t), 150); // let Toast finish rendering first
    }
  } else if (msg.type === 'reveal') {
    revealText(typeof msg.text === 'string' ? msg.text : '');
  } else if (msg.type === 'insertHr') {
    if (editor) {
      userTyping = true;
      try {
        editor.exec('hr'); // a real horizontal rule at the cursor
      } catch {
        /* ignore */
      }
      scheduleRepaintSpell();
    }
  } else if (msg.type === 'insertText') {
    if (editor && typeof msg.text === 'string') {
      userTyping = true;
      try {
        editor.replaceSelection(msg.text);
      } catch {
        /* ignore */
      }
      scheduleRepaintSpell();
    }
  } else if (msg.type === 'replaceSelection') {
    if (editor && typeof msg.text === 'string') {
      userTyping = true; // a genuine edit — let it sync to the document
      try {
        if (pendingSelection) {
          editor.replaceSelection(msg.text, pendingSelection[0], pendingSelection[1]);
        } else {
          editor.replaceSelection(msg.text);
        }
      } catch {
        editor.replaceSelection(msg.text);
      }
      pendingSelection = null;
    }
  } else if (msg.type === 'thesaurusResult') {
    if (Array.isArray(msg.words) && msg.words.length > 0) {
      showSuggestions(msg.words, msg.word ?? pendingSelText, msg.source);
    }
  } else if (msg.type === 'reviseResult') {
    if (Array.isArray(msg.options) && msg.options.length > 0) {
      showRevise(msg.options);
    }
  } else if (msg.type === 'promptsResult') {
    savedPrompts = Array.isArray(msg.prompts) ? msg.prompts : [];
    if (reviseStage === 'prompt' && reviseCard) {
      const slots = reviseCard.querySelector('.prv-slots') as HTMLElement | null;
      if (slots) {
        renderSlots(slots); // refresh chips in place, keep any typed text
      }
    }
  } else if (msg.type === 'doQuickPdf') {
    void exportPdf(); // "Quick PDF (current view)" chosen from the Export menu
  } else if (msg.type === 'spellResult') {
    const words: Array<{ word: string; suggestions: string[] }> = Array.isArray(msg.words)
      ? msg.words
      : [];
    misspelledWords = new Set(words.map((w) => w.word));
    spellSuggestions = new Map(words.map((w) => [w.word, w.suggestions || []]));
    paintMisspellings();
  } else if (msg.type === 'stats') {
    renderStats(msg.stats);
  } else if (msg.type === 'config') {
    if (msg.filename) {
      exportFilename = msg.filename;
    }
    if (typeof msg.fontSize === 'number') {
      applyFontSize(msg.fontSize);
    }
    if (typeof msg.maxWidth === 'string') {
      applyMaxWidth(msg.maxWidth);
    }
    if (typeof msg.spellcheckEnabled === 'boolean') {
      applySpellcheck(msg.spellcheckEnabled);
    }
    if (typeof msg.model === 'string') {
      renderModel(msg.model);
    }
  }
});

// ---- Find (Ctrl/Cmd+F) ----
// Matches are painted with the CSS Custom Highlight API so the find input keeps
// focus the whole time (window.find() would move the selection into the
// contenteditable and steal focus — and risk the next keystroke editing the doc).
const FIND_SUPPORTED = typeof CSS !== 'undefined' && 'highlights' in (CSS as any);
let findMatches: Range[] = [];
let findIndex = 0;

/** The element holding the currently-visible editable text. */
function editorContentEl(): HTMLElement | null {
  const sel =
    currentMode === 'markdown'
      ? '.toastui-editor-md-container .ProseMirror'
      : '.toastui-editor-ww-container .ProseMirror';
  return document.querySelector<HTMLElement>(sel) ?? ($('editor') as HTMLElement | null);
}

/** Ranges for every case-insensitive occurrence of `query` in the visible text. */
function collectMatches(query: string): Range[] {
  const root = editorContentEl();
  const ranges: Range[] = [];
  if (!root || !query) {
    return ranges;
  }
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue || '').toLowerCase();
    let at = text.indexOf(needle);
    while (at !== -1) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
      at = text.indexOf(needle, at + needle.length);
    }
  }
  return ranges;
}

function paintHighlights(): void {
  if (!FIND_SUPPORTED) {
    return;
  }
  const reg = (CSS as any).highlights as Map<string, unknown>;
  reg.delete('proser-find');
  reg.delete('proser-find-current');
  if (findMatches.length === 0) {
    return;
  }
  const others = findMatches.filter((_, i) => i !== findIndex);
  if (others.length) {
    reg.set('proser-find', new (window as any).Highlight(...others));
  }
  reg.set('proser-find-current', new (window as any).Highlight(findMatches[findIndex]));
}

function scrollToCurrent(): void {
  findMatches[findIndex]?.startContainer.parentElement?.scrollIntoView({ block: 'center' });
}

function clearHighlights(): void {
  if (FIND_SUPPORTED) {
    const reg = (CSS as any).highlights as Map<string, unknown>;
    reg.delete('proser-find');
    reg.delete('proser-find-current');
  }
  findMatches = [];
  findIndex = 0;
}

function fallbackCount(query: string): number {
  const text = (editorContentEl()?.textContent || '').toLowerCase();
  return query ? text.split(query.toLowerCase()).length - 1 : 0;
}

function updateFindCount(query: string): void {
  const count = $('findCount');
  if (!count) {
    return;
  }
  if (!query) {
    count.textContent = '';
  } else if (FIND_SUPPORTED) {
    count.textContent = findMatches.length ? `${findIndex + 1} of ${findMatches.length}` : 'No results';
  } else {
    const n = fallbackCount(query);
    count.textContent = n ? `${n} match${n > 1 ? 'es' : ''}` : 'No results';
  }
}

/** Recomputes matches for the query (called as the user types — never steals focus). */
function refreshFind(query: string): void {
  if (FIND_SUPPORTED) {
    findMatches = collectMatches(query);
    findIndex = 0;
    paintHighlights();
    if (findMatches.length) {
      scrollToCurrent();
    }
  }
  updateFindCount(query);
}

/** Advance to the next/previous match (Enter or the ↑/↓ buttons). */
function gotoMatch(delta: number): void {
  const input = $('findInput') as HTMLInputElement | null;
  const query = input?.value ?? '';
  if (FIND_SUPPORTED) {
    if (findMatches.length === 0) {
      return;
    }
    findIndex = (findIndex + delta + findMatches.length) % findMatches.length;
    paintHighlights();
    scrollToCurrent();
    updateFindCount(query);
  } else if (query) {
    // Fallback (no Highlight API): the browser's own find, then restore input focus.
    try {
      (window as any).find(query, false, delta < 0, true, false, false, false);
    } catch {
      /* unsupported */
    }
    input?.focus();
  }
}

function openFind(): void {
  const bar = $('proser-find');
  const input = $('findInput') as HTMLInputElement | null;
  if (!bar || !input) {
    return;
  }
  bar.style.display = 'flex';
  input.focus();
  input.select();
  if (input.value) {
    refreshFind(input.value);
  }
}
function closeFind(): void {
  const bar = $('proser-find');
  if (bar) {
    bar.style.display = 'none';
  }
  clearHighlights();
  if (editor && typeof editor.focus === 'function') {
    editor.focus();
  }
}
function wireFind(): void {
  const input = $('findInput') as HTMLInputElement | null;
  if (!input) {
    return;
  }
  input.addEventListener('input', () => refreshFind(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      gotoMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
    }
  });
  $('findNext')?.addEventListener('click', () => {
    gotoMatch(1);
    input.focus();
  });
  $('findPrev')?.addEventListener('click', () => {
    gotoMatch(-1);
    input.focus();
  });
  $('findClose')?.addEventListener('click', closeFind);
}

document.addEventListener(
  'keydown',
  (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      openFind();
    }
  },
  true
);

// Formatting shortcuts — Ctrl-based on every platform so Cmd+B stays VS Code's
// sidebar toggle on macOS. Ctrl+B/I/U → bold/italic/underline. Capture phase +
// stopPropagation so Toast's own Mod-b/Mod-i don't ALSO fire (double-toggle) and
// VS Code doesn't grab the keys.
document.addEventListener(
  'keydown',
  (e) => {
    if (currentMode !== 'pretty' || !editor) {
      return;
    }
    if (!e.ctrlKey || e.metaKey || e.altKey) {
      return; // Ctrl only
    }
    const wrap = $('editor');
    if (wrap && !wrap.contains(e.target as Node)) {
      return; // only while editing the Pretty content (not the Find / Revise inputs)
    }
    let handled = true;
    switch (e.key) {
      case 'b':
      case 'B':
        applyFormat('bold');
        break;
      case 'i':
      case 'I':
        applyFormat('italic');
        break;
      case 'u':
      case 'U':
        applyFormat('underline');
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true
);

// ---- Reveal a passage (the sidebar checker's "Go") ----
// The host posts a sentence; we scroll to it and flash a highlight — reusing the
// Find matcher + CSS Highlight API. Queued until the editor content is ready.
let pendingReveal = '';
let revealTimer: ReturnType<typeof setTimeout> | undefined;
function revealText(text: string): void {
  const q = (text || '').trim();
  if (!q) {
    return;
  }
  if (!editor || !editorContentEl()) {
    pendingReveal = q;
    return;
  }
  // Match a leading snippet — sentences can be long or span inline formatting.
  const ranges = collectMatches(q.slice(0, 60));
  if (ranges.length === 0) {
    return;
  }
  const range = ranges[0];
  range.startContainer.parentElement?.scrollIntoView({ block: 'center' });
  if (FIND_SUPPORTED) {
    const reg = (CSS as any).highlights as Map<string, unknown>;
    reg.set('proser-reveal', new (window as any).Highlight(range));
    if (revealTimer) {
      clearTimeout(revealTimer);
    }
    revealTimer = setTimeout(() => reg.delete('proser-reveal'), 2500);
  }
}

// ---- Inline spelling squiggles (Proser's engine; CSS Custom Highlight API) ----
// The host sends the set of misspelled words; we underline every occurrence in
// the visible text without mutating ProseMirror's DOM — same approach as Find.
let misspelledWords = new Set<string>();
let spellSuggestions = new Map<string, string[]>();
let spellRepaintTimer: ReturnType<typeof setTimeout> | undefined;
const WORD_RE = /[\p{L}][\p{L}'’-]*/gu;

/** Ranges for every occurrence of a flagged word in the visible text. */
function collectMisspellingRanges(): Range[] {
  const root = editorContentEl();
  const ranges: Range[] = [];
  if (!root || misspelledWords.size === 0) {
    return ranges;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue || '';
    WORD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD_RE.exec(text))) {
      if (misspelledWords.has(m[0])) {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        ranges.push(range);
      }
    }
  }
  return ranges;
}

/** Paints (or clears) the misspelling highlight over the current view. */
function paintMisspellings(): void {
  if (!FIND_SUPPORTED) {
    return;
  }
  const reg = (CSS as any).highlights as Map<string, unknown>;
  reg.delete('proser-misspell');
  if (!spellcheckOn || misspelledWords.size === 0) {
    return;
  }
  const ranges = collectMisspellingRanges();
  if (ranges.length) {
    reg.set('proser-misspell', new (window as any).Highlight(...ranges));
  }
}

/** Debounced repaint — keeps squiggles aligned while typing, before the host's
 *  next spellResult arrives. */
function scheduleRepaintSpell(): void {
  if (spellRepaintTimer) {
    clearTimeout(spellRepaintTimer);
  }
  spellRepaintTimer = setTimeout(paintMisspellings, 150);
}

/** The word (and its DOM range) under a screen point, for right-click spelling. */
function wordRangeAtPoint(x: number, y: number): { word: string; range: Range } | null {
  const caret = (document as any).caretRangeFromPoint?.(x, y) as Range | undefined;
  const node = caret?.startContainer;
  if (!node || node.nodeType !== 3) {
    return null;
  }
  const text = node.nodeValue || '';
  const isWord = (c: string) => !!c && /[\p{L}'’-]/u.test(c);
  let s = caret!.startOffset;
  let e = s;
  while (s > 0 && isWord(text[s - 1])) {
    s--;
  }
  while (e < text.length && isWord(text[e])) {
    e++;
  }
  if (e <= s) {
    return null;
  }
  const range = document.createRange();
  range.setStart(node, s);
  range.setEnd(node, e);
  return { word: text.slice(s, e), range };
}

/** Anchored card for a misspelled word: suggestions + Add to dictionary. */
function showSpellCard(word: string, suggestions: string[]): void {
  hideSuggestions();
  const card = el('div');
  card.id = 'proser-suggest';
  card.addEventListener('mousedown', (e) => e.preventDefault()); // keep the word selected
  card.appendChild(el('div', 'psg-title', `“${word}” — misspelled`));

  const opts = el('div', 'psg-options');
  if (suggestions.length === 0) {
    opts.appendChild(el('div', 'prv-empty', 'No suggestions'));
  } else {
    suggestions.slice(0, 8).forEach((w, i) => {
      const b = el('button', 'psg-opt c' + (i % 3), w);
      b.addEventListener('click', () => applyReplacement(w));
      opts.appendChild(b);
    });
  }
  card.appendChild(opts);

  const actions = el('div', 'psg-actions');
  const add = el('button', 'psg-link', '＋ Add to dictionary');
  add.addEventListener('click', () => {
    vscode.postMessage({ type: 'addToDictionary', word });
    hideSuggestions();
  });
  const dismiss = el('button', 'psg-link', 'Dismiss');
  dismiss.addEventListener('click', hideSuggestions);
  actions.appendChild(add);
  actions.appendChild(dismiss);
  card.appendChild(actions);

  document.body.appendChild(card);
  suggestCard = card;
  positionCard(card, pendingRect);
}

// Wire toolbar controls.
document.querySelectorAll('#modeToggle button').forEach((b) => {
  b.addEventListener('click', () => setMode((b as HTMLElement).dataset.mode as any));
});
$('spellToggle')?.addEventListener('click', toggleSpellcheck);
$('model')?.addEventListener('click', () => vscode.postMessage({ type: 'selectModel' }));
$('fontMinus')?.addEventListener('click', () => changeFont(-1));
$('fontPlus')?.addEventListener('click', () => changeFont(1));
$('issuesBtn')?.addEventListener('click', () => vscode.postMessage({ type: 'showIssues' }));
$('exportBtn')?.addEventListener('click', () => vscode.postMessage({ type: 'exportMenu' }));
wireFind();

applyFontSize(fontSize);
applyMaxWidth(maxWidth);
vscode.postMessage({ type: 'ready' });
vscode.postMessage({ type: 'promptsLoad' });

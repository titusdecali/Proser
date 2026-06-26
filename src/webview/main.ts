import * as toastui from '@toast-ui/editor';
import '@toast-ui/editor/dist/toastui-editor.css';
import html2pdf from 'html2pdf.js';
import { onHostMessage } from './messaging';
import { HostToWebviewType } from './protocol';
import { splitFrontmatter, blockifyComments } from './proseText';

// Toast UI exposes the Editor class as a default (UMD) export.
const Editor: any = (toastui as any).default ?? (toastui as any).Editor ?? toastui;

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

let editor: any;
let applyingRemote = false;
let suppressChange = false;
let initializing = true;
// Set true once the document is rendered and visible. Until then NO checks
// (spell/grammar/tense/passive/spacing) run, so opening a file never waits on one.
let displayed = false;
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

/** Reflects `currentMode` on the toolbar toggle so the highlighted button always
 *  matches what's actually shown — including when the WYSIWYG fallback silently
 *  drops us into Markdown source mode (otherwise "Pretty" stays lit over raw
 *  markdown, which reads like both modes are open at once). */
function syncModeButtons(): void {
  document.querySelectorAll('#modeToggle button').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.mode === currentMode);
  });
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
  syncModeButtons();
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
  paintGrammar();
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

// ---- "N words selected" beside the stats (blue) ----
// Shows the selected word count while text is selected in the editor; hidden when
// nothing (or only a single word) is selected.
function selectedWordCount(): number {
  let text = '';
  try {
    if (editor && typeof editor.getSelectedText === 'function') {
      text = editor.getSelectedText() || '';
    }
  } catch {
    /* fall through to the DOM selection */
  }
  if (!text) {
    const ds = window.getSelection();
    text = ds ? ds.toString() : '';
  }
  return (text.match(/\S+/g) || []).length;
}
function updateSelectionStats(): void {
  const el = $('selStats');
  if (!el) {
    return;
  }
  const n = selectedWordCount();
  // Only when MORE THAN ONE word is selected (a single word / caret shows nothing).
  el.textContent = n > 1 ? `· ${n.toLocaleString()} words selected` : '';
}
let selStatsTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSelectionStats(): void {
  if (selStatsTimer) {
    clearTimeout(selStatsTimer);
  }
  selStatsTimer = setTimeout(updateSelectionStats, 80); // coalesce drag/selection churn
}

// ---- Em-dash auto-convert: "--" → "—", and a third dash reverts "—-" → "---" ----
// Works in both Pretty (ProseMirror) and Markdown (CodeMirror) via Toast UI's
// replaceSelection. The revert means typing three dashes yields "---", so markdown
// frontmatter / horizontal rules / table separators are preserved.
let emDashBusy = false;
function autoEmDash(): void {
  if (emDashBusy || !editor) {
    return;
  }
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || !sel.anchorNode || sel.anchorNode.nodeType !== Node.TEXT_NODE) {
    return;
  }
  const off = sel.anchorOffset;
  if (off < 2) {
    return;
  }
  const text = sel.anchorNode.textContent || '';
  const pair = text.slice(off - 2, off);
  let replacement = '';
  if (pair === '—-') {
    replacement = '---'; // third dash → put the three hyphens back
  } else if (pair === '--' && text[off - 3] !== '-') {
    replacement = '—'; // two hyphens → em dash (not when extending a longer run)
  } else {
    return;
  }
  let range: [number, number] | [number[], number[]] | undefined;
  try {
    range = editor.getSelection();
  } catch {
    return;
  }
  const end = range?.[1];
  if (end == null) {
    return;
  }
  emDashBusy = true;
  try {
    if (Array.isArray(end)) {
      editor.replaceSelection(replacement, [end[0], end[1] - 2], end); // markdown [line, ch]
    } else {
      editor.replaceSelection(replacement, end - 2, end); // wysiwyg numeric position
    }
  } catch {
    /* leave the dashes as typed on any failure */
  } finally {
    emDashBusy = false;
  }
}

// ---- AI model status (bottom-right of the frame) ----
// Ref-counted per model tag so overlapping passes (e.g. spell + revise on the same
// model) don't clear each other's "processing" pulse.
const aiBusyCounts: Record<string, number> = {};
function roleWord(r: string): string {
  return r === 'write' ? 'Brainstorm & Revise' : r === 'spell' ? 'Spell check' : r === 'synonyms' ? 'Synonyms' : r;
}
function applyAiBusyClasses(el: HTMLElement): void {
  el.querySelectorAll('.aichip').forEach((c) => {
    const tag = (c as HTMLElement).dataset.tag || '';
    c.classList.toggle('busy', (aiBusyCounts[tag] || 0) > 0);
  });
}
function renderAiStatus(chips: Array<{ tag: string; label: string; roles: string[]; kind: string }>): void {
  const el = $('aiStatus');
  if (!el) {
    return;
  }
  el.innerHTML = '';
  for (const c of chips || []) {
    const chip = document.createElement('span');
    chip.className = 'aichip kind-' + (c.kind === 'dictionary' ? 'dictionary' : 'ai');
    chip.dataset.tag = c.tag || '';
    const roles = (c.roles || []).map(roleWord).join(' · ');
    chip.title =
      c.kind === 'dictionary'
        ? 'Spell check: dictionary only (no AI clearing). Set the Spell Check model to a capable model (or "Use my editor model") to clear names, coined words, and sounds.'
        : `${c.label} — ${roles}`;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = c.label;
    chip.append(dot, lbl);
    el.appendChild(chip);
  }
  applyAiBusyClasses(el); // keep pulse if a pass is in flight while status re-renders
}
function setAiBusy(tag: string, on: boolean): void {
  aiBusyCounts[tag] = Math.max(0, (aiBusyCounts[tag] || 0) + (on ? 1 : -1));
  const el = $('aiStatus');
  if (el) {
    applyAiBusyClasses(el);
  }
}
// Footer text load-state + VRAM, beside the model chip.
function renderModelState(s: { status: string; vramGb: number }): void {
  const st = $('aiState');
  const vr = $('aiVram');
  if (st) {
    st.textContent =
      s.status === 'ready'
        ? 'Model Ready'
        : s.status === 'loading'
          ? 'Loading Model…'
          : s.status === 'idle'
            ? 'Idle'
            : '';
    st.className = s.status === 'ready' ? 'st-ready' : s.status === 'loading' ? 'st-loading' : '';
  }
  if (vr) {
    const show = s.status !== 'off' && s.vramGb > 0;
    vr.textContent = show ? `${s.vramGb} GB VRAM` : '';
    vr.title = show ? 'GPU / unified memory the loaded model is using' : '';
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
  // Inline SVGs (currentColor) so the icons theme with the menu text.
  const gearSvg =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  const robotSvg =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="4" y="9" width="16" height="11" rx="2.5"/>' +
    '<path d="M12 9V5"/><circle cx="12" cy="4" r="1.1"/>' +
    '<path d="M2 14v2"/><path d="M22 14v2"/>' +
    '<circle cx="9" cy="14" r="1" fill="currentColor" stroke="none"/>' +
    '<circle cx="15" cy="14" r="1" fill="currentColor" stroke="none"/></svg>';
  const bookSvg =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21z"/>' +
    '<path d="M4 5.5A2.5 2.5 0 0 0 6.5 8H20"/></svg>';
  const menu = document.createElement('div');
  menu.id = 'proser-ctx';
  menu.innerHTML =
    '<div class="fmt">' +
    '<button class="dict" data-act="define" title="Dictionary — look up definition">' +
    bookSvg +
    '</button>' +
    '<button data-fmt="bold" title="Bold (Ctrl+B)"><b>B</b></button>' +
    '<button data-fmt="italic" title="Italic (Ctrl+I)"><i>I</i></button>' +
    '<button data-fmt="underline" title="Underline (Ctrl+U)"><u>U</u></button>' +
    '<button data-fmt="strike" title="Strikethrough"><s>S</s></button>' +
    '</div>' +
    '<div class="act-group">' +
    '<div class="act-labels">' +
    '<button data-act="synonyms">Synonyms</button>' +
    '<button data-act="antonyms">Antonyms</button>' +
    '</div>' +
    '<button class="act-cfg" data-act="synEngine" title="Synonym & antonym engine — AI model or dictionary">' +
    gearSvg +
    '</button>' +
    '</div>' +
    '<div class="act-row">' +
    '<button data-act="revise">Revise with AI</button>' +
    '<button class="act-cfg" data-act="reviseModel" title="Change the AI model">' +
    robotSvg +
    '</button>' +
    '</div>';
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
    if (act === 'define') {
      vscode.postMessage({ type: 'definitionRequest', word: pendingSelText.trim() });
    } else if (act === 'synonyms' || act === 'antonyms') {
      vscode.postMessage({
        type: 'thesaurusRequest',
        kind: act,
        word: pendingSelText,
        sentence: sentenceContext()
      });
    } else if (act === 'revise') {
      pendingReviseText = pendingSelText;
      showRevisePrompt('');
    } else if (act === 'synEngine') {
      vscode.postMessage({ type: 'thesaurusEngine' }); // gear → engine picker
    } else if (act === 'reviseModel') {
      vscode.postMessage({ type: 'selectModel' }); // robot → AI model picker
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
  // Dictionary/Synonyms/Antonyms only make sense for a single word — disable them
  // for multi-word selections and hyphenated phrases. "Revise with AI" still works.
  const wordEligible = isSingleWord(pendingSelText);
  menu
    .querySelectorAll<HTMLButtonElement>(
      '[data-act="define"], [data-act="synonyms"], [data-act="antonyms"]'
    )
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
  spellCardWord = '';
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

/** Like {@link applyReplacement}, but KEEPS the original selected text and adds the
 *  revision as a new paragraph BELOW it instead of replacing it. Reconstructs
 *  "original + blank line + revision" and replaces the selection with that, so it
 *  works the same in both Markdown and WYSIWYG modes (multi-paragraph options already
 *  round-trip through replaceSelection). `pendingReviseText` is the exact text the
 *  revision was generated from. */
function applyInsertBelow(text: string): void {
  const original = pendingReviseText.replace(/\s+$/, ''); // drop trailing WS so we don't stack blank lines
  applyReplacement(original ? `${original}\n\n${text}` : text);
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
    const btns = el('div', 'prv-btns');
    const accept = el('button', 'prv-accept', 'Accept');
    accept.title = 'Replace your original text with this revision';
    accept.addEventListener('click', () => applyReplacement(opt));
    const insert = el('button', 'prv-insert', 'Insert Below');
    insert.title = 'Keep your original text and add this revision as a new paragraph below it';
    insert.addEventListener('click', () => applyInsertBelow(opt));
    btns.appendChild(accept);
    btns.appendChild(insert);
    row.appendChild(btns);
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
  const opts = {
    el: $('editor'),
    initialEditType: 'wysiwyg',
    previewStyle: 'vertical',
    initialValue: blockifyComments(body),
    usageStatistics: false,
    hideModeSwitch: true,
    toolbarItems: [],
    height: '100%'
  };
  try {
    editor = new Editor(opts);
    // Toast UI can silently convert problematic content to an empty document —
    // treat that like a thrown error so we don't leave the page blank.
    if (body.trim() && !editor.getMarkdown().trim()) {
      throw new Error('empty wysiwyg conversion');
    }
  } catch {
    // Last resort: the Markdown source editor never breaks on content, so the
    // chapter stays fully editable instead of blank.
    try {
      editor?.destroy?.();
    } catch {
      /* ignore */
    }
    const host = $('editor');
    if (host) {
      host.innerHTML = '';
    }
    editor = new Editor({ ...opts, initialEditType: 'markdown', initialValue: body });
    currentMode = 'markdown';
    syncModeButtons(); // keep the toolbar toggle honest about the fallback
  }
  lastSent = currentMarkdown();

  // Mark genuine user edits; arrow keys / focus / programmatic changes don't
  // fire 'input', so they never set this.
  const editorEl = $('editor');
  if (editorEl) {
    editorEl.addEventListener('input', () => (userTyping = true), true);
    editorEl.addEventListener('input', autoEmDash, true); // "--" → "—" (third dash reverts)
    editorEl.addEventListener('paste', () => (userTyping = true), true);
    // Live "N words selected" footer. selectionchange covers the WYSIWYG
    // (contenteditable) selection; mouseup/keyup also cover the Markdown
    // (CodeMirror) editor, where document selectionchange doesn't always fire.
    document.addEventListener('selectionchange', scheduleSelectionStats);
    editorEl.addEventListener('mouseup', scheduleSelectionStats, true);
    editorEl.addEventListener('keyup', scheduleSelectionStats, true);
    editorEl.addEventListener('blur', updateSelectionStats, true);
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

        // Grammar next: right-click on a flagged phrase → its reason + one-click fix.
        if (spellcheckOn && grammarRanges.length > 0) {
          const hit = grammarHitAtPoint(e.clientX, e.clientY);
          if (hit) {
            e.preventDefault();
            hideMenu();
            const ds = window.getSelection();
            if (ds) {
              ds.removeAllRanges();
              ds.addRange(hit.range); // select the phrase so the fix replaces exactly it
            }
            pendingSelText = hit.finding.phrase;
            try {
              pendingSelection = editor.getSelection();
            } catch {
              pendingSelection = null;
            }
            pendingRect = hit.range.getBoundingClientRect();
            showGrammarCard(hit.finding);
            return;
          }
        }

        // Passive voice: right-click a flagged sentence → its reason + a one-click
        // active-voice rewrite. The underline now spans the whole sentence (the AI pass
        // judges sentences), so selecting its range replaces exactly it.
        if (passiveOn && passiveRanges.length > 0) {
          const hit = passiveHitAtPoint(e.clientX, e.clientY);
          if (hit) {
            e.preventDefault();
            hideMenu();
            const ds = window.getSelection();
            if (ds) {
              ds.removeAllRanges();
              ds.addRange(hit.range); // select the sentence so the rewrite replaces it
            }
            pendingSelText = hit.finding.phrase;
            try {
              pendingSelection = editor.getSelection();
            } catch {
              pendingSelection = null;
            }
            pendingRect = hit.range.getBoundingClientRect();
            showPassiveCard(hit.finding);
            return;
          }
        }

        // Tense: right-click a flagged sentence → its reason + one-click corrected rewrite.
        if (tenseOn && tenseRanges.length > 0) {
          const hit = tenseHitAtPoint(e.clientX, e.clientY);
          if (hit) {
            e.preventDefault();
            hideMenu();
            const ds = window.getSelection();
            if (ds) {
              ds.removeAllRanges();
              ds.addRange(hit.range); // select the sentence so the fix replaces exactly it
            }
            pendingSelText = hit.finding.phrase;
            try {
              pendingSelection = editor.getSelection();
            } catch {
              pendingSelection = null;
            }
            pendingRect = hit.range.getBoundingClientRect();
            showTenseCard(hit.finding);
            return;
          }
        }

        // Quotation punctuation: right-click the flagged quote + period/comma → the
        // style rule + a one-click swap. Deterministic, so it's always available when on.
        if (quotePunctuationStyle !== 'off') {
          const hit = quotePunctHitAtPoint(e.clientX, e.clientY);
          if (hit) {
            e.preventDefault();
            hideMenu();
            const ds = window.getSelection();
            if (ds) {
              ds.removeAllRanges();
              ds.addRange(hit.range); // select the pair so the fix replaces exactly it
            }
            pendingSelText = hit.range.toString();
            try {
              pendingSelection = editor.getSelection();
            } catch {
              pendingSelection = null;
            }
            pendingRect = hit.range.getBoundingClientRect();
            showInlineFixCard(hit);
            return;
          }
        }

        // Sentence spacing: right-click the flagged gap (or the period when a space is
        // missing) → the rule + a one-click normalize to the configured spacing.
        {
          const hit = spacingHitAtPoint(e.clientX, e.clientY);
          if (hit) {
            e.preventDefault();
            hideMenu();
            const ds = window.getSelection();
            if (ds) {
              ds.removeAllRanges();
              ds.addRange(hit.range); // select the gap/punctuation so the fix replaces it
            }
            pendingSelText = hit.range.toString();
            try {
              pendingSelection = editor.getSelection();
            } catch {
              pendingSelection = null;
            }
            pendingRect = hit.range.getBoundingClientRect();
            showInlineFixCard(hit);
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

  // The document is now rendered and visible. Tell the host it can START its checks
  // (spell / grammar / tense) — nothing runs before this, so opening a file never
  // waits behind a check, and large chapters display immediately.
  displayed = true;
  vscode.postMessage({ type: 'displayed' });
  scheduleRepaintSpell(); // first squiggle paint, now that the doc is shown

  setTimeout(() => {
    initializing = false;
  }, 400);
}

onHostMessage<HostToWebviewType>({
  update: (msg) => {
    const fullText: string = msg.text ?? '';
    if (!editor) {
      initEditor(fullText);
    } else if (fullText !== currentMarkdown()) {
      const { fm, body } = splitFrontmatter(fullText);
      // setMarkdown rebuilds the document and resets cursor + scroll (so undo/redo,
      // which re-pushes the whole text, jumped to the end). Capture where we are and
      // restore it after Toast UI re-renders — same pattern as setMode().
      const before = scrollableEditorEl();
      const ratio =
        before && before.scrollHeight > before.clientHeight
          ? before.scrollTop / (before.scrollHeight - before.clientHeight)
          : 0;
      let savedSel: unknown;
      try {
        savedSel = editor.getSelection?.();
      } catch {
        /* no selection to preserve */
      }
      applyingRemote = true;
      frontmatter = fm;
      try {
        editor.setMarkdown(blockifyComments(body), false);
      } catch {
        try {
          editor.setMarkdown(body, false);
        } catch {
          /* keep prior content rather than blank the editor */
        }
      }
      lastSent = currentMarkdown();
      applyingRemote = false;
      setTimeout(() => {
        try {
          if (Array.isArray(savedSel)) {
            editor.setSelection?.(savedSel[0], savedSel[1]);
          }
        } catch {
          /* stale position after a big change — fall back to default */
        }
        const after = scrollableEditorEl();
        if (after && after.scrollHeight > after.clientHeight) {
          after.scrollTop = ratio * (after.scrollHeight - after.clientHeight);
        }
      }, 0);
      scheduleRepaintSpell(); // content replaced — re-anchor squiggles
    }
    if (pendingReveal) {
      const t = pendingReveal;
      pendingReveal = '';
      setTimeout(() => revealText(t), 150); // let Toast finish rendering first
    }
  },
  reveal: (msg) => {
    revealText(typeof msg.text === 'string' ? msg.text : '');
  },
  insertHr: (msg) => {
    if (editor) {
      userTyping = true;
      try {
        editor.exec('hr'); // a real horizontal rule at the cursor
      } catch {
        /* ignore */
      }
      scheduleRepaintSpell();
    }
  },
  insertText: (msg) => {
    if (editor && typeof msg.text === 'string') {
      userTyping = true;
      try {
        editor.replaceSelection(msg.text);
      } catch {
        /* ignore */
      }
      scheduleRepaintSpell();
    }
  },
  replaceSelection: (msg) => {
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
  },
  thesaurusResult: (msg) => {
    if (Array.isArray(msg.words) && msg.words.length > 0) {
      showSuggestions(msg.words, msg.word ?? pendingSelText, msg.source);
    }
  },
  reviseResult: (msg) => {
    if (Array.isArray(msg.options) && msg.options.length > 0) {
      showRevise(msg.options);
    }
  },
  promptsResult: (msg) => {
    savedPrompts = Array.isArray(msg.prompts) ? msg.prompts : [];
    if (reviseStage === 'prompt' && reviseCard) {
      const slots = reviseCard.querySelector('.prv-slots') as HTMLElement | null;
      if (slots) {
        renderSlots(slots); // refresh chips in place, keep any typed text
      }
    }
  },
  doQuickPdf: (msg) => {
    void exportPdf(); // "Quick PDF (current view)" chosen from the Export menu
  },
  spellResult: (msg) => {
    const words: Array<{ word: string; suggestions: string[] }> = Array.isArray(msg.words)
      ? msg.words
      : [];
    misspelledWords = new Set(words.map((w) => w.word));
    spellSuggestions = new Map(words.map((w) => [w.word, w.suggestions || []]));
    grammarFindings = Array.isArray(msg.grammar) ? msg.grammar : [];
    paintMisspellings();
    paintGrammar();
  },
  passiveResult: (msg) => {
    // Drop anything the user already fixed/dismissed so a fresh pass can't re-mark it.
    passiveFindings = (Array.isArray(msg.findings) ? msg.findings : []).filter(
      (f: PassiveFinding) => f && f.phrase && !ignoredPassive.has(normText(f.phrase))
    );
    paintPassive();
  },
  tenseResult: (msg) => {
    // Drop anything the user already fixed/dismissed so a fresh pass can't re-mark it.
    tenseFindings = (Array.isArray(msg.findings) ? msg.findings : []).filter(
      (f: TenseFinding) => f && f.phrase && !resolvedTense.has(normText(f.phrase))
    );
    paintTense();
  },
  spellAiResult: (msg) => {
    appendSpellAiSuggestions(msg.word, Array.isArray(msg.words) ? msg.words : []);
  },
  stats: (msg) => {
    renderStats(msg.stats);
  },
  aiStatus: (msg) => {
    renderAiStatus(Array.isArray(msg.chips) ? msg.chips : []);
  },
  aiBusy: (msg) => {
    setAiBusy(typeof msg.tag === 'string' ? msg.tag : '', !!msg.on);
  },
  aiModelState: (msg) => {
    renderModelState({ status: String(msg.status ?? 'off'), vramGb: Number(msg.vramGb) || 0 });
  },
  config: (msg) => {
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
    if (typeof msg.sentenceSpacing === 'number') {
      sentenceSpacing = msg.sentenceSpacing;
      paintSpacing();
    }
    if (msg.quotePunctuationStyle === 'inside' || msg.quotePunctuationStyle === 'outside' || msg.quotePunctuationStyle === 'off') {
      quotePunctuationStyle = msg.quotePunctuationStyle;
      paintQuotePunct();
    }
    if (typeof msg.passiveVoice === 'boolean') {
      passiveOn = msg.passiveVoice;
      paintPassive();
    }
    if (typeof msg.tenseCheck === 'boolean') {
      tenseOn = msg.tenseCheck;
      paintTense();
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
    // Cmd/Ctrl+S = SAVE. Capture + stopPropagation so Toast UI's own Mod-s
    // (strikethrough) never fires. Flush the current content with the save so a
    // just-deleted chapter is actually persisted (not lost to the edit debounce).
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S') && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: 'save', text: currentMarkdown() });
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
  if (!displayed) {
    return; // no check paints until the document is on screen
  }
  if (spellRepaintTimer) {
    clearTimeout(spellRepaintTimer);
  }
  spellRepaintTimer = setTimeout(() => {
    paintMisspellings();
    paintGrammar();
    paintSpacing();
    paintQuotePunct();
    paintPassive();
    paintTense();
  }, 150);
}

// ---- Inline grammar squiggles (AI proofread; a SECOND highlight color) ----
// Same CSS-Highlight approach as spelling, but a distinct color. Each finding is a
// {phrase, message, fix}; we underline its first occurrence and offer the fix on
// right-click. Detection comes from the host's AI proofread pass (debounced/cached).
interface GrammarFinding {
  phrase: string;
  message: string;
  fix: string;
}
let grammarFindings: GrammarFinding[] = [];
let grammarRanges: Array<{ finding: GrammarFinding; range: Range }> = [];

/** First-occurrence range for each grammar finding's phrase in the visible text
 *  (single text node — covers the common case without crossing inline formatting). */
function collectGrammarRanges(): Array<{ finding: GrammarFinding; range: Range }> {
  const root = editorContentEl();
  const out: Array<{ finding: GrammarFinding; range: Range }> = [];
  if (!root || grammarFindings.length === 0) {
    return out;
  }
  const remaining = new Set(grammarFindings.filter((g) => g.phrase));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while (remaining.size && (node = walker.nextNode())) {
    const text = node.nodeValue || '';
    for (const finding of Array.from(remaining)) {
      const idx = text.indexOf(finding.phrase);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + finding.phrase.length);
        out.push({ finding, range });
        remaining.delete(finding);
      }
    }
  }
  return out;
}

/** Paints (or clears) the grammar highlight over the current view. */
function paintGrammar(): void {
  if (!FIND_SUPPORTED) {
    return;
  }
  const reg = (CSS as any).highlights as Map<string, unknown>;
  reg.delete('proser-grammar');
  grammarRanges = [];
  if (!spellcheckOn || grammarFindings.length === 0) {
    return;
  }
  grammarRanges = collectGrammarRanges();
  if (grammarRanges.length) {
    reg.set('proser-grammar', new (window as any).Highlight(...grammarRanges.map((g) => g.range)));
  }
}

// ---- Sentence-spacing underline (logic-only; a THIRD highlight color, yellow) ----
// Flags gaps after a sentence-ending period whose space count differs from the user's
// setting (0 / 1 / 2). Purely string logic — no AI. We walk the visible text nodes the
// same way as spelling: because a text node never spans a paragraph/line break, and the
// gap regex never matches across a newline, sentence boundaries at the end of a line or
// paragraph are naturally skipped (only same-line inter-sentence gaps are checked).
let sentenceSpacing = 1; // expected spaces after a period (0 | 1 | 2)
// Quotation-punctuation placement preference: 'inside' (American) | 'outside' (British) | 'off'.
let quotePunctuationStyle: 'inside' | 'outside' | 'off' = 'inside';
// punctuation + optional closing quote/bracket, the horizontal whitespace run (never a
// newline), then the next sentence's opening char. Requiring an uppercase / opening-quote
// start excludes decimals (3.14) and lowercase abbreviations (e.g. the); excluding newlines
// excludes paragraph/line ends. The lookahead only allows *unambiguous* sentence starts —
// uppercase, opening curly quotes, or "(" — NOT straight " or ', which double as closing
// quotes and would self-match a sentence that ends in a straight-quoted clause (e.g. past.").
const SPACING_RE = /([.!?])(['")\]’”]*)([^\S\r\n]*)(?=[A-Z“‘(])/gu;

/** Ranges over every same-line inter-sentence gap whose spacing breaks the setting. */
function collectSpacingRanges(): Range[] {
  const root = editorContentEl();
  const ranges: Range[] = [];
  if (!root) {
    return ranges;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue || '';
    SPACING_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SPACING_RE.exec(text))) {
      const close = m[2];
      const actual = m[3].length;
      if (actual === sentenceSpacing) {
        continue;
      }
      // Skip single-letter initials / acronyms ("U.S.", "J. R. R.") — the char before
      // the period is a lone letter — to avoid false positives on abbreviations.
      const before = text[m.index - 1];
      const before2 = text[m.index - 2];
      if (m[1] === '.' && before && /\p{L}/u.test(before) && (!before2 || !/\p{L}/u.test(before2))) {
        continue;
      }
      const range = document.createRange();
      if (actual > 0) {
        // Underline the existing whitespace run (too many or too few spaces).
        const gapStart = m.index + 1 + close.length;
        range.setStart(node, gapStart);
        range.setEnd(node, gapStart + actual);
      } else {
        // Missing space — nothing to underline, so mark the punctuation itself.
        range.setStart(node, m.index);
        range.setEnd(node, m.index + 1 + close.length);
      }
      ranges.push(range);
    }
  }
  return ranges;
}

/** Paints (or clears) the sentence-spacing highlight over the current view. */
function paintSpacing(): void {
  if (!FIND_SUPPORTED) {
    return;
  }
  const reg = (CSS as any).highlights as Map<string, unknown>;
  reg.delete('proser-spacing');
  const ranges = collectSpacingRanges();
  if (ranges.length) {
    reg.set('proser-spacing', new (window as any).Highlight(...ranges));
  }
}

/** Human text for the configured sentence-spacing rule. */
function spacingMessage(n: number): string {
  if (n === 0) {
    return 'No space belongs after the sentence here (your spacing setting).';
  }
  return n === 2
    ? 'Two spaces belong after the sentence here (your spacing setting).'
    : 'One space belongs after the sentence here (your spacing setting).';
}

/** Button label for the one-click spacing fix. */
function spacingActionLabel(n: number): string {
  if (n === 0) {
    return 'Remove the space';
  }
  return n === 2 ? 'Use two spaces' : 'Use one space';
}

/** The sentence-spacing issue (and its DOM range) under a screen point, with the
 *  deterministic fix = the gap normalized to the configured number of spaces.
 *  collectSpacingRanges underlines EITHER the whitespace run (wrong count) or, when a
 *  space is missing, the punctuation itself — so append spaces in that case and just
 *  normalize the run otherwise. */
function spacingHitAtPoint(
  x: number,
  y: number
): { range: Range; fix: string; message: string; label: string } | null {
  const spaces = ' '.repeat(sentenceSpacing);
  for (const range of collectSpacingRanges()) {
    if (!rangeHitsPoint(range, x, y)) {
      continue;
    }
    const text = range.toString();
    const fix = /\S/.test(text) ? text + spaces : spaces;
    return {
      range,
      fix,
      message: spacingMessage(sentenceSpacing),
      label: spacingActionLabel(sentenceSpacing)
    };
  }
  return null;
}

// ---- Quotation-punctuation placement underline (logic-only; a TEAL wavy underline) ----
// Flags the placement of a period/comma relative to a closing DOUBLE quote that disagrees
// with the user's regional preference. Only "." and "," differ by region — "?" and "!" follow
// logical placement in both dialects, so they're never flagged. Single quotes are excluded
// (they collide with apostrophes/possessives). The (?<=\p{L}) lookbehind requires a letter
// right before the quote/punctuation so inches (6".), decimals (3.14"), ellipses (..."), and
// possessives (the dogs'.) don't false-positive.
const QUOTE_INSIDE_RE = /(?<=\p{L})([”"])([.,])/gu; // American: flag British placement (close-quote then . ,)
const QUOTE_OUTSIDE_RE = /(?<=\p{L})([.,])([”"])/gu; // British: flag American placement (. , then close-quote)

/** Ranges over each quote/punctuation pair placed against the non-preferred style. */
function collectQuotePunctRanges(): Range[] {
  const root = editorContentEl();
  const ranges: Range[] = [];
  if (!root || quotePunctuationStyle === 'off') {
    return ranges;
  }
  const re = quotePunctuationStyle === 'outside' ? QUOTE_OUTSIDE_RE : QUOTE_INSIDE_RE;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue || '';
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const range = document.createRange();
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      ranges.push(range);
    }
  }
  return ranges;
}

/** Paints (or clears) the quotation-punctuation highlight over the current view. */
function paintQuotePunct(): void {
  if (!FIND_SUPPORTED) {
    return;
  }
  const reg = (CSS as any).highlights as Map<string, unknown>;
  reg.delete('proser-quote');
  if (quotePunctuationStyle === 'off') {
    return;
  }
  const ranges = collectQuotePunctRanges();
  if (ranges.length) {
    reg.set('proser-quote', new (window as any).Highlight(...ranges));
  }
}

/** True when (x, y) lands within any client rect of `range` (a few px of padding).
 *  Geometric hit-testing — far more reliable than caretRangeFromPoint + isPointInRange
 *  for the TINY spacing/quote highlights (a 2-char span or a single space), where the
 *  caret snaps to a word boundary and the point test misses almost every time. */
function rangeHitsPoint(range: Range, x: number, y: number): boolean {
  const rects = range.getClientRects();
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) {
      return true;
    }
  }
  return false;
}

/** The quotation-punctuation issue (and its DOM range) under a screen point. The fix
 *  is deterministic — the flagged period/comma and closing quote swapped into the
 *  configured style — so no model call is needed. */
function quotePunctHitAtPoint(
  x: number,
  y: number
): { range: Range; fix: string; message: string; label: string } | null {
  if (quotePunctuationStyle === 'off') {
    return null;
  }
  const outside = quotePunctuationStyle === 'outside';
  for (const range of collectQuotePunctRanges()) {
    if (!rangeHitsPoint(range, x, y)) {
      continue;
    }
    const pair = range.toString();
    if (pair.length !== 2) {
      continue; // stale/detached range after an edit
    }
    return {
      range,
      fix: pair[1] + pair[0], // swap the quote and the period/comma
      label: outside ? 'Move outside' : 'Move inside',
      message: outside
        ? 'Periods and commas go outside the closing quote (British style).'
        : 'Periods and commas go inside the closing quote (American style).'
    };
  }
  return null;
}

/** A small card for a deterministic inline fix (quotation punctuation, sentence
 *  spacing): the rule as the title + a one-click button that applies the corrected
 *  text to the selected range, plus Dismiss. */
function showInlineFixCard(hit: { fix: string; message: string; label: string }): void {
  hideSuggestions();
  const card = el('div');
  card.id = 'proser-suggest';
  card.addEventListener('mousedown', (e) => e.preventDefault()); // keep the range selected
  card.appendChild(el('div', 'psg-title', hit.message));
  const opts = el('div', 'psg-options');
  const fix = el('button', 'psg-opt c1', hit.label) as HTMLButtonElement;
  fix.addEventListener('click', () => applyReplacement(hit.fix));
  opts.appendChild(fix);
  card.appendChild(opts);
  const actions = el('div', 'psg-actions');
  const dismiss = el('button', 'psg-link', 'Dismiss');
  dismiss.title = 'Close this for now';
  dismiss.addEventListener('click', hideSuggestions);
  actions.appendChild(dismiss);
  card.appendChild(actions);
  document.body.appendChild(card);
  suggestCard = card;
  positionCard(card, pendingRect);
}

// ---- Passive-voice underline (AI; a PURPLE wavy underline) ----
// The host's throttled whole-doc passive pass JUDGES each passive sentence — flag only
// when an active rewrite would genuinely improve it, lenient inside dialogue — and sends
// the sentences to underline. We anchor each by first-occurrence string match, exactly
// like the tense pass below (it replaced an instant regex that flagged every passive).
interface PassiveFinding {
  phrase: string;
  message: string;
  fix: string;
}
let passiveOn = true;
let passiveFindings: PassiveFinding[] = [];
let passiveRanges: Array<{ finding: PassiveFinding; range: Range }> = [];
// Sentences the user has already fixed or dismissed this session — never re-underline
// them, even if a later (or flaky) passive pass reports them again. Cleared on reopen.
const ignoredPassive = new Set<string>();
const normText = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

function collectPassiveRanges(): Array<{ finding: PassiveFinding; range: Range }> {
  const root = editorContentEl();
  const out: Array<{ finding: PassiveFinding; range: Range }> = [];
  if (!root || passiveFindings.length === 0) {
    return out;
  }
  const remaining = new Set(
    passiveFindings.filter((p) => p.phrase && !ignoredPassive.has(normText(p.phrase)))
  );
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while (remaining.size && (node = walker.nextNode())) {
    const text = node.nodeValue || '';
    for (const f of Array.from(remaining)) {
      const idx = text.indexOf(f.phrase);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + f.phrase.length);
        out.push({ finding: f, range });
        remaining.delete(f);
      }
    }
  }
  return out;
}

/** Paints (or clears) the passive-voice highlight + stores hits for right-click. */
function paintPassive(): void {
  if (!FIND_SUPPORTED) {
    return;
  }
  const reg = (CSS as any).highlights as Map<string, unknown>;
  reg.delete('proser-passive');
  passiveRanges = [];
  if (!passiveOn || passiveFindings.length === 0) {
    return;
  }
  passiveRanges = collectPassiveRanges();
  if (passiveRanges.length) {
    reg.set('proser-passive', new (window as any).Highlight(...passiveRanges.map((p) => p.range)));
  }
}

/** The passive finding whose underline contains a screen point, for right-click. */
function passiveHitAtPoint(x: number, y: number): { finding: PassiveFinding; range: Range } | null {
  const caret = (document as any).caretRangeFromPoint?.(x, y) as Range | undefined;
  if (!caret) {
    return null;
  }
  for (const p of passiveRanges) {
    try {
      if (p.range.isPointInRange(caret.startContainer, caret.startOffset)) {
        return p;
      }
    } catch {
      /* range detached after an edit — ignore until the next repaint */
    }
  }
  return null;
}

// ---- Tense-inconsistency underline (AI; an ORANGE wavy underline) ----
// The host's throttled whole-doc tense pass sends the deviating sentences; we
// anchor each by first-occurrence string match, exactly like grammar findings.
interface TenseFinding {
  phrase: string;
  message: string;
  fix: string;
}
let tenseOn = true;
let tenseFindings: TenseFinding[] = [];
let tenseRanges: Array<{ finding: TenseFinding; range: Range }> = [];
// Sentences the user has already fixed or dismissed this session — never re-underline
// them, even if a later (or flaky) tense pass reports them again. Cleared on reopen.
// (Uses the shared `normText` normalizer defined with the passive ignore-set.)
const resolvedTense = new Set<string>();

function collectTenseRanges(): Array<{ finding: TenseFinding; range: Range }> {
  const root = editorContentEl();
  const out: Array<{ finding: TenseFinding; range: Range }> = [];
  if (!root || tenseFindings.length === 0) {
    return out;
  }
  const remaining = new Set(
    tenseFindings.filter((t) => t.phrase && !resolvedTense.has(normText(t.phrase)))
  );
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while (remaining.size && (node = walker.nextNode())) {
    const text = node.nodeValue || '';
    for (const f of Array.from(remaining)) {
      const idx = text.indexOf(f.phrase);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + f.phrase.length);
        out.push({ finding: f, range });
        remaining.delete(f);
      }
    }
  }
  return out;
}

/** Paints (or clears) the tense-inconsistency highlight + stores hits for right-click. */
function paintTense(): void {
  if (!FIND_SUPPORTED) {
    return;
  }
  const reg = (CSS as any).highlights as Map<string, unknown>;
  reg.delete('proser-tense');
  tenseRanges = [];
  if (!tenseOn || tenseFindings.length === 0) {
    return;
  }
  tenseRanges = collectTenseRanges();
  if (tenseRanges.length) {
    reg.set('proser-tense', new (window as any).Highlight(...tenseRanges.map((t) => t.range)));
  }
}

/** The tense finding whose underline contains a screen point, for right-click. */
function tenseHitAtPoint(x: number, y: number): { finding: TenseFinding; range: Range } | null {
  const caret = (document as any).caretRangeFromPoint?.(x, y) as Range | undefined;
  if (!caret) {
    return null;
  }
  for (const t of tenseRanges) {
    try {
      if (t.range.isPointInRange(caret.startContainer, caret.startOffset)) {
        return t;
      }
    } catch {
      /* range detached after an edit — ignore until the next repaint */
    }
  }
  return null;
}

/** The grammar finding whose underline contains a screen point, for right-click. */
function grammarHitAtPoint(x: number, y: number): { finding: GrammarFinding; range: Range } | null {
  const caret = (document as any).caretRangeFromPoint?.(x, y) as Range | undefined;
  if (!caret) {
    return null;
  }
  for (const g of grammarRanges) {
    try {
      if (g.range.isPointInRange(caret.startContainer, caret.startOffset)) {
        return g;
      }
    } catch {
      /* range detached after an edit — ignore until the next repaint */
    }
  }
  return null;
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

/** The word the spell card is currently showing, so a late-arriving AI result
 *  only augments the card if it's still about that same word. */
let spellCardWord = '';

/** Anchored card for a misspelled word: suggestions + Add to dictionary. When a
 *  tiny AI helper is configured, the host answers `spellAiResult` shortly after
 *  and we append a labeled, dictionary-validated "AI" row (additive — the
 *  dictionary's own suggestions stay first and authoritative). */
function showSpellCard(word: string, suggestions: string[]): void {
  hideSuggestions();
  spellCardWord = word;
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

  // Ask the host for context-aware AI corrections (no-op unless a helper is set).
  vscode.postMessage({ type: 'spellAiSuggest', word, sentence: sentenceContext() });

  const actions = el('div', 'psg-actions');
  const add = el('button', 'psg-link', '＋ Add to dictionary');
  add.addEventListener('click', () => {
    vscode.postMessage({ type: 'addToDictionary', word });
    hideSuggestions();
  });
  // Ignore: stop flagging this word in THIS project only (not taught globally).
  const ignore = el('button', 'psg-link', 'Ignore');
  ignore.title = 'Stop flagging this word in this project (without adding it to your dictionary)';
  ignore.addEventListener('click', () => {
    vscode.postMessage({ type: 'ignoreWord', word });
    hideSuggestions();
  });
  const dismiss = el('button', 'psg-link', 'Dismiss');
  dismiss.title = 'Close this for now';
  dismiss.addEventListener('click', hideSuggestions);
  actions.appendChild(add);
  actions.appendChild(ignore);
  actions.appendChild(dismiss);
  card.appendChild(actions);

  document.body.appendChild(card);
  suggestCard = card;
  positionCard(card, pendingRect);
}

/** Appends a labeled, dictionary-validated "AI" row to the open spell card — only
 *  if the card is still about `word` and the suggestions aren't already shown. */
function appendSpellAiSuggestions(word: string, words: string[]): void {
  if (!suggestCard || word !== spellCardWord || words.length === 0) {
    return;
  }
  if (suggestCard.querySelector('.psg-ai')) {
    return; // already added for this card
  }
  const existing = new Set(
    Array.from(suggestCard.querySelectorAll('.psg-opt')).map((b) =>
      (b.textContent || '').toLowerCase()
    )
  );
  const fresh = words.filter((w) => w && !existing.has(w.toLowerCase()));
  if (fresh.length === 0) {
    return; // AI added nothing the dictionary didn't already offer
  }
  const group = el('div', 'psg-ai');
  const label = el('div', undefined, '✦ AI suggestions');
  label.style.cssText = 'font-size:11px;opacity:0.7;margin:6px 0 4px;';
  group.appendChild(label);
  const row = el('div', 'psg-options');
  fresh.slice(0, 6).forEach((w, i) => {
    const b = el('button', 'psg-opt c' + (i % 3), w);
    b.addEventListener('click', () => applyReplacement(w));
    row.appendChild(b);
  });
  group.appendChild(row);
  const actions = suggestCard.querySelector('.psg-actions');
  suggestCard.insertBefore(group, actions); // between dictionary options and actions
  positionCard(suggestCard, pendingRect); // height changed — keep it anchored
}

/** Anchored card for a grammar / word-choice error: the reason + a one-click fix
 *  (replaces the flagged phrase with the AI's correction). */
function showGrammarCard(finding: GrammarFinding): void {
  hideSuggestions();
  const card = el('div');
  card.id = 'proser-suggest';
  card.addEventListener('mousedown', (e) => e.preventDefault()); // keep the phrase selected
  card.appendChild(el('div', 'psg-title', finding.message || 'Grammar suggestion'));
  const opts = el('div', 'psg-options');
  const fix = el('button', 'psg-opt c1', finding.fix) as HTMLButtonElement;
  fix.title = `Replace “${finding.phrase}” with “${finding.fix}”`;
  fix.addEventListener('click', () => applyReplacement(finding.fix));
  opts.appendChild(fix);
  card.appendChild(opts);
  const actions = el('div', 'psg-actions');
  // Ignore: permanently suppress this finding in this project so it stops nagging.
  const ignore = el('button', 'psg-link', 'Ignore');
  ignore.title = 'Stop flagging this phrase in this project';
  ignore.addEventListener('click', () => {
    vscode.postMessage({ type: 'ignoreGrammar', phrase: finding.phrase });
    // Drop it locally too so the underline clears immediately.
    grammarFindings = grammarFindings.filter((g) => g.phrase !== finding.phrase);
    paintGrammar();
    hideSuggestions();
  });
  const dismiss = el('button', 'psg-link', 'Dismiss');
  dismiss.title = 'Close this for now';
  dismiss.addEventListener('click', hideSuggestions);
  actions.appendChild(ignore);
  actions.appendChild(dismiss);
  card.appendChild(actions);
  document.body.appendChild(card);
  suggestCard = card;
  positionCard(card, pendingRect);
}

const PASSIVE_INSTRUCTION = 'Rewrite this sentence in the active voice, keeping the same meaning and narrative tense.';

/** Marks a passive finding handled: it's never re-underlined this session, and it
 *  clears from the view right away. */
function resolvePassive(finding: PassiveFinding): void {
  ignoredPassive.add(normText(finding.phrase));
  passiveFindings = passiveFindings.filter((f) => f.phrase !== finding.phrase);
  paintPassive();
}

/** Card for a passive-voice underline: the reason + a one-click active-voice rewrite
 *  (or an on-demand AI rewrite when the pass didn't supply one). */
function showPassiveCard(finding: PassiveFinding): void {
  hideSuggestions();
  const card = el('div');
  card.id = 'proser-suggest';
  card.addEventListener('mousedown', (e) => e.preventDefault()); // keep the sentence selected
  card.appendChild(el('div', 'psg-title', finding.message || 'Passive voice — consider active'));
  const opts = el('div', 'psg-options');
  // Findings always carry a real active rewrite (filtered host-side), so the one-click
  // fix is the path. Guard the empty case with the Revise round-trip just in case.
  if (finding.fix) {
    const fix = el('button', 'psg-opt c1', finding.fix) as HTMLButtonElement;
    fix.title = 'Replace with the active-voice rewrite';
    fix.addEventListener('click', () => {
      applyReplacement(finding.fix);
      resolvePassive(finding); // clear it and never flag it again this session
    });
    opts.appendChild(fix);
  } else {
    const rewrite = el('button', 'psg-opt c1', 'Rewrite in active voice') as HTMLButtonElement;
    rewrite.title = 'Ask the AI to rewrite this sentence in the active voice';
    rewrite.addEventListener('click', () => {
      pendingReviseText = finding.phrase; // revise targets the whole sentence (already selected)
      resolvePassive(finding);
      runRevise(PASSIVE_INSTRUCTION);
    });
    opts.appendChild(rewrite);
  }
  card.appendChild(opts);
  const actions = el('div', 'psg-actions');
  const ignore = el('button', 'psg-link', 'Ignore');
  ignore.title = "Don't flag this sentence's passive voice again";
  ignore.addEventListener('click', () => {
    resolvePassive(finding); // an ignored sentence stays unflagged for the session
    hideSuggestions();
  });
  actions.appendChild(ignore);
  card.appendChild(actions);
  document.body.appendChild(card);
  suggestCard = card;
  positionCard(card, pendingRect);
}

/** Card for a tense underline: the reason + a one-click corrected-tense rewrite
 *  (or an on-demand AI rewrite when the pass didn't supply one). */
/** Marks a tense finding handled: it's never re-underlined this session, and it
 *  clears from the view right away. */
function resolveTense(finding: TenseFinding): void {
  resolvedTense.add(normText(finding.phrase));
  tenseFindings = tenseFindings.filter((f) => f.phrase !== finding.phrase);
  paintTense();
}

function showTenseCard(finding: TenseFinding): void {
  hideSuggestions();
  const card = el('div');
  card.id = 'proser-suggest';
  card.addEventListener('mousedown', (e) => e.preventDefault()); // keep the sentence selected
  card.appendChild(el('div', 'psg-title', finding.message || 'Tense inconsistency'));
  const opts = el('div', 'psg-options');
  // Findings always carry a real, different correction now (filtered host-side), so
  // the one-click fix is the path. Guard the empty case just in case.
  if (finding.fix) {
    const fix = el('button', 'psg-opt c1', finding.fix) as HTMLButtonElement;
    fix.title = 'Replace with the corrected-tense sentence';
    fix.addEventListener('click', () => {
      applyReplacement(finding.fix);
      resolveTense(finding); // clear it and never flag it again this session
    });
    opts.appendChild(fix);
  } else {
    const rewrite = el('button', 'psg-opt c1', 'Fix tense with AI') as HTMLButtonElement;
    rewrite.addEventListener('click', () => {
      pendingReviseText = finding.phrase;
      resolveTense(finding);
      runRevise('Rewrite this sentence to match the dominant narrative tense, keeping its meaning.');
    });
    opts.appendChild(rewrite);
  }
  card.appendChild(opts);
  const actions = el('div', 'psg-actions');
  const ignore = el('button', 'psg-link', 'Ignore');
  ignore.title = "Don't flag this sentence again";
  ignore.addEventListener('click', () => {
    resolveTense(finding); // an ignored sentence stays unflagged for the session
    hideSuggestions();
  });
  actions.appendChild(ignore);
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
$('fontMinus')?.addEventListener('click', () => changeFont(-1));
$('fontPlus')?.addEventListener('click', () => changeFont(1));
$('issuesBtn')?.addEventListener('click', () => vscode.postMessage({ type: 'showIssues' }));
$('brainstormBtn')?.addEventListener('click', () => vscode.postMessage({ type: 'openBrainstorm' }));
$('exportBtn')?.addEventListener('click', () => vscode.postMessage({ type: 'exportMenu' }));
wireFind();

applyFontSize(fontSize);
applyMaxWidth(maxWidth);
vscode.postMessage({ type: 'ready' });
vscode.postMessage({ type: 'promptsLoad' });

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
let fontSize = 16;
let maxWidth = '65ch';
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

function setMode(mode: 'pretty' | 'markdown'): void {
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

/** Caps the prose column to a comfortable measure and centers it in the pane.
 *  Accepts `ch`/`px`/`rem`/`em`/`%` values or `none` (full width); anything
 *  unrecognized falls back to the 65ch typographic default. */
function applyMaxWidth(value: string): void {
  const raw = (value || '').trim().toLowerCase();
  const safe =
    raw === 'none' || raw === ''
      ? 'none'
      : /^\d+(\.\d+)?(ch|px|rem|em|%)$/.test(raw)
        ? raw
        : '65ch';
  maxWidth = safe;
  let el = $('proser-mw') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'proser-mw';
    document.head.appendChild(el);
  }
  // The editable region (WYSIWYG contents + Markdown source) gets a capped,
  // auto-margined column so text centers with generous gutters.
  el.textContent =
    `.toastui-editor-ww-container .toastui-editor-contents,` +
    `.toastui-editor-md-container .ProseMirror{` +
    `max-width:${safe};margin-left:auto !important;margin-right:auto !important;}`;
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
    '<button data-act="synonyms">Synonyms</button>' +
    '<button data-act="antonyms">Antonyms</button>' +
    '<button data-act="revise">Revise with AI</button>';
  menu.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  menu.addEventListener('click', (e) => {
    e.stopPropagation(); // don't let this click reach the "click outside" closer
    const act = (e.target as HTMLElement).dataset?.act;
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

function openMenu(x: number, y: number): void {
  const menu = ensureMenu();
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.display = 'block';
}
function hideMenu(): void {
  if (ctxMenu) {
    ctxMenu.style.display = 'none';
  }
}
function sentenceContext(): string {
  const s = window.getSelection();
  const node = s && s.anchorNode;
  const el = node ? (node.nodeType === 3 ? node.parentElement : (node as HTMLElement)) : null;
  return el ? (el.textContent || '').trim().slice(0, 300) : '';
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

/** Replaces the original selection with `text` (a synonym or a revision). */
function applyReplacement(text: string): void {
  if (!editor) {
    return;
  }
  userTyping = true; // a real edit — let it sync to the document
  try {
    if (pendingSelection) {
      editor.replaceSelection(text, pendingSelection[0], pendingSelection[1]);
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
function showSuggestions(words: string[], word: string): void {
  hideSuggestions();
  const TOP = 3;
  const card = document.createElement('div');
  card.id = 'proser-suggest';

  const title = document.createElement('div');
  title.className = 'psg-title';
  title.textContent = `Replace “${word}”`;
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
  if (reviseCard && !reviseCard.contains(t)) {
    hideRevise();
  }
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
        if (!sel || !sel.trim()) {
          hideMenu();
          return;
        }
        e.preventDefault();
        pendingSelText = sel.trim();
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
      showSuggestions(msg.words, msg.word ?? pendingSelText);
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
  }
});

// ---- Find (Ctrl/Cmd+F) ----
function findCount(query: string): number {
  if (!query) {
    return 0;
  }
  const text = ($('editor')?.textContent || '').toLowerCase();
  return text.split(query.toLowerCase()).length - 1;
}
function runFind(query: string, backwards: boolean): void {
  if (!query) {
    return;
  }
  // window.find() advances from the current selection and scrolls to the match.
  try {
    (window as any).find(query, false, backwards, true, false, false, false);
  } catch {
    /* unsupported — no-op */
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
}
function closeFind(): void {
  const bar = $('proser-find');
  if (bar) {
    bar.style.display = 'none';
  }
  if (editor && typeof editor.focus === 'function') {
    editor.focus();
  }
}
function wireFind(): void {
  const input = $('findInput') as HTMLInputElement | null;
  const count = $('findCount');
  if (!input) {
    return;
  }
  const refresh = (backwards: boolean) => {
    const q = input.value;
    if (count) {
      const n = findCount(q);
      count.textContent = q ? (n ? `${n} match${n > 1 ? 'es' : ''}` : 'No results') : '';
    }
    if (q) {
      // Start fresh so the first match is found, then navigate.
      const sel = window.getSelection();
      if (sel && backwards === false) {
        sel.removeAllRanges();
      }
      runFind(q, backwards);
    }
  };
  input.addEventListener('input', () => refresh(false));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runFind(input.value, e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
    }
  });
  $('findNext')?.addEventListener('click', () => runFind(input.value, false));
  $('findPrev')?.addEventListener('click', () => runFind(input.value, true));
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

// Wire toolbar controls.
document.querySelectorAll('#modeToggle button').forEach((b) => {
  b.addEventListener('click', () => setMode((b as HTMLElement).dataset.mode as any));
});
$('fontMinus')?.addEventListener('click', () => changeFont(-1));
$('fontPlus')?.addEventListener('click', () => changeFont(1));
$('exportPdf')?.addEventListener('click', () => void exportPdf());
wireFind();

applyFontSize(fontSize);
applyMaxWidth(maxWidth);
vscode.postMessage({ type: 'ready' });
vscode.postMessage({ type: 'promptsLoad' });

/** Brainstorm chat webview. Renders the transcript, the fill-in-the-blank preset
 *  prompts, and streams assistant replies token-by-token. Talks to the host via
 *  postMessage; the host owns the conversation history + the AI call. */

import { onHostMessage } from './messaging';

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

/** Writer-focused starters. `___` marks a blank the author fills in. */
const PRESETS: Array<{ label: string; template: string }> = [
  { label: 'Character names', template: 'Generate 20 names for a ___ character with these traits: ___' },
  { label: 'Character profile', template: 'Build a quick profile (background, core flaw, deep want, secret) for a character who ___' },
  { label: 'Plot what-ifs', template: "Give me 10 'what if' twists for a story about ___" },
  { label: 'Conflict', template: 'Suggest 8 sources of tension between ___ and ___' },
  { label: 'Name a place / thing', template: 'Generate 15 evocative names for a ___ that feels ___' },
  { label: 'Scene starter', template: 'Write 5 vivid opening lines for a scene where ___' },
  { label: 'Dialogue angles', template: 'Give 6 ways a character might say "___" while secretly feeling ___' },
  { label: 'Title ideas', template: 'Suggest 20 title ideas for a ___ story about ___' },
  { label: 'Unstick me', template: "I'm stuck. Here's what's happened so far: ___. Suggest 5 surprising things that could happen next." },
  { label: 'Sensory detail', template: 'List vivid sight, sound, smell, taste, and touch details for ___' }
];

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const log = $('log');
const input = $('input') as HTMLTextAreaElement;
const sendBtn = $('send') as HTMLButtonElement;

let current: HTMLElement | null = null; // the assistant bubble being streamed into
let busy = false;

function autoGrow(): void {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}

function addBubble(cls: string, text: string): HTMLElement {
  const empty = document.getElementById('empty');
  if (empty) {
    empty.remove();
  }
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function send(): void {
  if (busy) {
    vscode.postMessage({ type: 'stop' }); // Send doubles as Stop while streaming
    return;
  }
  const text = input.value.trim();
  if (!text) {
    return;
  }
  addBubble('user', text);
  current = addBubble('ai caret', ''); // empty assistant bubble with a typing caret
  input.value = '';
  autoGrow();
  vscode.postMessage({ type: 'chat', text });
}

function setBusy(on: boolean): void {
  busy = on;
  sendBtn.textContent = on ? 'Stop' : 'Send';
  sendBtn.classList.toggle('stop', on);
}

// Preset chips: fill the composer with the template and select the first blank.
const presetsEl = $('presets');
for (const p of PRESETS) {
  const b = document.createElement('button');
  b.className = 'preset';
  b.textContent = p.label;
  b.title = p.template;
  b.addEventListener('click', () => {
    input.value = p.template;
    autoGrow();
    input.focus();
    const i = p.template.indexOf('___');
    if (i >= 0) {
      input.setSelectionRange(i, i + 3);
    }
  });
  presetsEl.appendChild(b);
}

// ── @file mentions ──────────────────────────────────────────────────────────
// Type `@` to autocomplete any file in the workspace; selecting one inserts its
// `@id` token, which the host expands into the model's context on send.
const mentionMenu = $('mentions');
let chapters: Array<{ id: string; title: string; path: string }> = [];
let mFiltered: Array<{ id: string; title: string; path: string }> = [];
let mIndex = 0;
let mentionWasActive = false; // so we refresh the list once per fresh @, not per keystroke
let chaptersFetching = false; // a needChapters request is in flight

function hideMentions(): void {
  mentionMenu.hidden = true;
}

/** The `@token` being typed at the caret, if any (no space between @ and caret). */
function activeMention(): { start: number; query: string } | null {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const m = /(^|\s)@([A-Za-z0-9._-]*)$/.exec(before);
  if (!m) {
    return null;
  }
  return { start: caret - m[2].length - 1, query: m[2] };
}

function renderMentions(): void {
  mentionMenu.innerHTML = '';
  const hdr = document.createElement('div');
  hdr.className = 'mhdr';
  hdr.textContent = 'Reference a file';
  mentionMenu.appendChild(hdr);
  mFiltered.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'mention' + (i === mIndex ? ' active' : '');
    const at = document.createElement('span');
    at.className = 'mat';
    at.textContent = '@' + c.id;
    row.appendChild(at);
    // Show the workspace-relative path so same-named files in different folders
    // are distinguishable; fall back to the prettified title.
    const sub = c.path || c.title;
    if (sub && sub.toLowerCase() !== c.id.toLowerCase()) {
      const t = document.createElement('span');
      t.className = 'mtitle';
      t.textContent = sub;
      row.appendChild(t);
    }
    // mousedown (not click) so the textarea doesn't blur before we insert.
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      acceptMention(c.id);
    });
    mentionMenu.appendChild(row);
  });
}

/** Fuzzy subsequence score of `query` within `text` (case-insensitive). Returns
 *  -1 when not all query chars appear in order. Rewards consecutive hits and
 *  word/segment starts, so "obh" ranks "outline-back-half" near the top. */
function fuzzy(query: string, text: string): number {
  if (!query) {
    return 0; // empty query matches everything (keeps the list visible after just "@")
  }
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let run = 0;
  let prev = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      run = ti === prev + 1 ? run + 1 : 0;
      let bonus = 1 + run;
      const before = ti === 0 ? '' : t[ti - 1];
      if (ti === 0 || before === '-' || before === '_' || before === '/' || before === '.' || before === ' ') {
        bonus += 4; // start of a word/segment
      }
      score += bonus;
      prev = ti;
      qi++;
    }
  }
  return qi === q.length ? score : -1;
}

/** Best fuzzy score across a file's id, title, and path. */
function mentionScore(query: string, c: { id: string; title: string; path: string }): number {
  return Math.max(fuzzy(query, c.id), fuzzy(query, c.title || ''), fuzzy(query, c.path || ''));
}

function updateMentions(): void {
  const am = activeMention();
  if (!am) {
    mentionWasActive = false;
    hideMentions();
    return;
  }
  // Refresh once when a fresh @ opens so newly created/renamed files show up
  // without reopening the panel — but not on every keystroke within the same @.
  // The host clears chaptersFetching when the new list arrives.
  if (!mentionWasActive && !chaptersFetching) {
    chaptersFetching = true;
    vscode.postMessage({ type: 'needChapters' });
  }
  mentionWasActive = true;
  const q = am.query;
  mFiltered = chapters
    .map((c) => ({ c, s: mentionScore(q, c) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s) // best matches first
    .slice(0, 8)
    .map((x) => x.c);
  if (!mFiltered.length) {
    hideMentions();
    return;
  }
  mIndex = 0;
  renderMentions();
  mentionMenu.hidden = false;
}

function acceptMention(id: string): void {
  const am = activeMention();
  const caret = input.selectionStart ?? input.value.length;
  const start = am ? am.start : caret;
  const before = input.value.slice(0, start);
  const after = input.value.slice(caret);
  const insert = '@' + id + ' ';
  input.value = before + insert + after;
  const pos = (before + insert).length;
  input.setSelectionRange(pos, pos);
  hideMentions();
  autoGrow();
  input.focus();
}

sendBtn.addEventListener('click', send);
input.addEventListener('input', () => {
  autoGrow();
  updateMentions();
});
input.addEventListener('blur', () => setTimeout(hideMentions, 120));
input.addEventListener('keydown', (e) => {
  if (!mentionMenu.hidden && mFiltered.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mIndex = (mIndex + 1) % mFiltered.length;
      renderMentions();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      mIndex = (mIndex - 1 + mFiltered.length) % mFiltered.length;
      renderMentions();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      acceptMention(mFiltered[mIndex].id);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideMentions();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
$('newchat').addEventListener('click', () => vscode.postMessage({ type: 'reset' }));

// Header model dropdown — switch the editor / brainstorm model in place.
$('modelSelect')?.addEventListener('change', (e) =>
  vscode.postMessage({ type: 'setModel', value: (e.target as HTMLSelectElement).value })
);
// Gear → Add / Remove Models picker.
$('modelManage')?.addEventListener('click', () => vscode.postMessage({ type: 'manageModels' }));

// Rescan popover — re-scan the manuscript into Story Memory (active page / all files).
const rescanBtn = $('rescanbtn');
const rescanMenu = $('rescanmenu');
function closeRescan(): void {
  rescanMenu.hidden = true;
  rescanBtn.setAttribute('aria-expanded', 'false');
}
function renderRescan(): void {
  rescanMenu.innerHTML = '';
  const hd = document.createElement('div');
  hd.className = 'histhd';
  hd.textContent = 'Re-scan into Story Memory';
  rescanMenu.appendChild(hd);
  const items: Array<[string, string]> = [
    ['Re-Scan Active Page', 'rescanActive'],
    ['Re-Scan All Files', 'rescanAll']
  ];
  for (const [label, type] of items) {
    const row = document.createElement('div');
    row.className = 'histrow';
    const b = document.createElement('button');
    b.className = 'histitem';
    b.textContent = label;
    b.addEventListener('click', () => {
      closeRescan();
      vscode.postMessage({ type });
    });
    row.appendChild(b);
    rescanMenu.appendChild(row);
  }
}
rescanBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = rescanMenu.hidden;
  if (open) {
    renderRescan();
  }
  rescanMenu.hidden = !open;
  rescanBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
});
document.addEventListener('click', (e) => {
  if (!rescanMenu.hidden && !(e.target as HTMLElement).closest('.rescanwrap')) {
    closeRescan();
  }
});

// History popover — a button that opens a list of past chats.
const histBtn = $('histbtn');
const histMenu = $('histmenu');
let currentId = '';

function closeHistory(): void {
  histMenu.hidden = true;
  histBtn.setAttribute('aria-expanded', 'false');
}
histBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = histMenu.hidden;
  histMenu.hidden = !open;
  histBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
});
document.addEventListener('click', (e) => {
  if (!histMenu.hidden && !(e.target as HTMLElement).closest('.histwrap')) {
    closeHistory();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !histMenu.hidden) {
    closeHistory();
  }
});

/** Fills the popover with one row per saved conversation (newest first). */
function renderHistory(items: Array<{ id: string; title: string }>): void {
  histMenu.innerHTML = '';
  const hd = document.createElement('div');
  hd.className = 'histhd';
  hd.textContent = items.length ? `Past chats (${items.length})` : 'Past chats';
  histMenu.appendChild(hd);
  if (!items.length) {
    const e = document.createElement('div');
    e.className = 'histempty';
    e.textContent = 'No past chats yet.';
    histMenu.appendChild(e);
    return;
  }
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'histrow' + (it.id === currentId ? ' active' : '');

    const label = document.createElement('button');
    label.className = 'histitem';
    label.textContent = it.title || 'New chat';
    label.title = it.title || 'New chat';
    label.addEventListener('click', () => {
      closeHistory();
      if (it.id !== currentId) {
        vscode.postMessage({ type: 'select', id: it.id });
      }
    });

    const del = document.createElement('button');
    del.className = 'histdel';
    del.textContent = '✕';
    del.title = 'Delete this chat';
    del.setAttribute('aria-label', 'Delete chat');
    del.addEventListener('click', (e) => {
      e.stopPropagation(); // don't select the row we're deleting
      vscode.postMessage({ type: 'delete', id: it.id });
    });

    row.appendChild(label);
    row.appendChild(del);
    histMenu.appendChild(row);
  }
}

let model = '';
let editorModels: Array<{ tag: string; label: string }> = [];

/** Fills the header model dropdown with the system-fitting editor models (plus the
 *  current one) and a Cloud option; selecting one switches the model. */
function fillModelSelect(current: string): void {
  const sel = $('modelSelect') as HTMLSelectElement | null;
  if (!sel) {
    return;
  }
  sel.textContent = '';
  for (const m of editorModels) {
    const o = document.createElement('option');
    o.value = m.tag;
    o.textContent = m.label;
    sel.appendChild(o);
  }
  const cloud = document.createElement('option');
  cloud.value = '__cloud__';
  cloud.textContent = current === '__cloud__' ? `☁ ${model || 'Cloud'}` : '☁ Cloud (OpenRouter)…';
  sel.appendChild(cloud);
  sel.value =
    current === '__cloud__' || editorModels.some((m) => m.tag === current)
      ? current
      : editorModels[0]?.tag ?? '';
}

/** Replaces the transcript with a saved conversation (or the empty state). */
function renderConversation(messages: Array<{ role: string; content: string }>): void {
  log.innerHTML = '';
  current = null;
  if (!messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Pick a prompt below or ask anything.';
    log.appendChild(empty);
    return;
  }
  for (const m of messages) {
    const el = document.createElement('div');
    el.className = 'msg ' + (m.role === 'user' ? 'user' : 'ai');
    el.textContent = m.content;
    log.appendChild(el);
  }
  log.scrollTop = log.scrollHeight;
}

onHostMessage({
  models: (msg) => {
    editorModels = (msg.items || []) as Array<{ tag: string; label: string }>;
    model = msg.currentName && msg.currentName !== 'off' ? msg.currentName : '';
    fillModelSelect(msg.current || '');
  },
  history: (msg) => {
    currentId = msg.currentId || '';
    renderHistory(msg.items || []);
  },
  chapters: (msg) => {
    chapters = msg.items || [];
    chaptersFetching = false; // request fulfilled
    if (activeMention()) {
      updateMentions(); // a list arrived while the user was typing @
    }
  },
  load: (msg) => renderConversation(msg.messages || []),
  context: (msg) => {
    const used = msg.used || 0;
    const max = msg.max || 0;
    const pct = max ? Math.round((used / max) * 100) : 0;
    $('ctx').textContent = max ? ` · ${pct}% of context` : '';
    const warn = $('ctxwarn');
    if (pct >= 75) {
      warn.hidden = false;
      warn.textContent = `⚠ This chat is using ~${pct}% of ${model || 'the model'}'s context window — start a new chat to keep replies sharp.`;
    } else {
      warn.hidden = true;
    }
  },
  token: (msg) => {
    if (!current) {
      current = addBubble('ai caret', '');
    }
    current.classList.remove('caret');
    current.classList.add('caret'); // keep caret while streaming
    current.textContent += msg.text;
    log.scrollTop = log.scrollHeight;
  },
  done: () => {
    if (current) {
      current.classList.remove('caret');
    }
    current = null;
  },
  error: (msg) => {
    if (current) {
      current.classList.remove('caret');
      current.classList.add('error');
      current.textContent = current.textContent
        ? current.textContent + '\n\n⚠ ' + msg.message
        : '⚠ ' + msg.message;
    } else {
      addBubble('ai error', '⚠ ' + msg.message);
    }
    current = null;
  },
  busy: (msg) => setBusy(!!msg.on),
  rescanDone: (msg) => {
    if (msg.ok) {
      addBubble('ai', '✓ Story Memory re-scanned.');
    } else if (msg.error) {
      addBubble('ai error', '⚠ ' + msg.error);
    }
  }
});

vscode.postMessage({ type: 'ready' });
// Report our pixel width so the host can size the tab to its target (the host
// ignores this unless we're a side panel in a simple two-group split).
requestAnimationFrame(() => vscode.postMessage({ type: 'measure', width: window.innerWidth }));

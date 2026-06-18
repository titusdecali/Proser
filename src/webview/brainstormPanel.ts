/** Brainstorm chat webview. Renders the transcript, the fill-in-the-blank preset
 *  prompts, and streams assistant replies token-by-token. Talks to the host via
 *  postMessage; the host owns the conversation history + the AI call. */

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

// ── @chapter mentions ───────────────────────────────────────────────────────
// Type `@` to autocomplete a manuscript chapter; selecting one inserts its
// `@id` token, which the host expands into the model's context on send.
const mentionMenu = $('mentions');
let chapters: Array<{ id: string; title: string }> = [];
let mFiltered: Array<{ id: string; title: string }> = [];
let mIndex = 0;

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
  hdr.textContent = 'Reference a chapter';
  mentionMenu.appendChild(hdr);
  mFiltered.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'mention' + (i === mIndex ? ' active' : '');
    const at = document.createElement('span');
    at.className = 'mat';
    at.textContent = '@' + c.id;
    row.appendChild(at);
    if (c.title && c.title.toLowerCase() !== c.id.toLowerCase()) {
      const t = document.createElement('span');
      t.className = 'mtitle';
      t.textContent = c.title;
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

function updateMentions(): void {
  const am = activeMention();
  if (!am) {
    hideMentions();
    return;
  }
  if (!chapters.length) {
    vscode.postMessage({ type: 'needChapters' }); // refresh the list lazily
  }
  const q = am.query.toLowerCase();
  mFiltered = chapters
    .filter((c) => c.id.toLowerCase().includes(q) || c.title.toLowerCase().includes(q))
    .slice(0, 8);
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

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data || {};
  if (msg.type === 'init') {
    model = msg.model && msg.model !== 'off' ? msg.model : '';
    $('model').textContent = model || 'no model set';
  } else if (msg.type === 'history') {
    currentId = msg.currentId || '';
    renderHistory(msg.items || []);
  } else if (msg.type === 'chapters') {
    chapters = msg.items || [];
    if (activeMention()) {
      updateMentions(); // a list arrived while the user was typing @
    }
  } else if (msg.type === 'load') {
    renderConversation(msg.messages || []);
  } else if (msg.type === 'context') {
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
  } else if (msg.type === 'token') {
    if (!current) {
      current = addBubble('ai caret', '');
    }
    current.classList.remove('caret');
    current.classList.add('caret'); // keep caret while streaming
    current.textContent += msg.text;
    log.scrollTop = log.scrollHeight;
  } else if (msg.type === 'done') {
    if (current) {
      current.classList.remove('caret');
    }
    current = null;
  } else if (msg.type === 'error') {
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
  } else if (msg.type === 'busy') {
    setBusy(!!msg.on);
  }
});

vscode.postMessage({ type: 'ready' });
// Report our pixel width so the host can size the tab to its target (the host
// ignores this unless we're a side panel in a simple two-group split).
requestAnimationFrame(() => vscode.postMessage({ type: 'measure', width: window.innerWidth }));

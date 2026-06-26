// Browser bundle for the Proser "Manuscript" sidebar (media/manuscript.js).
// Tabbed UI: Editor (tense / passive / continuity checks), Insert, Settings.
// All command ids come from data-attributes the host renders, so this stays generic.

import { onHostMessage } from './messaging';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();
const $ = (id: string) => document.getElementById(id);

type Kind = 'tense' | 'passive' | 'continuity';
interface Issue {
  id: string;
  type: Kind;
  file: string;
  offset: number;
  sentence: string;
  suggestion: string;
  reason: string;
}
interface State {
  type: 'state';
  issues: Issue[];
  scanning: boolean;
  continuous: boolean;
  scope: 'active' | 'folder';
  tense: 'auto' | 'past' | 'present';
  detectedTense: string | null;
  engineOff: boolean;
  ran: Kind[];
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) {
    node.className = cls;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function showTab(tab: string): void {
  document.querySelectorAll<HTMLElement>('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  document.querySelectorAll<HTMLElement>('.panel').forEach((p) => {
    p.style.display = p.dataset.tab === tab ? '' : 'none';
  });
}

function renderList(s: State): void {
  const list = $('eList');
  if (!list) {
    return;
  }
  list.textContent = '';
  for (const it of s.issues) {
    const row = el('div', `issue ${it.type}`);
    const head = el('div', 'ihead');
    head.appendChild(el('span', 'badge', it.type));
    if (it.file) {
      head.appendChild(el('span', 'loc', it.file));
    }
    row.appendChild(head);
    row.appendChild(el('div', 'sentence', it.sentence));
    if (it.reason) {
      row.appendChild(el('div', 'reason', it.reason));
    }
    if (it.suggestion) {
      row.appendChild(el('div', 'sugg', `→ ${it.suggestion}`));
    }
    const actions = el('div', 'actions');
    const go = el('button', undefined, 'Go To') as HTMLButtonElement;
    go.disabled = it.offset < 0;
    go.addEventListener('click', () => vscode.postMessage({ type: 'go', id: it.id }));
    const fix = el('button', 'fix', 'Fix');
    fix.addEventListener('click', () => vscode.postMessage({ type: 'fix', id: it.id }));
    const ignore = el('button', undefined, 'Ignore');
    ignore.addEventListener('click', () => vscode.postMessage({ type: 'ignore', id: it.id }));
    actions.append(go, fix, ignore);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

function render(s: State): void {
  const scope = $('scope') as HTMLSelectElement | null;
  const tense = $('tense') as HTMLSelectElement | null;
  const cont = $('continuous') as HTMLInputElement | null;
  if (scope) {
    scope.value = s.scope;
  }
  if (tense) {
    tense.value = s.tense;
  }
  if (cont) {
    cont.checked = s.continuous;
  }
  document.querySelectorAll<HTMLButtonElement>('[data-check]').forEach((b) => {
    b.disabled = s.scanning;
  });

  const status = $('eStatus');
  if (status) {
    if (s.scanning) {
      status.textContent = 'Scanning…';
    } else if (s.engineOff) {
      status.textContent =
        'AI is off — only local passive-voice detection ran. Set up a model (Pretty toolbar → Model) for tense & continuity.';
    } else if (s.ran.length === 0) {
      status.textContent = '';
    } else {
      const n = s.issues.length;
      const t = s.detectedTense ? ` · tense: ${s.detectedTense}` : '';
      status.textContent = `${n} issue${n === 1 ? '' : 's'}${t}`;
    }
  }
  renderList(s);
}

// ---- wiring ----
document.querySelectorAll<HTMLElement>('.tab').forEach((t) => {
  t.addEventListener('click', () => showTab(t.dataset.tab || 'editor'));
});
document.querySelectorAll<HTMLElement>('[data-cmd]').forEach((b) => {
  b.addEventListener('click', () => vscode.postMessage({ type: 'command', command: b.dataset.cmd }));
});
document.querySelectorAll<HTMLElement>('[data-check]').forEach((b) => {
  b.addEventListener('click', () => vscode.postMessage({ type: 'check', kind: b.dataset.check }));
});
$('scope')?.addEventListener('change', (e) =>
  vscode.postMessage({ type: 'setScope', scope: (e.target as HTMLSelectElement).value })
);
$('tense')?.addEventListener('change', (e) =>
  vscode.postMessage({ type: 'setTense', tense: (e.target as HTMLSelectElement).value })
);
$('continuous')?.addEventListener('change', (e) =>
  vscode.postMessage({ type: 'setContinuous', enabled: (e.target as HTMLInputElement).checked })
);

// ---- Spelling section (editor-tab panel only; elements absent in the sidebar) ----
interface SpellItem {
  word: string;
  suggestions: string[];
  count: number;
}
function renderSpelling(s: {
  enabled: boolean;
  language: string;
  items: SpellItem[];
  docName: string;
}): void {
  const list = $('spList');
  const status = $('spStatus');
  const lang = $('spLang');
  if (!list || !status) {
    return; // sidebar view — no Spelling section
  }
  if (lang) {
    lang.textContent = s.language ? `${s.language} · Change` : '';
    lang.title = 'Change spelling language';
  }
  list.innerHTML = '';
  if (!s.enabled) {
    status.textContent = 'Spell check is off. Toggle it on in the Pretty toolbar or settings.';
    return;
  }
  if (!s.docName) {
    status.textContent = 'Open a Markdown file to see its spelling.';
    return;
  }
  if (s.items.length === 0) {
    status.textContent = `No misspellings in ${s.docName}.`;
    return;
  }
  status.textContent = `${s.items.length} misspelling${s.items.length > 1 ? 's' : ''} in ${s.docName}`;

  for (const it of s.items) {
    const row = document.createElement('div');
    row.className = 'sp-item';

    const head = document.createElement('div');
    head.className = 'sp-word';
    const wordBtn = document.createElement('button');
    wordBtn.className = 'sp-wordbtn';
    wordBtn.textContent = it.word;
    wordBtn.title = 'Show this word in the Pretty view';
    wordBtn.addEventListener('click', () => vscode.postMessage({ type: 'spellReveal', word: it.word }));
    head.appendChild(wordBtn);
    if (it.count > 1) {
      const c = document.createElement('span');
      c.className = 'sp-count';
      c.textContent = `${it.count}×`;
      head.appendChild(c);
    }
    row.appendChild(head);

    const suggs = document.createElement('div');
    suggs.className = 'sp-suggs';
    if (it.suggestions.length === 0) {
      const none = document.createElement('span');
      none.className = 'sp-none';
      none.textContent = 'No suggestions';
      suggs.appendChild(none);
    } else {
      it.suggestions.slice(0, 6).forEach((sg) => {
        const b = document.createElement('button');
        b.className = 'sp-sugg';
        b.textContent = sg;
        b.title = `Replace every “${it.word}” with “${sg}”`;
        b.addEventListener('click', () =>
          vscode.postMessage({ type: 'spellReplace', word: it.word, suggestion: sg })
        );
        suggs.appendChild(b);
      });
    }
    row.appendChild(suggs);

    const actions = document.createElement('div');
    actions.className = 'sp-actions';
    const add = document.createElement('button');
    add.textContent = '＋ Add to dictionary';
    add.addEventListener('click', () => vscode.postMessage({ type: 'spellAdd', word: it.word }));
    const ignore = document.createElement('button');
    ignore.className = 'sp-ignore';
    ignore.textContent = 'Ignore';
    ignore.title = 'Stop flagging this word (does not add it to the dictionary)';
    ignore.addEventListener('click', () => vscode.postMessage({ type: 'spellIgnore', word: it.word }));
    const go = document.createElement('button');
    go.className = 'sp-go';
    go.textContent = 'Go To';
    go.title = 'Show this word in the Pretty view';
    go.addEventListener('click', () => vscode.postMessage({ type: 'spellReveal', word: it.word }));
    actions.appendChild(add);
    actions.appendChild(ignore);
    actions.appendChild(go);
    row.appendChild(actions);

    list.appendChild(row);
  }
}
$('spLang')?.addEventListener('click', () => vscode.postMessage({ type: 'spellLanguage' }));

onHostMessage({
  state: (msg) => render(msg as State),
  spellState: (msg) => renderSpelling(msg),
  settingsOptions: (msg) => onSettingsOptions(msg),
  showTab: (msg) => showTab(msg.tab)
});

// ---- Settings: one AI model + Synonyms / Spell Check Type ----
// Single-model design: one AI model serves every feature, so each section is just a
// selector + a gear (manage models / thesaurus settings / dictionary language).
interface ModelOpt {
  tag: string;
  label: string;
}
const SYN_TYPES: Array<[string, string]> = [
  ['ai', 'AI model'],
  ['online', 'Online (Datamuse)'],
  ['offline', 'Offline (WordNet)']
];
const SPELL_TYPES: Array<[string, string]> = [
  ['ai', 'AI model'],
  ['offline', 'Offline (dictionary)']
];
const SPACING_TYPES: Array<[string, string]> = [
  ['none', 'None'],
  ['1', '1 space'],
  ['2', '2 spaces']
];
const QUOTE_STYLES: Array<[string, string]> = [
  ['inside', 'Inside (American)'],
  ['outside', 'Outside (British)'],
  ['off', 'Off']
];

function fillSelect(sel: HTMLSelectElement | null, items: Array<[string, string]>, selected: string): void {
  if (!sel) {
    return;
  }
  sel.textContent = '';
  for (const [v, l] of items) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = l;
    sel.appendChild(o);
  }
  // Select the requested value, else the first option.
  sel.value = items.some(([v]) => v === selected) ? selected : items[0]?.[0] ?? '';
}

/** Builds the AI Model dropdown: the system-fitting writing models + a Cloud row.
 *  An "AI off" placeholder leads when no engine is active so a real pick always
 *  fires a change. (Add / remove models is the gear button beside it.) */
function renderEditorModel(
  models: ModelOpt[],
  editor: { value: string; cloudLabel: string; off: boolean }
): void {
  const items: Array<[string, string]> = [];
  if (editor.off) {
    items.push(['__off__', '⚠ AI off — pick a model to enable']);
  }
  for (const m of models) {
    items.push([m.tag, m.label]);
  }
  items.push([
    '__cloud__',
    editor.cloudLabel ? `☁ Cloud (OpenRouter) · ${editor.cloudLabel}` : '☁ Cloud (OpenRouter)…'
  ]);
  fillSelect($('editorModel') as HTMLSelectElement | null, items, editor.value);
}

function onSettingsOptions(d: {
  editorModels: ModelOpt[];
  editor: { value: string; cloudLabel: string; off: boolean };
  synType: string;
  spellType: string;
  spacing: string;
  quoteStyle?: string;
  passiveVoice: boolean;
  tenseCheck: boolean;
  grammarCheck: boolean;
}): void {
  renderEditorModel(d.editorModels || [], d.editor || { value: '', cloudLabel: '', off: true });
  fillSelect($('synType') as HTMLSelectElement | null, SYN_TYPES, d.synType);
  fillSelect($('spellType') as HTMLSelectElement | null, SPELL_TYPES, d.spellType);
  fillSelect($('spacingType') as HTMLSelectElement | null, SPACING_TYPES, d.spacing || '1');
  fillSelect($('quoteStyle') as HTMLSelectElement | null, QUOTE_STYLES, d.quoteStyle || 'inside');
  const grammar = $('grammarCheck') as HTMLInputElement | null;
  if (grammar) {
    grammar.checked = d.grammarCheck !== false;
  }
  const passive = $('passiveCheck') as HTMLInputElement | null;
  if (passive) {
    passive.checked = d.passiveVoice !== false;
  }
  const tense = $('tenseCheck') as HTMLInputElement | null;
  if (tense) {
    tense.checked = d.tenseCheck !== false;
  }
}

// Each section: a Type/Model selector + a gear (posts a message the host handles).
$('synType')?.addEventListener('change', (e) =>
  vscode.postMessage({ type: 'setSynonyms', kind: (e.target as HTMLSelectElement).value })
);
$('spellType')?.addEventListener('change', (e) =>
  vscode.postMessage({ type: 'setSpell', kind: (e.target as HTMLSelectElement).value })
);
$('spacingType')?.addEventListener('change', (e) =>
  vscode.postMessage({ type: 'setSpacing', value: (e.target as HTMLSelectElement).value })
);
$('quoteStyle')?.addEventListener('change', (e) =>
  vscode.postMessage({ type: 'setQuoteStyle', value: (e.target as HTMLSelectElement).value })
);
$('passiveCheck')?.addEventListener('change', (e) =>
  vscode.postMessage({ type: 'setPassiveCheck', enabled: (e.target as HTMLInputElement).checked })
);
$('tenseCheck')?.addEventListener('change', (e) =>
  vscode.postMessage({ type: 'setTenseCheck', enabled: (e.target as HTMLInputElement).checked })
);
$('grammarCheck')?.addEventListener('change', (e) =>
  vscode.postMessage({ type: 'setGrammarCheck', enabled: (e.target as HTMLInputElement).checked })
);
$('editorModel')?.addEventListener('change', (e) =>
  vscode.postMessage({ type: 'setEditor', value: (e.target as HTMLSelectElement).value })
);
$('editorManage')?.addEventListener('click', () => vscode.postMessage({ type: 'editorManage' }));
$('synManage')?.addEventListener('click', () => vscode.postMessage({ type: 'synManage' }));
$('spellManage')?.addEventListener('click', () => vscode.postMessage({ type: 'spellManage' }));

vscode.postMessage({ type: 'ready' });
// Report our pixel width so the host can size the Proser tab to its target. The
// host only acts on this for the editor-tab panel (a simple two-group split);
// in the activity-bar sidebar it's harmlessly ignored.
requestAnimationFrame(() => vscode.postMessage({ type: 'measure', width: window.innerWidth }));

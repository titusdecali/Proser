// Browser bundle for the Spelling sidebar (media/spelling.js). Renders the
// misspellings the host sends and relays the user's actions back.

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

const $ = (id: string) => document.getElementById(id);

interface Item {
  word: string;
  suggestions: string[];
  count: number;
}
interface State {
  type: 'state';
  enabled: boolean;
  language: string;
  items: Item[];
  docName: string;
}

function renderLangBar(language: string): void {
  const bar = $('langbar');
  if (!bar) {
    return;
  }
  bar.textContent = '';
  const label = document.createElement('span');
  label.textContent = `Language: ${language}`;
  const change = document.createElement('button');
  change.className = 'langchange';
  change.textContent = 'Change';
  change.addEventListener('click', () => vscode.postMessage({ type: 'selectLanguage' }));
  bar.appendChild(label);
  bar.appendChild(change);
}

function render(state: State): void {
  const status = $('status');
  const list = $('list');
  if (!status || !list) {
    return;
  }
  renderLangBar(state.language);
  list.textContent = '';

  if (!state.enabled) {
    status.textContent = 'Spell check is off. Toggle it on in the Pretty toolbar or settings.';
    return;
  }
  if (!state.docName) {
    status.textContent = 'Open a Markdown file to see its spelling.';
    return;
  }
  if (state.items.length === 0) {
    status.textContent = `No misspellings in ${state.docName}.`;
    return;
  }
  status.textContent = `${state.items.length} misspelling${state.items.length > 1 ? 's' : ''} in ${state.docName}`;

  for (const it of state.items) {
    const row = document.createElement('div');
    row.className = 'item';

    const head = document.createElement('div');
    head.className = 'word';
    const wordBtn = document.createElement('button');
    wordBtn.className = 'wordbtn';
    wordBtn.textContent = it.word;
    wordBtn.title = 'Reveal in editor';
    wordBtn.addEventListener('click', () => vscode.postMessage({ type: 'reveal', word: it.word }));
    head.appendChild(wordBtn);
    if (it.count > 1) {
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `${it.count}×`;
      head.appendChild(count);
    }
    row.appendChild(head);

    const sugg = document.createElement('div');
    sugg.className = 'suggestions';
    if (it.suggestions.length === 0) {
      const none = document.createElement('span');
      none.className = 'none';
      none.textContent = 'No suggestions';
      sugg.appendChild(none);
    } else {
      it.suggestions.slice(0, 6).forEach((s) => {
        const b = document.createElement('button');
        b.className = 'sugg';
        b.textContent = s;
        b.title = `Replace every “${it.word}” with “${s}”`;
        b.addEventListener('click', () =>
          vscode.postMessage({ type: 'replace', word: it.word, suggestion: s })
        );
        sugg.appendChild(b);
      });
    }
    row.appendChild(sugg);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const add = document.createElement('button');
    add.className = 'add';
    add.textContent = '＋ Add to dictionary';
    add.addEventListener('click', () => vscode.postMessage({ type: 'addToDictionary', word: it.word }));
    actions.appendChild(add);
    row.appendChild(actions);

    list.appendChild(row);
  }
}

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data;
  if (msg && msg.type === 'state') {
    render(msg as State);
  }
});

vscode.postMessage({ type: 'ready' });

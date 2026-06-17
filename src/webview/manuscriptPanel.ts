// Browser bundle for the Proser "Manuscript" sidebar (media/manuscript.js).
// Tabbed UI: Editor (tense / passive / continuity checks), Insert, Settings.
// All command ids come from data-attributes the host renders, so this stays generic.

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
    const go = el('button', undefined, 'Go') as HTMLButtonElement;
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
      status.textContent = 'Run a check above. Toggle “Scan continuously” to re-check as you write.';
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

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data;
  if (!msg) {
    return;
  }
  if (msg.type === 'state') {
    render(msg as State);
  } else if (msg.type === 'showTab') {
    showTab(msg.tab);
  }
});

vscode.postMessage({ type: 'ready' });

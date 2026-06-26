import * as vscode from 'vscode';
import { Commands, ConfigKeys, EXTENSION_ID } from '../../constants';
import { AiMessage } from './AiClient';
import { SecretStore } from './secretStore';
import { createEngine, prepareEngine, fittingEditorModels, ensureModelPulled, isMemoryError } from './engineFactory';
import { pickOpenRouterModelWithKey } from './modelPicker';
import { OllamaClient } from './ollamaClient';
import { currentModelName } from './aiModelStatus';
import { signalAi } from './aiActivity';
import { getBrainstormHtml } from './brainstormHtml';
import { presizeSidePanel, recordSidePanel } from '../../util/editorLayout';
import { titleFromFilename } from '../manuscript/compile';
import { getStoryContext } from '../storyMemory/engine';

const SYSTEM_PROMPT =
  'You are a creative brainstorming partner for a fiction writer. Be imaginative, ' +
  'specific, and concrete, and keep ideas fresh (avoid clichés). When asked for a ' +
  'list, reply with a clean numbered list and nothing else. No preamble or sign-off.';

const VIEW_TYPE = 'proser.brainstorm';
const HISTORY_KEY = 'proser.brainstorm.history';
const MAX_CONVOS = 30; // cap persisted chats
/** The Brainstorm context window (tokens): the model's own window, capped by the
 *  user's `brainstormContextTokens` setting so the KV cache stays within VRAM. The
 *  injected Story-Memory canon is budgeted to a fraction of this, so it never
 *  overflows. (Spell/synonyms use the smaller shared AI_CONTEXT_TOKENS instead.) */
function brainstormCtxCap(): number {
  const v = vscode.workspace.getConfiguration(EXTENSION_ID).get<number>(ConfigKeys.aiBrainstormContextTokens, 50000);
  return Math.min(Math.max(v, 2048), 200000); // clamp to [2048, 200000]
}

interface Convo {
  id: string;
  title: string;
  messages: AiMessage[];
}

interface ChapterRef {
  id: string; // token-safe, unique slug — e.g. "02-blueprint" (or "characters-notes" on collision)
  title: string; // prettified title, e.g. "Blueprint"
  path: string; // workspace-relative path, for the dropdown subtitle — e.g. "manuscript/02-blueprint.md"
  uri: vscode.Uri;
}

/** Folders that never hold writing context — kept out of the @-mention list. */
const MENTION_EXCLUDE_GLOB =
  '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.vscode-test/**,**/.vscode/**}';
const MENTION_FILE_CAP = 2000; // bound findFiles on very large repos; the dropdown only shows 8
/** Text files worth offering as context — used to filter currently-open tabs. */
const MENTION_TEXT_EXT = /\.(md|markdown|mdx|txt|text|rmd|org|rst|json|ya?ml|csv|tsv)$/i;
const MENTION_NOISE = /(^|\/)(node_modules|\.git|dist|out|\.vscode-test|\.vscode)(\/|$)/;

/** Token-safe slug: keep [A-Za-z0-9._-], turn every other run into a single dash.
 *  "My File (draft)" -> "My-File-draft". */
function slugifyToken(name: string): string {
  return name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A file Uri off any editor tab input that carries one (text, diff, or Proser's
 *  custom "pretty" editor). */
function tabUri(input: unknown): vscode.Uri | undefined {
  const u = (input as { uri?: unknown } | null | undefined)?.uri;
  return u instanceof vscode.Uri ? u : undefined;
}

/** Source files for @-mention autocomplete: every Markdown file anywhere in the
 *  workspace (all folders, recursively, incl. dot-folders like .claude/) UNION
 *  every text file you currently have open (even outside the workspace, or open
 *  in Proser's pretty editor). Deduped by Uri. Each file gets a short,
 *  token-safe, *unique* id — the bare basename when unique, else qualified by its
 *  folder so same-named files in different folders stay distinct. */
async function listChapters(): Promise<ChapterRef[]> {
  const uris = new Map<string, vscode.Uri>(); // dedupe by uri string
  const add = (u: vscode.Uri): void => {
    if (u.scheme === 'file' && !MENTION_NOISE.test(u.path)) {
      uris.set(u.toString(), u);
    }
  };

  // 1) Every Markdown file across the whole workspace, recursively.
  try {
    const found = await vscode.workspace.findFiles('**/*.md', MENTION_EXCLUDE_GLOB, MENTION_FILE_CAP);
    found.forEach(add);
  } catch {
    // no workspace folder / search failed — the open tabs below still apply
  }
  // 2) Every open editor tab + loaded document that's a text file.
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const u = tabUri(tab.input);
      if (u && MENTION_TEXT_EXT.test(u.path)) {
        add(u);
      }
    }
  }
  for (const d of vscode.workspace.textDocuments) {
    if (MENTION_TEXT_EXT.test(d.uri.path)) {
      add(d.uri);
    }
  }

  // Build raw entries, then resolve id collisions in a second pass.
  const raw = [...uris.values()]
    .map((uri) => {
      const file = uri.path.split('/').pop() ?? '';
      const base = file.replace(/\.[^.]+$/, ''); // strip any extension
      const path = vscode.workspace.asRelativePath(uri);
      const parent = path.slice(0, path.length - file.length).replace(/\/+$/, '').split('/').pop() ?? '';
      return { base, parent, title: titleFromFilename(base), path, uri };
    })
    .sort((a, b) => a.path.localeCompare(b.path, 'en')); // stable order for numeric suffixes

  // Bucket by the lowercased basename slug — matchChapter() compares case-insensitively,
  // so case-only twins (readme.md / README.md) must share a bucket and be disambiguated.
  const buckets = new Map<string, typeof raw>();
  for (const r of raw) {
    const key = slugifyToken(r.base).toLowerCase();
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(r);
  }

  const out: ChapterRef[] = [];
  const usedIds = new Set<string>();
  for (const group of buckets.values()) {
    const collides = group.length > 1;
    for (const r of group) {
      let id = slugifyToken(r.base);
      if (collides) {
        const prefix = slugifyToken(r.parent);
        id = prefix ? `${prefix}-${id}` : id;
      }
      // Guarantee global uniqueness (same basename in same-named folders under
      // different roots, or a slug clash) with a stable numeric suffix.
      let unique = id;
      let n = 2;
      while (usedIds.has(unique.toLowerCase())) {
        unique = `${id}-${n++}`;
      }
      usedIds.add(unique.toLowerCase());
      out.push({ id: unique, title: r.title, path: r.path, uri: r.uri });
    }
  }
  return out;
}

const MENTION_RE = /(^|\s)@([A-Za-z0-9._-]+)/g;

/** Pulls the `@token` references out of a message body. */
function mentionTokens(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text))) {
    out.push(m[2]);
  }
  return out;
}

function matchChapter(token: string, chapters: ChapterRef[]): ChapterRef | undefined {
  const t = token.toLowerCase().replace(/[.,;:!?]+$/, ''); // tolerate trailing punctuation
  const byId =
    chapters.find((c) => c.id.toLowerCase() === t) ||
    chapters.find((c) => c.id.toLowerCase().replace(/[.,;:!?]+$/, '') === t);
  if (byId) {
    return byId;
  }
  // Back-compat: an old saved chat may hold a bare-basename token (e.g. "@notes")
  // that has since been disambiguated to "characters-notes". Recover it only when
  // exactly one file's basename matches — never guess between ambiguous twins.
  const baseSlug = (c: ChapterRef): string => {
    const file = c.path.split('/').pop() ?? '';
    return slugifyToken(file.replace(/\.md$/i, '')).toLowerCase();
  };
  const hits = chapters.filter((c) => baseSlug(c) === t);
  return hits.length === 1 ? hits[0] : undefined;
}

/** Resolves every @-mention across a conversation into one context block of the
 *  referenced chapters' current text (deduped, re-read fresh from disk). Returns
 *  the block plus an estimated token cost so the context meter stays honest. */
async function buildMentionContext(messages: AiMessage[]): Promise<{ text: string | null; tokens: number }> {
  const tokens = new Set<string>();
  for (const m of messages) {
    if (m.role === 'user') {
      for (const tok of mentionTokens(m.content)) {
        tokens.add(tok);
      }
    }
  }
  if (!tokens.size) {
    return { text: null, tokens: 0 };
  }
  const chapters = await listChapters();
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const tok of tokens) {
    const ch = matchChapter(tok, chapters);
    if (!ch || seen.has(ch.id)) {
      continue;
    }
    seen.add(ch.id);
    try {
      const bytes = await vscode.workspace.fs.readFile(ch.uri);
      const raw = Buffer.from(bytes).toString('utf8').trim();
      if (raw) {
        parts.push(`### ${ch.id}${ch.title ? ` — ${ch.title}` : ''}\n\n${raw}`);
      }
    } catch {
      // unreadable file — skip it
    }
  }
  if (!parts.length) {
    return { text: null, tokens: 0 };
  }
  const text =
    'Referenced files (the writer tagged these with @ — use them as ' +
    'context; quote or rework them as asked):\n\n' +
    parts.join('\n\n---\n\n');
  return { text, tokens: Math.ceil(text.length / 4) };
}

/** Registers "Brainstorm with AI" — a wide editor-tab chat with streamed replies,
 *  multiple saved conversations (history), and a context-usage warning. */
export function registerBrainstorm(context: vscode.ExtensionContext): void {
  const secrets = new SecretStore(context.secrets);
  let panel: vscode.WebviewPanel | undefined;
  let controller: AbortController | undefined;
  let ctxMax = 0; // 0 = the model's context window isn't known yet

  let convos: Convo[] = context.globalState.get<Convo[]>(HISTORY_KEY, []);
  let currentId = convos[0]?.id ?? '';

  const newId = (): string => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const hasUser = (c: Convo): boolean => c.messages.some((m) => m.role === 'user');
  const fresh = (): Convo => ({ id: newId(), title: 'New chat', messages: [{ role: 'system', content: SYSTEM_PROMPT }] });

  function current(): Convo {
    let c = convos.find((x) => x.id === currentId);
    if (!c) {
      c = fresh();
      convos.unshift(c);
      currentId = c.id;
    }
    return c;
  }

  /** Starts a new chat, reusing an empty current one so blank "New chat"s don't pile up. */
  function startNew(): void {
    const cur = convos.find((x) => x.id === currentId);
    if (cur && !hasUser(cur)) {
      cur.messages = [{ role: 'system', content: SYSTEM_PROMPT }];
      cur.title = 'New chat';
      return;
    }
    const c = fresh();
    convos.unshift(c);
    currentId = c.id;
  }

  function save(): void {
    convos = convos.slice(0, MAX_CONVOS);
    void context.globalState.update(HISTORY_KEY, convos);
  }

  /** Removes a saved chat. If it was the open one, falls back to the newest
   *  remaining chat (or a fresh blank one when none are left). */
  function deleteConvo(id: string): void {
    const wasCurrent = id === currentId;
    convos = convos.filter((c) => c.id !== id);
    if (wasCurrent) {
      currentId = convos[0]?.id ?? '';
      if (!currentId) {
        const c = fresh();
        convos.unshift(c);
        currentId = c.id;
      }
    }
    save();
  }

  function titleFrom(c: Convo): string {
    const first = (c.messages.find((m) => m.role === 'user')?.content ?? '').replace(/\s+/g, ' ').trim();
    return first ? (first.length > 50 ? first.slice(0, 50) + '…' : first) : 'New chat';
  }

  const tokenCount = (msgs: AiMessage[]): number =>
    Math.ceil(msgs.reduce((n, m) => n + m.content.length, 0) / 4); // ~4 chars/token estimate

  async function ensureCtxMax(): Promise<void> {
    if (ctxMax) {
      return;
    }
    const cap = brainstormCtxCap();
    try {
      const client = await createEngine(secrets);
      const reported = (client instanceof OllamaClient ? await client.contextLength() : undefined) ?? cap;
      ctxMax = Math.min(reported, cap); // the window we actually request (and meter against)
    } catch {
      ctxMax = cap;
    }
  }

  function postHistory(p: vscode.WebviewPanel): void {
    void p.webview.postMessage({
      type: 'history',
      items: convos.map((c) => ({ id: c.id, title: c.title })),
      currentId
    });
  }
  function postLoad(p: vscode.WebviewPanel): void {
    void p.webview.postMessage({
      type: 'load',
      messages: current().messages.filter((m) => m.role !== 'system')
    });
  }
  function postContext(p: vscode.WebviewPanel): void {
    const msgs = current().messages;
    void (async () => {
      const mention = await buildMentionContext(msgs);
      const story = await getStoryContext();
      void p.webview.postMessage({
        type: 'context',
        used: tokenCount(msgs) + mention.tokens + (story?.tokens ?? 0), // chapters + folded canon
        max: ctxMax || brainstormCtxCap()
      });
    })();
  }

  async function runChat(p: vscode.WebviewPanel, text: string): Promise<void> {
    let client = await createEngine(secrets);
    if (!client || !(await client.isReady()).ready) {
      client = await prepareEngine(secrets);
    }
    if (!client) {
      void p.webview.postMessage({
        type: 'error',
        message: 'No AI model is set up. Run “Proser: Set Up Local AI (Ollama)”, then try again.'
      });
      void p.webview.postMessage({ type: 'busy', on: false });
      return;
    }
    await ensureCtxMax();

    const c = current();
    c.messages.push({ role: 'user', content: text });
    if (c.title === 'New chat') {
      c.title = titleFrom(c);
    }
    controller = new AbortController();
    void p.webview.postMessage({ type: 'busy', on: true });
    const busyTag = currentModelName();

    // Inject grounding context as system blocks right after the base prompt,
    // kept out of the stored conversation (history stays light; text is re-read
    // fresh each turn): (1) the folded Story Memory canon, then (2) any
    // @-referenced files. Order puts authoritative canon first.
    const story = await getStoryContext();
    const mention = await buildMentionContext(c.messages);
    const callMessages = c.messages.slice();
    let insertAt = 1;
    if (story?.text) {
      callMessages.splice(insertAt++, 0, { role: 'system', content: story.text });
    }
    if (mention.text) {
      callMessages.splice(insertAt++, 0, { role: 'system', content: mention.text });
    }

    let streamed = '';
    // Heavy foreground generation on the single shared model — background spell &
    // synonyms yield to it (and the editor footer spins) until it finishes. The
    // try/finally guarantees the heavy count is released even on error/abort.
    signalAi(busyTag, true, true);
    try {
      await client.chat(
        callMessages,
        (chunk) => {
          streamed += chunk;
          void p.webview.postMessage({ type: 'token', text: chunk });
        },
        controller.signal,
        { numCtx: ctxMax || brainstormCtxCap() } // actually give the model the window we budget for
      );
    } catch (err) {
      if (!controller.signal.aborted) {
        if (isMemoryError(err)) {
          const model = currentModelName();
          const message =
            `Your machine ran out of memory running ${model}. Try a smaller AI model ` +
            `in Proser Settings → AI Model.`;
          void p.webview.postMessage({ type: 'error', message });
          void vscode.window.showErrorMessage(message, 'Choose a model').then((pick) => {
            if (pick === 'Choose a model') {
              void vscode.commands.executeCommand(Commands.aiSelectLocalModel);
            }
          });
        } else {
          void p.webview.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      }
    } finally {
      signalAi(busyTag, false, true);
    }

    const finalText = streamed.trim();
    if (finalText) {
      c.messages.push({ role: 'assistant', content: finalText });
    }
    save();
    postHistory(p); // titles may have changed
    postContext(p); // usage grew
    void p.webview.postMessage({ type: 'done' });
    void p.webview.postMessage({ type: 'busy', on: false });
    controller = undefined;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.brainstorm, (column?: vscode.ViewColumn) => {
      try {
        // Toggle: a second click closes the tab (mirrors the Editor button).
        if (panel) {
          panel.dispose();
          return;
        }
        openOrReveal(column);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Couldn’t open Brainstorm: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),
    vscode.commands.registerCommand(Commands.brainstormClose, () => panel?.dispose())
  );

  function openOrReveal(column?: vscode.ViewColumn): void {
    if (panel) {
      panel.reveal(panel.viewColumn ?? column ?? vscode.ViewColumn.Beside);
      return;
    }
    panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Brainstorm', column ?? vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    // Pre-size to ≈500px before the webview paints, so it opens at the right width
    // with no resize flicker (measure then only refines the remembered width).
    const preApplied = presizeSidePanel(context.globalState, 500);
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'proser.svg');
    panel.webview.html = getBrainstormHtml(panel.webview, context.extensionUri);

    const p = panel;
    // Compute the system-fitting editor models + current selection for the header
    // model dropdown.
    const postModels = async (): Promise<void> => {
      const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
      const items = await fittingEditorModels();
      const engine = cfg.get<string>(ConfigKeys.aiEngine, 'off');
      const current =
        engine === 'ollama'
          ? cfg.get<string>(ConfigKeys.aiOllamaModel, 'gemma4:e4b')
          : engine === 'openrouter'
            ? '__cloud__'
            : '';
      void p.webview.postMessage({ type: 'models', items, current, currentName: currentModelName() });
    };
    const sub = p.webview.onDidReceiveMessage(
      async (msg: { type: string; text?: string; id?: string; width?: number; value?: string }) => {
        if (msg.type === 'ready') {
          void postModels();
          postHistory(p);
          postLoad(p);
          void listChapters().then((items) =>
            p.webview.postMessage({
              type: 'chapters',
              items: items.map((c) => ({ id: c.id, title: c.title, path: c.path }))
            })
          );
          await ensureCtxMax();
          postContext(p);
        } else if (msg.type === 'needChapters') {
          const items = (await listChapters()).map((c) => ({ id: c.id, title: c.title, path: c.path }));
          void p.webview.postMessage({ type: 'chapters', items });
        } else if (msg.type === 'measure' && typeof msg.width === 'number') {
          void recordSidePanel(context.globalState, msg.width, 500, preApplied);
        } else if (msg.type === 'reset') {
          controller?.abort();
          startNew();
          save();
          postHistory(p);
          postLoad(p);
          postContext(p);
        } else if (msg.type === 'select' && typeof msg.id === 'string' && convos.some((c) => c.id === msg.id)) {
          controller?.abort();
          currentId = msg.id;
          postHistory(p);
          postLoad(p);
          postContext(p);
        } else if (msg.type === 'delete' && typeof msg.id === 'string') {
          if (msg.id === currentId) {
            controller?.abort();
          }
          deleteConvo(msg.id);
          postHistory(p);
          postLoad(p);
          postContext(p);
        } else if (msg.type === 'stop') {
          controller?.abort();
        } else if (msg.type === 'chat' && typeof msg.text === 'string' && msg.text.trim().length > 0) {
          await runChat(p, msg.text.trim());
        } else if (msg.type === 'setModel' && typeof msg.value === 'string') {
          const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
          if (msg.value === '__cloud__') {
            const cur = cfg.get<string>(ConfigKeys.aiOpenRouterModel, 'meta-llama/llama-4-scout');
            const slug = await pickOpenRouterModelWithKey(secrets, cur);
            if (slug) {
              await cfg.update(ConfigKeys.aiOpenRouterModel, slug, vscode.ConfigurationTarget.Global);
              await cfg.update(ConfigKeys.aiEngine, 'openrouter', vscode.ConfigurationTarget.Global);
            }
          } else {
            await cfg.update(ConfigKeys.aiEngine, 'ollama', vscode.ConfigurationTarget.Global);
            await cfg.update(ConfigKeys.aiOllamaModel, msg.value, vscode.ConfigurationTarget.Global);
            await ensureModelPulled(msg.value, 'Editor');
          }
          await postModels(); // re-sync the dropdown (also covers a cancelled cloud pick)
        } else if (msg.type === 'manageModels') {
          await vscode.commands.executeCommand(Commands.aiSelectLocalModel);
          await postModels();
        } else if (msg.type === 'rescanActive' || msg.type === 'rescanAll') {
          const cmd =
            msg.type === 'rescanActive' ? Commands.storyMemoryRescanChapter : Commands.storyMemoryRebuild;
          void p.webview.postMessage({ type: 'busy', on: true });
          let error: string | undefined;
          try {
            await vscode.commands.executeCommand(cmd);
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
          } finally {
            void p.webview.postMessage({ type: 'busy', on: false });
            void p.webview.postMessage({ type: 'rescanDone', ok: !error, error });
            if (!error) {
              postContext(p); // regenerated Story Memory — refresh the context readout
            }
          }
        }
      }
    );

    // Keep the header model dropdown live when the AI engine/model changes elsewhere.
    const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.aiEngine}`) ||
        e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.aiOllamaModel}`) ||
        e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.aiOpenRouterModel}`)
      ) {
        void postModels();
      }
    });

    panel.onDidDispose(() => {
      controller?.abort();
      sub.dispose();
      cfgSub.dispose();
      panel = undefined;
    });

    // Lock this group so files opened from the Explorer land in another group
    // rather than next to Brainstorm, even when it's focused.
    void vscode.commands.executeCommand('workbench.action.lockEditorGroup');
  }
}

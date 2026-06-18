import * as vscode from 'vscode';
import { Commands } from '../../constants';
import { AiMessage } from './AiClient';
import { SecretStore } from './secretStore';
import { createEngine, prepareEngine } from './engineFactory';
import { OllamaClient } from './ollamaClient';
import { currentModelName } from './aiModelStatus';
import { getBrainstormHtml } from './brainstormHtml';
import { sizeSidePanel } from '../../util/editorLayout';
import { gatherChapterFiles, manuscriptFolder, titleFromFilename } from '../manuscript/compile';

const SYSTEM_PROMPT =
  'You are a creative brainstorming partner for a fiction writer. Be imaginative, ' +
  'specific, and concrete, and keep ideas fresh (avoid clichés). When asked for a ' +
  'list, reply with a clean numbered list and nothing else. No preamble or sign-off.';

const VIEW_TYPE = 'proser.brainstorm';
const HISTORY_KEY = 'proser.brainstorm.history';
const MAX_CONVOS = 30; // cap persisted chats
const DEFAULT_CTX = 8192; // fallback when the model's context window is unknown

interface Convo {
  id: string;
  title: string;
  messages: AiMessage[];
}

interface ChapterRef {
  id: string; // filename without extension, e.g. "02-blueprint"
  title: string; // prettified title, e.g. "Blueprint"
  uri: vscode.Uri;
}

/** Lists the manuscript's chapter files (same source/order as export & the
 *  Chapters view) for @-mention autocomplete. */
async function listChapters(): Promise<ChapterRef[]> {
  const folder = manuscriptFolder();
  if (!folder) {
    return [];
  }
  try {
    const uris = await gatherChapterFiles(folder);
    return uris.map((u) => {
      const file = u.path.split('/').pop() ?? '';
      return { id: file.replace(/\.md$/i, ''), title: titleFromFilename(file), uri: u };
    });
  } catch {
    return [];
  }
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
  return (
    chapters.find((c) => c.id.toLowerCase() === t) ||
    chapters.find((c) => c.id.toLowerCase().replace(/[.,;:!?]+$/, '') === t)
  );
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
    'Referenced manuscript chapters (the writer tagged these with @ — use them as ' +
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
    try {
      const client = await createEngine(secrets);
      ctxMax = (client instanceof OllamaClient ? await client.contextLength() : undefined) ?? DEFAULT_CTX;
    } catch {
      ctxMax = DEFAULT_CTX;
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
      void p.webview.postMessage({
        type: 'context',
        used: tokenCount(msgs) + mention.tokens, // include referenced chapters
        max: ctxMax || DEFAULT_CTX
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

    // Inject any @-referenced chapters as a system block right after the base
    // prompt. Kept out of the stored conversation so history stays light and the
    // chapter text is always re-read fresh from disk.
    const mention = await buildMentionContext(c.messages);
    const callMessages = c.messages.slice();
    if (mention.text) {
      callMessages.splice(1, 0, { role: 'system', content: mention.text });
    }

    let streamed = '';
    try {
      await client.chat(
        callMessages,
        (chunk) => {
          streamed += chunk;
          void p.webview.postMessage({ type: 'token', text: chunk });
        },
        controller.signal
      );
    } catch (err) {
      if (!controller.signal.aborted) {
        void p.webview.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
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
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'proser.svg');
    panel.webview.html = getBrainstormHtml(panel.webview, context.extensionUri);

    const p = panel;
    const sub = p.webview.onDidReceiveMessage(
      async (msg: { type: string; text?: string; id?: string; width?: number }) => {
        if (msg.type === 'ready') {
          void p.webview.postMessage({ type: 'init', model: currentModelName() });
          postHistory(p);
          postLoad(p);
          void listChapters().then((items) =>
            p.webview.postMessage({ type: 'chapters', items: items.map((c) => ({ id: c.id, title: c.title })) })
          );
          await ensureCtxMax();
          postContext(p);
        } else if (msg.type === 'needChapters') {
          const items = (await listChapters()).map((c) => ({ id: c.id, title: c.title }));
          void p.webview.postMessage({ type: 'chapters', items });
        } else if (msg.type === 'measure' && typeof msg.width === 'number') {
          sizeSidePanel(msg.width, 500); // default the Brainstorm tab to ≈500px
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
        }
      }
    );

    panel.onDidDispose(() => {
      controller?.abort();
      sub.dispose();
      panel = undefined;
    });

    // Lock this group so files opened from the Explorer land in another group
    // rather than next to Brainstorm, even when it's focused.
    void vscode.commands.executeCommand('workbench.action.lockEditorGroup');
  }
}

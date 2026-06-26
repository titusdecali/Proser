/** Orchestration: ties scope + store + extract + fold + assemble together, and
 *  exposes the folded canon to Brainstorm. Bootstrap and incremental update are
 *  the same path at different scale (§9). A module singleton lets the Brainstorm
 *  panel pull context without an import cycle. */
import * as vscode from 'vscode';
import { createFeatureEngine, enforceSingleLoadedModel, isMemoryError } from '../ai/engineFactory';
import { withAi } from '../ai/aiActivity';
import { currentModelName } from '../ai/aiModelStatus';
import { OllamaClient } from '../ai/ollamaClient';
import { AiClient } from '../ai/AiClient';
import { getStoryScope, resolveCorpus } from './scope';
import { loadMemory, saveMemory, clearMemory, hashContent } from './store';
import { extractChapter, synthesizeSpine } from './extract';
import { assembleContext, AssembledContext } from './assemble';
import { ChapterMemory, MemoryDoc } from './types';
import { activeMarkdownDoc } from '../manuscript/compile';
import { ConfigKeys, EXTENSION_ID } from '../../constants';

const DEFAULT_CTX = 8192;
const CANON_BUDGET_FRACTION = 0.7; // leave ~30% of the window for the chat + reply

export interface BuildResult {
  built: number;
  skipped: number;
  failed: number;
  total: number;
}

export type ProgressSink = vscode.Progress<{ message?: string; increment?: number }>;

export class StoryMemoryEngine {
  private ctxMax = 0;
  private building = false;
  /** All memory mutations run through this chain so concurrent build/update/
   *  rebuild calls can never interleave a load→save and corrupt memory.json. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Cached assembled context, keyed by scope + memory.json mtime, so a single
   *  send (which pulls context for the prompt AND the meter) doesn't re-glob the
   *  workspace and re-read the previous chapter twice. */
  private ctxCache?: { key: string; ctx: AssembledContext | null };

  // Story Memory runs only on the local model (createFeatureEngine) — no secrets needed.

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op); // run after the prior op settles, either way
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  /** A ready AI client, or undefined (caller degrades gracefully). */
  private async readyClient(): Promise<AiClient | undefined> {
    try {
      const c = await createFeatureEngine();
      if (!c) {
        return undefined;
      }
      return (await c.isReady()).ready ? c : undefined;
    } catch {
      return undefined;
    }
  }

  private async contextMax(): Promise<number> {
    if (this.ctxMax) {
      return this.ctxMax;
    }
    // Cap at the user's Brainstorm window setting — the canon must be budgeted to the
    // window we ACTUALLY request, not the model's full (e.g. 256k) capability, or the
    // injection overflows the real KV cache and fills the chat before a word is typed.
    const cap = Math.min(
      Math.max(
        vscode.workspace.getConfiguration(EXTENSION_ID).get<number>(ConfigKeys.aiBrainstormContextTokens, 50000),
        2048
      ),
      200000
    ); // clamp to [2048, 200000]
    try {
      const c = await createFeatureEngine();
      const reported = (c instanceof OllamaClient ? await c.contextLength() : undefined) ?? DEFAULT_CTX;
      this.ctxMax = Math.min(reported, cap);
    } catch {
      this.ctxMax = Math.min(DEFAULT_CTX, cap);
    }
    return this.ctxMax;
  }

  /** The injected canon block for Brainstorm, or null when there's no memory.
   *  POINT-IN-TIME: anchored to the chapter the writer is currently in, so the
   *  context reflects the story's state *as of that chapter* — never leaking
   *  events from later chapters they haven't reached. Cached on
   *  (scope, mtime, active chapter) so repeated calls within a send are cheap. */
  async getContext(): Promise<AssembledContext | null> {
    const scope = await getStoryScope();
    if (!scope) {
      return null;
    }
    const doc = await loadMemory(scope.anchor, scope.rel);
    const corpus = await resolveCorpus(scope.root);
    const through = activeChapterOrder(corpus, doc);
    const key = `${scope.root.toString()}@${await memoryMtime(scope.anchor)}#${through ?? 'all'}`;
    if (this.ctxCache && this.ctxCache.key === key) {
      return this.ctxCache.ctx;
    }
    const budget = Math.floor((await this.contextMax()) * CANON_BUDGET_FRACTION);
    const ctx = assembleContext(doc, { budgetTokens: budget, throughOrder: through });
    this.ctxCache = { key, ctx };
    return ctx;
  }

  /** Full bootstrap/refresh over the corpus. Hash-gated (skips unchanged),
   *  resumable (saves after each chapter), cancelable. Serialized + guarded so a
   *  second build/rebuild can't run concurrently. */
  async build(progress?: ProgressSink, signal?: AbortSignal): Promise<BuildResult> {
    if (this.building) {
      throw new Error('A Story Memory build is already running.');
    }
    this.building = true;
    try {
      // Heavy foreground generation on the single shared model — background spell &
      // synonyms yield to it (and the editor footer spins) until it finishes.
      return await withAi(currentModelName(), true, () =>
        this.serialize(() => this.buildImpl(progress, signal))
      );
    } finally {
      this.building = false;
    }
  }

  /** Wipes derived memory, then rebuilds from scratch (serialized + guarded). */
  async rebuild(progress?: ProgressSink, signal?: AbortSignal): Promise<BuildResult> {
    if (this.building) {
      throw new Error('A Story Memory build is already running.');
    }
    this.building = true;
    try {
      return await withAi(currentModelName(), true, () =>
        this.serialize(async () => {
          const scope = await getStoryScope();
          if (scope) {
            await clearMemory(scope.anchor);
          }
          return this.buildImpl(progress, signal);
        })
      );
    } finally {
      this.building = false;
    }
  }

  /** Incrementally re-extracts a single changed canonical chapter. Returns true
   *  when memory changed. Skipped while a full build runs (the build covers it). */
  async updateChapter(uri: vscode.Uri): Promise<boolean> {
    if (this.building) {
      return false;
    }
    return withAi(currentModelName(), true, () => this.serialize(() => this.updateImpl(uri)));
  }

  private async buildImpl(progress?: ProgressSink, signal?: AbortSignal): Promise<BuildResult> {
    const scope = await getStoryScope();
    if (!scope) {
      throw new Error('Open a folder first — no workspace to scope.');
    }
    await enforceSingleLoadedModel(); // free any stray model so the scan has all the RAM
    const client = await this.readyClient();
    if (!client) {
      throw new Error('No AI model is ready. Set up Ollama or OpenRouter, then try again.');
    }
    const corpus = await resolveCorpus(scope.root);
    const doc = await loadMemory(scope.anchor, scope.rel);
    doc.storyRoot = scope.rel;
    // Drop chapters that no longer exist in the corpus.
    const liveIds = new Set(corpus.map((c) => c.id));
    for (const id of Object.keys(doc.chapters)) {
      if (!liveIds.has(id)) {
        delete doc.chapters[id];
      }
    }

    let built = 0;
    let skipped = 0;
    let failed = 0;
    for (let i = 0; i < corpus.length; i++) {
      if (signal?.aborted) {
        break;
      }
      const cf = corpus[i];
      progress?.report({ message: `(${i + 1}/${corpus.length}) ${cf.title}`, increment: 100 / corpus.length });
      const text = await readText(cf.uri);
      if (!text.trim()) {
        delete doc.chapters[cf.id];
        continue;
      }
      const existing = doc.chapters[cf.id];
      if (existing && existing.hash === hashContent(text) && existing.order === cf.order) {
        skipped++;
        continue;
      }
      try {
        const mem = await extractChapter(
          client,
          { chapterId: cf.id, title: cf.title, order: cf.order, text },
          signal
        );
        if (isEmptyExtraction(mem)) {
          failed++; // don't commit a hash for an empty parse — retry next build
          continue;
        }
        doc.chapters[cf.id] = mem;
        await saveMemory(scope.anchor, doc); // resumable
        built++;
      } catch (e) {
        if (signal?.aborted) {
          break; // user cancelled — not a failure
        }
        // An out-of-memory error hits every chapter the same way — stop and report
        // it once rather than churning through the whole corpus "failing" silently.
        if (isMemoryError(e)) {
          throw e;
        }
        failed++;
      }
    }
    // Distill the book's logline + themes from the chapter summaries (best-effort,
    // non-fatal). Skip when nothing meaningful was extracted or the user cancelled.
    if (!signal?.aborted && Object.keys(doc.chapters).length) {
      const summaries = Object.values(doc.chapters)
        .sort((a, b) => a.order - b.order)
        .map((c) => ({ title: c.title, summary: c.summary }));
      const { spine, themes } = await synthesizeSpine(client, summaries, signal);
      doc.spine = spine;
      doc.themes = themes;
    }
    await saveMemory(scope.anchor, doc);
    return { built, skipped, failed, total: corpus.length };
  }

  private async updateImpl(uri: vscode.Uri): Promise<boolean> {
    const scope = await getStoryScope();
    if (!scope) {
      return false;
    }
    const cf = (await resolveCorpus(scope.root)).find((c) => c.uri.toString() === uri.toString());
    if (!cf) {
      return false; // outside the canon corpus
    }
    const text = await readText(cf.uri);
    if (!text.trim()) {
      return false;
    }
    const doc = await loadMemory(scope.anchor, scope.rel);
    const existing = doc.chapters[cf.id];
    if (existing && existing.hash === hashContent(text) && existing.order === cf.order) {
      return false; // unchanged
    }
    await enforceSingleLoadedModel(); // free any stray model so the scan has all the RAM
    const client = await this.readyClient();
    if (!client) {
      return false;
    }
    // Let extraction errors (e.g. out of memory) propagate: the rescan command
    // surfaces them; the background save handler wraps this and stays best-effort.
    const mem = await extractChapter(client, { chapterId: cf.id, title: cf.title, order: cf.order, text });
    if (isEmptyExtraction(mem)) {
      return false; // don't overwrite with an empty parse
    }
    doc.chapters[cf.id] = mem;
    await saveMemory(scope.anchor, doc);
    return true;
  }
}

/** The corpus order of the chapter the writer is currently in (active editor),
 *  or undefined when it can't be mapped — then context folds the whole book. */
function activeChapterOrder(
  corpus: Array<{ id: string; uri: vscode.Uri }>,
  doc: MemoryDoc
): number | undefined {
  const active = activeMarkdownDoc();
  if (!active) {
    return undefined;
  }
  const key = active.uri.toString();
  const cf = corpus.find((c) => c.uri.toString() === key);
  const mem = cf ? doc.chapters[cf.id] : undefined;
  return mem ? mem.order : undefined;
}

async function readText(uri: vscode.Uri): Promise<string> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    return '';
  }
}

/** mtime of the persisted memory file (0 when absent) — the getContext cache key. */
async function memoryMtime(anchor: vscode.Uri): Promise<number> {
  try {
    const uri = vscode.Uri.joinPath(anchor, '.proser', 'memory', 'memory.json');
    return (await vscode.workspace.fs.stat(uri)).mtime;
  } catch {
    return 0;
  }
}

/** A parse that yielded nothing useful — treat as a failure so it's retried,
 *  not committed as a "successful" empty chapter. */
function isEmptyExtraction(m: ChapterMemory): boolean {
  return !m.summary.trim() && m.plotPoints.length === 0;
}

// ── Singleton (so Brainstorm can pull context without an import cycle) ───────
let active: StoryMemoryEngine | undefined;

export function setActiveEngine(e: StoryMemoryEngine): void {
  active = e;
}

export function getActiveEngine(): StoryMemoryEngine | undefined {
  return active;
}

/** Brainstorm calls this; returns null when memory isn't set up yet. */
export async function getStoryContext(): Promise<AssembledContext | null> {
  try {
    return active ? await active.getContext() : null;
  } catch {
    return null;
  }
}

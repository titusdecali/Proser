/** Shared engine for the whole-document AI proofreading passes (tense, passive).
 *  Each pass differs only in its prompt and its per-finding validation; the
 *  chunking, model call, JSON extraction, and dedup driver live here once.
 *
 *  NOTE: the spelling passes (aiSpell/aiDocSpell) deliberately do NOT use this —
 *  they are per-paragraph, schema-constrained, and incrementally cached, a
 *  genuinely different shape. Forcing them in would be a worse abstraction. */
import { AiClient } from '../ai/AiClient';
import { AI_CONTEXT_TOKENS } from '../../constants';
import { stripFrontmatter } from '../../util/markdownScan';

/** A sentence-level finding to underline. `phrase` is copied verbatim from the
 *  prose so the webview can anchor the squiggle by string match; `fix` is the
 *  model's rewrite for the one-click fix (or '' when it offered none). The tense
 *  and passive passes share this exact shape. */
export interface ProofreadFinding {
  phrase: string;
  message: string;
  fix: string;
}

/** Per-pass configuration for {@link proofreadDocument}. */
export interface ProofreadPass {
  /** System prompt for this pass. */
  system: string;
  /** Builds the user prompt for one window of prose. */
  buildUser(body: string): string;
  /** Validates one candidate finding (its `phrase`/`fix` are already non-empty and
   *  distinct). Return true to keep it. This is where each pass's domain rules live. */
  accept(candidate: { phrase: string; fix: string; reason: string }): boolean;
  /** Fallback message when the model returned no usable reason. */
  defaultMessage: string;
  /** Optional cheap pre-filter: return true to SKIP the model for this window (a
   *  real "nothing to flag" answer). The passive pass uses this for its regex gate. */
  skipChunk?(chunk: string): boolean;
}

// The model's context is AI_CONTEXT_TOKENS (8192). Keep each window's prose well
// under that (≈4 chars/token) so the prompt + output fit and Ollama never silently
// truncates the chapter. Larger documents split at paragraph boundaries; MAX_CHUNKS
// bounds the work on a very large file.
const CHUNK_CHARS = 12000;
const MAX_CHUNKS = 8;

/** Splits `body` into ≤ CHUNK_CHARS windows, breaking at blank lines so a sentence
 *  is never cut in half. A single oversized paragraph is hard-split as a fallback. */
export function chunkBody(body: string): string[] {
  if (body.length <= CHUNK_CHARS) {
    return [body];
  }
  const chunks: string[] = [];
  let cur = '';
  for (const para of body.split(/\n{2,}/)) {
    if (cur && cur.length + para.length + 2 > CHUNK_CHARS) {
      chunks.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${para}` : para;
    while (cur.length > CHUNK_CHARS) {
      chunks.push(cur.slice(0, CHUNK_CHARS));
      cur = cur.slice(CHUNK_CHARS);
    }
  }
  if (cur) {
    chunks.push(cur);
  }
  return chunks.slice(0, MAX_CHUNKS);
}

/** Pulls the outermost `{ "issues": [...] }` object from model output and applies
 *  the pass's `accept` guard. Returns the kept findings, or `null` when the output
 *  had no parseable JSON object at all — the caller keeps the prior underlines
 *  rather than mistaking garbage / a thinking-model's empty reply for "no issues". */
function parseFindings(text: string, pass: ProofreadPass): ProofreadFinding[] | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  let data: { issues?: Array<Record<string, unknown>> };
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const raw = Array.isArray(data?.issues) ? data.issues : [];
  const out: ProofreadFinding[] = [];
  for (const r of raw) {
    const phrase = typeof r.sentence === 'string' ? r.sentence.trim() : '';
    if (!phrase) {
      continue;
    }
    const fix = typeof r.suggestion === 'string' ? r.suggestion.trim() : '';
    // A real finding MUST come with a rewrite that differs from the original. No
    // (or identical) suggestion = the model flagged an already-correct sentence.
    if (!fix || fix === phrase) {
      continue;
    }
    const reason = typeof r.reason === 'string' ? r.reason.trim() : '';
    if (!pass.accept({ phrase, fix, reason })) {
      continue;
    }
    out.push({ phrase, message: reason || pass.defaultMessage, fix });
  }
  return out;
}

/** One model call over a single window. Returns its findings, or null when the
 *  output had no parseable JSON. */
async function proofreadChunk(
  client: AiClient,
  chunk: string,
  pass: ProofreadPass,
  signal?: AbortSignal
): Promise<ProofreadFinding[] | null> {
  if (pass.skipChunk?.(chunk)) {
    return []; // pre-filtered: a real "nothing to flag" answer, no model call
  }
  let out = '';
  await client.chat(
    [
      { role: 'system', content: pass.system },
      { role: 'user', content: pass.buildUser(chunk) }
    ],
    (t) => {
      out += t;
    },
    signal,
    { format: 'json', think: false, temperature: 0.2, numCtx: AI_CONTEXT_TOKENS }
  );
  return parseFindings(out, pass);
}

/**
 * Runs a proofreading pass over the whole document (chunked so any chapter size is
 * covered). Resolves to the findings (deduped by phrase), `[]` when there are none,
 * or `null` when EVERY window that called the model returned unparseable output —
 * the caller treats `null` as "don't know" and keeps the prior squiggles. Throws
 * only if a chat call fails or is aborted.
 */
export async function proofreadDocument(
  client: AiClient,
  text: string,
  pass: ProofreadPass,
  signal?: AbortSignal
): Promise<ProofreadFinding[] | null> {
  const body = stripFrontmatter(text).trim();
  if (!body) {
    return []; // genuinely empty document — no findings
  }
  const seen = new Set<string>();
  const all: ProofreadFinding[] = [];
  let anyParsed = false;
  for (const chunk of chunkBody(body)) {
    const findings = await proofreadChunk(client, chunk, pass, signal);
    if (findings === null) {
      continue; // this window was unparseable — keep going
    }
    anyParsed = true; // a pre-filtered (empty) window still counts as a real answer
    for (const f of findings) {
      if (!seen.has(f.phrase)) {
        seen.add(f.phrase);
        all.push(f);
      }
    }
  }
  return anyParsed ? all : null;
}

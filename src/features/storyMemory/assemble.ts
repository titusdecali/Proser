/** Composes the injected "story so far" from per-chapter summaries, point-in-time
 *  (only chapters up to where the writer is) and within a token budget. Newest
 *  chapters are kept first so the most relevant context always survives a tight
 *  budget; the output stays chronological. Pure. */
import { ChapterMemory, MemoryDoc } from './types';

const ROLE = [
  'STORY SO FAR — you are grounded by the record below.',
  'Treat it as the account of what has happened: never contradict it and never invent prior events.',
  'If something is not here, it is NOT yet established — say so rather than inventing it.'
].join(' ');

export interface AssembleOptions {
  budgetTokens: number;
  /** Only include chapters up to this order (no spoilers from later chapters).
   *  Undefined = the whole book. */
  throughOrder?: number;
}

export interface AssembledContext {
  text: string;
  tokens: number;
  breakdown: Record<string, number>;
}

/** Cheap ~4-chars/token estimate (the same heuristic used elsewhere). */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function renderChapter(c: ChapterMemory): string {
  const loc =
    c.startLocation || c.endLocation
      ? `  [${c.startLocation || '?'}${c.endLocation && c.endLocation !== c.startLocation ? ` → ${c.endLocation}` : ''}]`
      : '';
  const lines = [`Ch${c.order} — ${c.title}${loc}`];
  if (c.summary) {
    lines.push(c.summary);
  }
  if (c.plotPoints.length) {
    lines.push('Plot: ' + c.plotPoints.join('; '));
  }
  if (c.characterArcs.length) {
    lines.push('Arcs: ' + c.characterArcs.join('; '));
  }
  return lines.join('\n');
}

export function assembleContext(doc: MemoryDoc, opts: AssembleOptions): AssembledContext | null {
  const through = opts.throughOrder ?? Infinity;
  const chapters = Object.values(doc.chapters)
    .filter((c) => c.order <= through && (c.summary || c.plotPoints.length || c.characterArcs.length))
    .sort((a, b) => a.order - b.order);
  if (chapters.length === 0 && !doc.spine) {
    return null;
  }
  const header = doc.spine ? `${ROLE}\nLogline: ${doc.spine}` : ROLE;
  let used = estimateTokens(header);
  // Select newest-first so recent chapters always make the cut on a tight budget;
  // always keep at least the most recent one.
  const selected: ChapterMemory[] = [];
  for (let i = chapters.length - 1; i >= 0; i--) {
    const cost = estimateTokens(renderChapter(chapters[i])) + 2;
    if (used + cost > opts.budgetTokens && selected.length > 0) {
      break;
    }
    used += cost;
    selected.unshift(chapters[i]); // restore chronological order in the output
  }
  const text = [header, ...selected.map(renderChapter)].join('\n\n');
  return { text, tokens: estimateTokens(text), breakdown: { chapters: selected.length } };
}

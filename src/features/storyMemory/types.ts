/** Story Memory data model. Each chapter is summarized (model-produced) into a few
 *  concrete, readable fields — what actually matters for continuity — and the running
 *  list of summaries is injected into Brainstorm as a "story so far". No canon graph:
 *  prose summaries ground an LLM far better than fragmented entity/state assertions.
 *  See docs/STORY-MEMORY-SPEC.md. */

/** One chapter's summary (model-produced, lower-trust, parsed defensively). */
export interface ChapterMemory {
  chapterId: string;
  title: string;
  order: number;
  hash: string; // content hash → skip re-extract when unchanged
  /** 2–4 sentences: the chapter's major plot points, in the order they occur. */
  summary: string;
  /** Where the chapter begins / ends, inferred from the scene ('' when indeterminable). */
  startLocation: string;
  endLocation: string;
  /** The major plot-progression beats, in order. */
  plotPoints: string[];
  /** Important character developments, each like "Name: what shifts for them". */
  characterArcs: string[];
}

/** The whole memory for one Story Root. `spine`/`themes` are distilled from the
 *  chapter summaries; `chapters` is the source of truth. */
export interface MemoryDoc {
  version: number;
  storyRoot: string; // relative path, for provenance
  spine: string; // one-line logline of the book so far
  themes: string[];
  chapters: Record<string, ChapterMemory>; // keyed by chapterId
}

export const MEMORY_VERSION = 2;

export function emptyMemory(storyRoot: string): MemoryDoc {
  return { version: MEMORY_VERSION, storyRoot, spine: '', themes: [], chapters: {} };
}

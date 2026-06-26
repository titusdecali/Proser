/** Persistence for Story Memory. The whole MemoryDoc lives in one JSON file under
 *  the anchor's `.proser/memory/`. Derived fields (legend/state/promises) are
 *  rewritten by the fold; per-chapter `hash`es let extraction skip unchanged
 *  chapters. See docs/STORY-MEMORY-SPEC.md §7. */
import * as vscode from 'vscode';
import { MemoryDoc, MEMORY_VERSION, emptyMemory } from './types';

export { hashContent } from './hash'; // re-exported for existing importers

const MEMORY_DIR = '.proser/memory';
const MEMORY_FILE = 'memory.json';

function memoryDir(anchor: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(anchor, ...MEMORY_DIR.split('/'));
}

function memoryFile(anchor: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(memoryDir(anchor), MEMORY_FILE);
}

/** Loads the memory doc, or a fresh empty one. A version mismatch (the summary
 *  format is v2, the old canon-graph format was v1) loads empty — the user rebuilds. */
export async function loadMemory(anchor: vscode.Uri, storyRootRel: string): Promise<MemoryDoc> {
  try {
    const bytes = await vscode.workspace.fs.readFile(memoryFile(anchor));
    const doc = JSON.parse(Buffer.from(bytes).toString('utf8')) as MemoryDoc;
    if (!doc || typeof doc !== 'object' || doc.version !== MEMORY_VERSION) {
      return emptyMemory(storyRootRel);
    }
    // Defensive defaults so a hand-edited file can't crash the engine.
    return { ...emptyMemory(storyRootRel), ...doc, chapters: doc.chapters ?? {} };
  } catch {
    return emptyMemory(storyRootRel);
  }
}

export async function saveMemory(anchor: vscode.Uri, doc: MemoryDoc): Promise<void> {
  await vscode.workspace.fs.createDirectory(memoryDir(anchor));
  // Minified — this is an AI/engine artifact, optimized for size, not humans.
  const data = Buffer.from(JSON.stringify(doc), 'utf8');
  await vscode.workspace.fs.writeFile(memoryFile(anchor), data);
}

/** Removes all derived memory (keeps nothing) — used by a full rebuild. */
export async function clearMemory(anchor: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(memoryFile(anchor), { useTrash: false });
  } catch {
    /* already gone */
  }
}


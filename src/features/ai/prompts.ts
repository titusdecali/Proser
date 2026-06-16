/** Saved revision prompts ("quick slots"), persisted at the project root as
 *  PROSER_PROMPTS.json. The revise card reads these to offer named one-click
 *  prompts and to let the author CRUD them. */
import * as vscode from 'vscode';

export interface SavedPrompt {
  name: string;
  prompt: string;
}

/** Shown when no PROSER_PROMPTS.json exists yet — a useful starting set. */
export const DEFAULT_PROMPTS: SavedPrompt[] = [
  { name: 'Tighten', prompt: 'Revise to be clearer and more concise while preserving the meaning and my voice.' },
  { name: 'Punch up', prompt: 'Make this more vivid and active — stronger verbs, less filler — without changing my voice.' },
  { name: 'Smooth', prompt: 'Improve the flow and rhythm and fix awkward phrasing. Keep the meaning and voice.' },
  { name: 'Show, don’t tell', prompt: 'Rewrite to show through action, sensory detail, and subtext rather than stating it outright.' },
  { name: 'Simplify', prompt: 'Simplify the wording and sentence structure for clarity, keeping the meaning intact.' }
];

const FILE = 'PROSER_PROMPTS.json';

/** The PROSER_PROMPTS.json location: the workspace folder owning `contextUri`,
 *  else the first workspace folder. Undefined when no folder is open. */
export function promptsFileUri(contextUri?: vscode.Uri): vscode.Uri | undefined {
  const folder =
    (contextUri ? vscode.workspace.getWorkspaceFolder(contextUri)?.uri : undefined) ??
    vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder ? vscode.Uri.joinPath(folder, FILE) : undefined;
}

function sanitize(list: unknown): SavedPrompt[] {
  const arr = Array.isArray(list)
    ? list
    : Array.isArray((list as { prompts?: unknown })?.prompts)
      ? (list as { prompts: unknown[] }).prompts
      : [];
  return (arr as Array<Partial<SavedPrompt>>)
    .filter((p) => p && typeof p.name === 'string' && typeof p.prompt === 'string')
    .map((p) => ({ name: (p.name as string).trim(), prompt: (p.prompt as string).trim() }))
    .filter((p) => p.name && p.prompt);
}

/** Reads saved prompts, falling back to the defaults when the file is absent. */
export async function readPrompts(contextUri?: vscode.Uri): Promise<SavedPrompt[]> {
  const uri = promptsFileUri(contextUri);
  if (!uri) {
    return [...DEFAULT_PROMPTS];
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const parsed = sanitize(JSON.parse(Buffer.from(bytes).toString('utf8')));
    return parsed.length ? parsed : [...DEFAULT_PROMPTS];
  } catch {
    return [...DEFAULT_PROMPTS];
  }
}

/** Writes the prompt list to PROSER_PROMPTS.json. Returns false if no folder. */
export async function writePrompts(list: SavedPrompt[], contextUri?: vscode.Uri): Promise<boolean> {
  const uri = promptsFileUri(contextUri);
  if (!uri) {
    void vscode.window.showWarningMessage('Open a folder or workspace to save Proser prompts.');
    return false;
  }
  const clean = sanitize(list);
  const data = Buffer.from(JSON.stringify(clean, null, 2) + '\n', 'utf8');
  await vscode.workspace.fs.writeFile(uri, data);
  return true;
}

import * as vscode from 'vscode';
import { fetchWithTimeout } from '../../util/fetchTimeout';
import { LOCAL_MODELS, localModelInfo, recommendLocalModel } from './ramAdvisor';
import { normalizeModelRef } from './modelRef';

type Item = vscode.QuickPickItem & { tag?: string; custom?: boolean };

/** Best-effort list of models already pulled in the local Ollama. */
async function fetchInstalledTags(endpoint: string): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(`${endpoint.replace(/\/$/, '')}/api/tags`);
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

/**
 * Lets the user choose a local Ollama model. The best fit for the machine is
 * starred; the curated top-5 Gemma 4 tiers are listed with size/RAM detail;
 * already-pulled models are offered too, plus a "Download another model…" entry
 * that accepts a Hugging Face or Ollama URL (or any tag) for anything else.
 */
export async function pickLocalModel(endpoint: string, current: string): Promise<string | undefined> {
  const [rec, installed] = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Proser: checking local models…' },
    () => Promise.all([recommendLocalModel(), fetchInstalledTags(endpoint)])
  );
  const installedSet = new Set(installed);

  const mark = (tag: string) => (installedSet.has(tag) || tag === current ? '$(check) ' : '');

  const items: Item[] = [];

  const recInfo = localModelInfo(rec.tag);
  items.push({
    label: `$(star) ${recInfo?.label ?? rec.tag}  ·  Recommended`,
    description: rec.tag,
    detail: `${rec.reason} ${rec.platformNote}`,
    tag: rec.tag
  });

  for (const m of LOCAL_MODELS) {
    if (m.tag === rec.tag) {
      continue;
    }
    items.push({
      label: `${mark(m.tag)}${m.label}`,
      description: m.tag,
      detail: `~${m.sizeGb} GB download · needs ~${m.minRamGb} GB RAM · ${m.note}`,
      tag: m.tag
    });
  }

  const curated = new Set(LOCAL_MODELS.map((m) => m.tag));
  const extras = installed.filter((t) => !curated.has(t));
  if (extras.length > 0) {
    items.push({ label: 'Already installed', kind: vscode.QuickPickItemKind.Separator });
    for (const t of extras) {
      items.push({ label: `$(check) ${t}`, detail: 'Already pulled', tag: t });
    }
  }

  items.push({
    label: '$(cloud-download) Download another model…',
    detail: 'Paste a Hugging Face or Ollama URL, or any Ollama tag',
    custom: true
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Select Local AI Model (Ollama)',
    placeHolder: 'The best fit for your machine is starred'
  });
  if (!picked) {
    return undefined;
  }
  if (picked.custom) {
    const entered = await vscode.window.showInputBox({
      title: 'Download a model',
      prompt: 'Hugging Face URL, Ollama library URL, or an Ollama tag',
      placeHolder: 'e.g. huggingface.co/bartowski/Model-GGUF · ollama.com/library/llama3.1 · qwen2.5:14b',
      ignoreFocusOut: true,
      validateInput: (v) =>
        normalizeModelRef(v) ? null : 'Enter a Hugging Face or Ollama URL, or an Ollama tag.'
    });
    return entered ? normalizeModelRef(entered) : undefined;
  }
  return picked.tag;
}

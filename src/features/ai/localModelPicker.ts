import * as vscode from 'vscode';
import { fetchWithTimeout } from '../../util/fetchTimeout';
import { LOCAL_MODELS, localModelInfo, recommendLocalModel } from './ramAdvisor';
import { normalizeModelRef } from './modelRef';

type Item = vscode.QuickPickItem & { tag?: string; custom?: boolean };
type Recommendation = Awaited<ReturnType<typeof recommendLocalModel>>;

/** Per-row button to remove a pulled model and reclaim its disk space. */
const trashButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('trash'),
  tooltip: 'Delete this model from disk (frees space)'
};

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

/** Removes a pulled model from the local Ollama (`DELETE /api/delete`). */
async function deleteInstalledModel(endpoint: string, tag: string): Promise<void> {
  const res = await fetchWithTimeout(
    `${endpoint.replace(/\/$/, '')}/api/delete`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      // `model` is the current field; `name` covers older Ollama builds.
      body: JSON.stringify({ model: tag, name: tag })
    },
    8000
  );
  if (!res.ok) {
    throw new Error(`Ollama responded ${res.status}.`);
  }
}

/** Builds the picker rows. Installed models carry a trash button so they can be
 *  deleted in place to free disk space. */
function buildItems(rec: Recommendation, installed: string[], current: string): Item[] {
  const installedSet = new Set(installed);
  // $(check) means ACTIVE (the model in use) — and only that. Installed-but-
  // inactive models carry a trash button and an "installed" note instead, so the
  // one active model is unmistakable rather than lost among "installed" checks.
  const activeIcon = (tag: string) => (tag === current ? '$(check) ' : '');
  const activeNote = (tag: string) => (tag === current ? '  ·  ✓ Active' : '');
  const installedNote = (tag: string) =>
    tag !== current && installedSet.has(tag) ? ' · installed' : '';
  const delBtns = (tag: string) => (installedSet.has(tag) ? [trashButton] : undefined);

  const items: Item[] = [];

  const recInfo = localModelInfo(rec.tag);
  items.push({
    label: `$(star) ${activeIcon(rec.tag)}${recInfo?.label ?? rec.tag}  ·  Recommended${activeNote(rec.tag)}`,
    description: rec.tag,
    detail: `${rec.reason} ${rec.platformNote}`,
    tag: rec.tag,
    buttons: delBtns(rec.tag)
  });

  for (const m of LOCAL_MODELS) {
    if (m.tag === rec.tag) {
      continue;
    }
    items.push({
      label: `${activeIcon(m.tag)}${m.label}${activeNote(m.tag)}`,
      description: m.tag,
      detail: `~${m.sizeGb} GB download · needs ~${m.minRamGb} GB RAM · ${m.note}${installedNote(m.tag)}`,
      tag: m.tag,
      buttons: delBtns(m.tag)
    });
  }

  const curated = new Set(LOCAL_MODELS.map((m) => m.tag));
  const extras = installed.filter((t) => !curated.has(t));
  if (extras.length > 0) {
    items.push({ label: 'Downloaded (other)', kind: vscode.QuickPickItemKind.Separator });
    for (const t of extras) {
      items.push({
        label: `${activeIcon(t)}${t}${activeNote(t)}`,
        detail: 'Installed locally',
        tag: t,
        buttons: [trashButton]
      });
    }
  }

  items.push({
    label: '$(cloud-download) Download another model…',
    detail: 'Paste a Hugging Face or Ollama URL, or any Ollama tag',
    custom: true
  });

  return items;
}

type PickResult = { tag: string } | { custom: true };

/** A live QuickPick that lets the user choose a model and delete pulled ones in
 *  place (trash button → confirm → DELETE → refresh). Resolves the chosen model
 *  (or the "download another" sentinel), or undefined if dismissed. */
function runPicker(endpoint: string, current: string, rec: Recommendation): Promise<PickResult | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = 'Select Local AI Model (Ollama)';
    qp.placeholder = `Active: ${current}  ·  ✓ = in use · ★ = best fit · 🗑 deletes a pulled model`;
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;

    let settled = false;
    const finish = (v?: PickResult) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
      qp.hide();
    };

    const refresh = async () => {
      qp.busy = true;
      const installed = await fetchInstalledTags(endpoint);
      qp.items = buildItems(rec, installed, current);
      // Land the highlight on the active model so it's obvious which is in use.
      const active = qp.items.find((i) => i.tag === current);
      if (active) {
        qp.activeItems = [active];
      }
      qp.busy = false;
    };

    qp.onDidTriggerItemButton(async (e) => {
      const tag = e.item.tag;
      if (!tag) {
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Delete the local model “${tag}”? This removes it from disk and can't be undone.`,
        { modal: true },
        'Delete'
      );
      if (choice !== 'Delete') {
        return;
      }
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Deleting ${tag}…` },
          () => deleteInstalledModel(endpoint, tag)
        );
        vscode.window.showInformationMessage(`Deleted local model “${tag}”.`);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Couldn't delete “${tag}”: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      await refresh();
    });

    qp.onDidAccept(() => {
      const picked = qp.selectedItems[0];
      if (!picked) {
        return;
      }
      if (picked.custom) {
        finish({ custom: true });
      } else if (picked.tag) {
        finish({ tag: picked.tag });
      }
    });

    qp.onDidHide(() => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
      qp.dispose();
    });

    void refresh();
    qp.show();
  });
}

/**
 * Lets the user choose a local Ollama model. The best fit for the machine is
 * starred; the curated Gemma tiers list size/RAM detail; already-pulled models
 * are offered too — each with a trash button to delete it and reclaim space —
 * plus a "Download another model…" entry that accepts a Hugging Face or Ollama
 * URL (or any tag) for anything else.
 */
export async function pickLocalModel(endpoint: string, current: string): Promise<string | undefined> {
  const rec = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Proser: checking local models…' },
    () => recommendLocalModel()
  );

  const result = await runPicker(endpoint, current, rec);
  if (!result) {
    return undefined;
  }
  if ('custom' in result) {
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
  return result.tag;
}

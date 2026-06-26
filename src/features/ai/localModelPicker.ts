import * as vscode from 'vscode';
import { fetchWithTimeout } from '../../util/fetchTimeout';
import {
  LocalModel,
  LOCAL_MODELS,
  localModelInfo,
  recommendLocalModel,
  detectMemoryProfile,
  modelFits,
  MemoryProfile
} from './ramAdvisor';
import { normalizeModelRef } from './modelRef';

type Item = vscode.QuickPickItem & { tag?: string; custom?: boolean };
type Recommendation = ReturnType<typeof recommendLocalModel>;

/** Everything the model picker needs: which models to list, how to label them, and
 *  the system-aware recommendation. (Single-model design — one editor model serves
 *  Brainstorm, Revise, Synonyms, and Spell, so there's no separate helper picker.) */
interface Catalog {
  title: string;
  models: LocalModel[];
  info: (tag: string) => LocalModel | undefined;
  recommend: (p: MemoryProfile) => Recommendation;
}

const MAIN_CATALOG: Catalog = {
  title: 'Select AI Model (Ollama)',
  models: LOCAL_MODELS,
  info: localModelInfo,
  recommend: recommendLocalModel
};

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

/**
 * Prompts for a model reference (Hugging Face URL, Ollama library URL, or a bare
 * Ollama tag) and normalizes it to a pullable tag. Returns undefined if cancelled
 * or invalid. Shared by the picker's "Download another model…" row and the inline
 * Settings "Custom…" dropdown entry.
 */
export async function promptCustomModelRef(): Promise<string | undefined> {
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

/**
 * Lets the user pick one of the locally-installed Ollama models and delete it
 * from disk (QuickPick → modal confirm → `DELETE /api/delete`). Used by the inline
 * Settings "Remove a download…" dropdown entry.
 */
export async function removeDownloadedModel(endpoint: string): Promise<void> {
  const installed = await fetchInstalledTags(endpoint);
  if (installed.length === 0) {
    vscode.window.showInformationMessage('No downloaded Ollama models to remove.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    installed.map((tag) => ({ label: tag, detail: 'Installed locally' })),
    { title: 'Remove a downloaded model', placeHolder: 'Select a model to delete from disk (frees space)' }
  );
  if (!pick) {
    return;
  }
  const tag = pick.label;
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

/** Builds the picker rows. Only models that run stably on this system are offered
 *  as picks; a model that needs more memory than the machine has is never shown as
 *  a choice (even if already pulled — selecting it would just OOM). An installed but
 *  too-big model is demoted to a "won't run here" section so its disk can be freed.
 *  Installed models carry a trash button. */
function buildItems(
  rec: Recommendation,
  installed: string[],
  current: string,
  catalog: Catalog,
  profile: MemoryProfile
): Item[] {
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

  const recInfo = catalog.info(rec.tag);
  items.push({
    label: `$(star) ${activeIcon(rec.tag)}${recInfo?.label ?? rec.tag}  ·  Recommended${activeNote(rec.tag)}`,
    description: rec.tag,
    detail: `${rec.reason} ${rec.platformNote}`,
    tag: rec.tag,
    buttons: delBtns(rec.tag)
  });

  let hidden = 0;
  const unfitInstalled: string[] = [];
  for (const m of catalog.models) {
    if (m.tag === rec.tag) {
      continue;
    }
    // A model that won't run here is never a pick: hide it (or, if already pulled,
    // demote it to the deletable "won't run here" section below). This keeps models
    // that far exceed the machine's memory out of the list entirely.
    if (!modelFits(m, profile)) {
      if (installedSet.has(m.tag)) {
        unfitInstalled.push(m.tag);
      } else {
        hidden++;
      }
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
  if (hidden > 0) {
    items.push({
      label: `$(info) ${hidden} larger model${hidden === 1 ? '' : 's'} hidden — need more memory than your ${profile.label}`,
      detail: 'Use “Download another model…” below to install one anyway.',
      tag: undefined
    });
  }

  const curated = new Set(catalog.models.map((m) => m.tag));
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

  if (unfitInstalled.length > 0) {
    items.push({ label: 'Installed · won’t run on this machine', kind: vscode.QuickPickItemKind.Separator });
    for (const t of unfitInstalled) {
      const info = catalog.info(t);
      items.push({
        label: `$(warning) ${info?.label ?? t}`,
        description: t,
        detail: `Too big for your ${profile.label} (needs ~${info?.minRamGb ?? '?'} GB) — delete to free ~${info?.sizeGb ?? '?'} GB`,
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
function runPicker(endpoint: string, current: string, rec: Recommendation, catalog: Catalog, profile: MemoryProfile): Promise<PickResult | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = `${catalog.title} · ${profile.label}`;
    qp.placeholder = `Showing models that run stably on your system  ·  ✓ = in use · ★ = best fit · 🗑 deletes a pulled model`;
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
      qp.items = buildItems(rec, installed, current, catalog, profile);
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
        return;
      }
      if (picked.tag) {
        // Block selecting a model that can't run here (the demoted "won't run"
        // rows) — it would only OOM. The trash button still works to delete it.
        const info = catalog.info(picked.tag);
        if (info && picked.tag !== current && !modelFits(info, profile)) {
          void vscode.window.showWarningMessage(
            `“${picked.tag}” needs more memory than your ${profile.label} and would run out of memory. Delete it (🗑) or choose a smaller model.`
          );
          return;
        }
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
  return pickFromCatalog(endpoint, current, MAIN_CATALOG);
}

async function pickFromCatalog(endpoint: string, current: string, catalog: Catalog): Promise<string | undefined> {
  const profile = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Proser: checking your system…' },
    () => detectMemoryProfile()
  );
  const rec = catalog.recommend(profile);

  const result = await runPicker(endpoint, current, rec, catalog, profile);
  if (!result) {
    return undefined;
  }
  if ('custom' in result) {
    return promptCustomModelRef();
  }
  return result.tag;
}

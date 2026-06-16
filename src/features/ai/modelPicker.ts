import * as vscode from 'vscode';
import { fetchWithTimeout } from '../../util/fetchTimeout';

interface CuratedModel {
  label: string;
  slug: string;
  detail: string;
}

/** Recommended writing models on OpenRouter. The default (Scout) is fast via
 *  Groq; Gemma options are included per the user's preference. Slugs are
 *  best-effort verified against the live model list before being offered. */
const CURATED: CuratedModel[] = [
  {
    label: 'Llama 4 Scout',
    slug: 'meta-llama/llama-4-scout',
    detail: 'Fast (Groq). Recommended default.'
  },
  {
    label: 'Llama 4 Maverick',
    slug: 'meta-llama/llama-4-maverick',
    detail: 'Higher quality, a little slower.'
  },
  {
    label: 'Gemma 3 27B',
    slug: 'google/gemma-3-27b-it',
    detail: 'Strong prose, Google Gemma.'
  },
  {
    label: 'Gemma 2 9B',
    slug: 'google/gemma-2-9b-it',
    detail: 'Lighter Gemma option.'
  }
];

/** Best-effort fetch of available model ids (public endpoint, no key needed). */
async function fetchAvailableModelIds(): Promise<Set<string> | undefined> {
  try {
    const res = await fetchWithTimeout('https://openrouter.ai/api/v1/models');
    if (!res.ok) {
      return undefined;
    }
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return new Set((data.data ?? []).map((m) => m.id));
  } catch {
    return undefined;
  }
}

/** Shows the curated picker (plus a custom-slug entry). Returns the chosen
 *  model slug, or undefined if cancelled. */
export async function pickOpenRouterModel(current: string): Promise<string | undefined> {
  const available = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Proser: loading models…' },
    () => fetchAvailableModelIds()
  );

  type Item = vscode.QuickPickItem & { slug?: string; custom?: boolean };
  const items: Item[] = CURATED.map((m) => {
    const unavailable = available && !available.has(m.slug);
    return {
      label: m.slug === current ? `$(check) ${m.label}` : m.label,
      description: m.slug,
      detail: unavailable ? `${m.detail}  —  ⚠ not currently available` : m.detail,
      slug: m.slug
    };
  });
  items.push({ label: '$(edit) Custom model slug…', custom: true });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Select AI Model (OpenRouter)',
    placeHolder: 'Pick a model for AI features'
  });
  if (!picked) {
    return undefined;
  }

  if (picked.custom) {
    const slug = await vscode.window.showInputBox({
      title: 'Custom OpenRouter model slug',
      value: current,
      placeHolder: 'e.g. anthropic/claude-3.5-sonnet',
      validateInput: (v) =>
        v.includes('/') ? null : 'A model slug looks like “vendor/model”.'
    });
    return slug?.trim() || undefined;
  }

  return picked.slug;
}

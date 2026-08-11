import * as vscode from 'vscode';
import { SecretStore } from './secretStore';

/** The full "go to cloud" flow used by every Cloud (OpenRouter) entry point: first
 *  offer the API-key input (pre-filled with the current key so it can be confirmed
 *  or changed — the key powers Brainstorm/Revise), then the model picker. Returns
 *  the chosen slug, or undefined if the user backs out of either step. */
export async function pickOpenRouterModelWithKey(
  secrets: SecretStore,
  current: string
): Promise<string | undefined> {
  const existing = await secrets.getApiKey();
  if (!(await secrets.promptForApiKey(existing ?? undefined))) {
    return undefined;
  }
  return pickOpenRouterModel(current);
}

const MODELS_URL = 'https://openrouter.ai/models';
const EXAMPLE_SLUG = 'google/gemini-3.5-flash-lite';

interface CuratedModel {
  /** Group heading this model sits under. */
  group: string;
  slug: string;
  label: string;
  /** Approximate price per million tokens, in → out. OpenRouter sets these and
   *  can change them; the globe button opens the live price list. */
  price: string;
  note: string;
}

/** A short, opinionated list for writers, so nobody has to read a 400-model
 *  catalogue to start. Every slug can still be typed by hand instead. */
const CURATED: CuratedModel[] = [
  {
    group: 'Free',
    slug: 'google/gemma-4-31b-it:free',
    label: 'Gemma 4 · 31B (free)',
    price: 'no cost',
    note: 'The same model family Proser runs locally, hosted for free. Rate-limited at busy times.'
  },
  {
    group: 'Cheap and fast',
    slug: 'qwen/qwen3.7-flash',
    label: 'Qwen 3.7 Flash',
    price: '~$0.03 / $0.13',
    note: 'The cheapest useful option — quick line edits and synonyms.'
  },
  {
    group: 'Cheap and fast',
    slug: 'google/gemma-3-12b-it',
    label: 'Gemma 3 · 12B',
    price: '~$0.05 / $0.15',
    note: 'Small, plain-spoken, and very cheap. Good for rewrites of a paragraph.'
  },
  {
    group: 'Cheap and fast',
    slug: 'google/gemma-4-26b-a4b-it',
    label: 'Gemma 4 · 26B',
    price: '~$0.12 / $0.40',
    note: 'Mixture-of-experts, so it answers like a small model but writes like a large one.'
  },
  {
    group: 'Cheap and fast',
    slug: 'deepseek/deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    price: '~$0.14 / $0.28',
    note: 'Strong all-round writer for the price.'
  },
  {
    group: 'Everyday',
    slug: EXAMPLE_SLUG,
    label: 'Gemini 3.5 Flash Lite',
    price: '~$0.30 / $2.50',
    note: 'Fast, 1M-token context — it can hold a whole novel. A good default.'
  },
  {
    group: 'Everyday',
    slug: 'openai/gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    price: '~$0.10 / $0.60',
    note: 'Cheap OpenAI model; tidy, conventional prose.'
  },
  {
    group: 'Best prose',
    slug: 'anthropic/claude-sonnet-5',
    label: 'Claude Sonnet 5',
    price: '~$2.00 / $10.00',
    note: 'The strongest writer here for voice and dialogue. Costs the most.'
  }
];

interface ModelItem extends vscode.QuickPickItem {
  /** The slug to return, or undefined for the "type it yourself" row. */
  slug?: string;
  manual?: boolean;
}

/** Curated rows, grouped under separators, with the current model pinned on top
 *  when it isn't one of them. */
function buildItems(current: string): ModelItem[] {
  const items: ModelItem[] = [];
  const trimmed = current.trim();
  if (trimmed && !CURATED.some((m) => m.slug === trimmed)) {
    items.push({ label: 'In use', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: trimmed, description: 'current model', slug: trimmed });
  }
  let group = '';
  for (const model of CURATED) {
    if (model.group !== group) {
      group = model.group;
      items.push({ label: group, kind: vscode.QuickPickItemKind.Separator });
    }
    items.push({
      label: (model.slug === trimmed ? '$(check) ' : '') + model.label,
      description: `${model.price}  ·  ${model.slug}`,
      detail: model.note,
      slug: model.slug
    });
  }
  items.push({ label: 'Other', kind: vscode.QuickPickItemKind.Separator });
  items.push({
    label: '$(edit) Enter a model name…',
    detail: `Any slug from openrouter.ai/models, e.g. ${EXAMPLE_SLUG}`,
    manual: true
  });
  return items;
}

/** Lets the user pick the OpenRouter model for Brainstorm & Revise: a short
 *  curated list of models that suit writing, or their own slug. Prices are per
 *  million tokens (input → output) and are approximate — the globe button opens
 *  the live list. Returns the slug, or undefined if cancelled. */
export function pickOpenRouterModel(current: string): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const quickPick = vscode.window.createQuickPick<ModelItem>();
    quickPick.title = 'OpenRouter Model';
    quickPick.placeholder = 'Pick a model for Brainstorm & Revise — prices are per million tokens (in / out)';
    quickPick.ignoreFocusOut = true;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.buttons = [{ iconPath: new vscode.ThemeIcon('globe'), tooltip: 'Browse models on openrouter.ai' }];
    quickPick.items = buildItems(current);
    const selected = quickPick.items.find((i) => i.slug === current.trim());
    if (selected) {
      quickPick.activeItems = [selected];
    }

    let done = false;
    const finish = (value: string | undefined): void => {
      if (done) {
        return;
      }
      done = true;
      resolve(value);
      quickPick.dispose();
    };

    quickPick.onDidTriggerButton(() => void vscode.env.openExternal(vscode.Uri.parse(MODELS_URL)));
    quickPick.onDidAccept(() => {
      const item = quickPick.selectedItems[0];
      if (!item) {
        return;
      }
      if (item.manual) {
        // Hand off to the free-text input; hiding first keeps one dialog on screen.
        done = true;
        quickPick.dispose();
        void promptForSlug(current).then(resolve);
        return;
      }
      finish(item.slug);
    });
    quickPick.onDidHide(() => finish(undefined));
    quickPick.show();
  });
}

/** Free-text entry for any slug the curated list doesn't carry. */
function promptForSlug(current: string): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const input = vscode.window.createInputBox();
    input.title = 'OpenRouter Model';
    input.prompt =
      'Enter the exact OpenRouter model name for Brainstorm & Revise. ' +
      `Click the globe to browse models.${current ? ` Current: ${current}.` : ''}`;
    input.placeholder = EXAMPLE_SLUG;
    input.value = current.trim();
    input.ignoreFocusOut = true;
    input.buttons = [{ iconPath: new vscode.ThemeIcon('globe'), tooltip: 'Browse models on openrouter.ai' }];

    let done = false;
    const finish = (value: string | undefined): void => {
      if (done) {
        return;
      }
      done = true;
      resolve(value);
      input.dispose();
    };

    input.onDidTriggerButton(() => void vscode.env.openExternal(vscode.Uri.parse(MODELS_URL)));
    input.onDidChangeValue(() => {
      input.validationMessage = undefined;
    });
    input.onDidAccept(() => {
      const value = input.value.trim();
      if (!value.includes('/')) {
        input.validationMessage = `A model name looks like “vendor/model”, e.g. ${EXAMPLE_SLUG}.`;
        return;
      }
      finish(value);
    });
    input.onDidHide(() => finish(undefined));
    input.show();
  });
}

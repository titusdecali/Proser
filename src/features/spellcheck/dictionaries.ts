import * as vscode from 'vscode';
import { DictData } from './spellEngine';

export interface LanguageInfo {
  id: string;
  label: string;
  /** English ships in the extension; everything else downloads on first use. */
  bundled: boolean;
}

/**
 * Supported spell-check languages. English is bundled; the rest are Hunspell
 * dictionaries pulled from jsDelivr on first use and cached on disk.
 *
 * Korean/CJK are intentionally absent: nspell can't process their Hunspell
 * affix rules — it silently accepts every token (benchmarked: 0 typos caught),
 * which is worse than no spell-check. They'd need an online service instead.
 */
export const LANGUAGES: LanguageInfo[] = [
  { id: 'en', label: 'English', bundled: true },
  { id: 'es', label: 'Spanish — Español', bundled: false },
  { id: 'fr', label: 'French — Français', bundled: false },
  { id: 'de', label: 'German — Deutsch', bundled: false },
  { id: 'it', label: 'Italian — Italiano', bundled: false },
  { id: 'pt', label: 'Portuguese — Português', bundled: false },
  { id: 'nl', label: 'Dutch — Nederlands', bundled: false },
  { id: 'ru', label: 'Russian — Русский', bundled: false }
];

/** Pinned dictionary versions so the on-disk cache key stays stable. */
const VERSIONS: Record<string, string> = {
  es: '4.0.0',
  fr: '3.0.0',
  de: '3.0.0',
  it: '2.0.0',
  pt: '4.0.0',
  nl: '2.0.0',
  ru: '3.0.0'
};

export function languageLabel(lang: string): string {
  return LANGUAGES.find((l) => l.id === lang)?.label ?? lang;
}

function dictDir(context: vscode.ExtensionContext, lang: string): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, 'dictionaries', lang);
}

/**
 * Loads the Hunspell data for a language: English from the bundle, others from
 * the on-disk cache (downloading once if absent). Returns undefined on failure
 * (e.g. offline on first use) — the caller degrades to "no spell-check".
 */
export async function loadDictionary(
  context: vscode.ExtensionContext,
  lang: string
): Promise<DictData[] | undefined> {
  if (lang === 'en') {
    const [us, gb] = await Promise.all([
      import('dictionary-en').then((m) => m.default as DictData),
      import('dictionary-en-gb').then((m) => m.default as DictData)
    ]);
    return [us, gb];
  }
  const cached = await readCached(context, lang);
  if (cached) {
    return [cached];
  }
  const fetched = await downloadDictionary(context, lang);
  return fetched ? [fetched] : undefined;
}

/** Whether a language's dictionary is ready to use without a download. */
export async function isDownloaded(context: vscode.ExtensionContext, lang: string): Promise<boolean> {
  if (lang === 'en') {
    return true;
  }
  return (await readCached(context, lang)) !== undefined;
}

async function readCached(context: vscode.ExtensionContext, lang: string): Promise<DictData | undefined> {
  try {
    const dir = dictDir(context, lang);
    const aff = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, 'index.aff'));
    const dic = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, 'index.dic'));
    return { aff: Buffer.from(aff), dic: Buffer.from(dic) };
  } catch {
    return undefined;
  }
}

async function downloadDictionary(
  context: vscode.ExtensionContext,
  lang: string
): Promise<DictData | undefined> {
  const version = VERSIONS[lang];
  const label = languageLabel(lang);
  if (!version) {
    return undefined;
  }
  const base = `https://cdn.jsdelivr.net/npm/dictionary-${lang}@${version}`;
  try {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Proser: downloading the ${label} dictionary…`
      },
      async () => {
        const [affRes, dicRes] = await Promise.all([
          fetch(`${base}/index.aff`),
          fetch(`${base}/index.dic`)
        ]);
        if (!affRes.ok || !dicRes.ok) {
          throw new Error(`HTTP ${affRes.status} / ${dicRes.status}`);
        }
        const aff = Buffer.from(await affRes.arrayBuffer());
        const dic = Buffer.from(await dicRes.arrayBuffer());
        const dir = dictDir(context, lang);
        await vscode.workspace.fs.createDirectory(dir);
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'index.aff'), aff);
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'index.dic'), dic);
        return { aff, dic };
      }
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Couldn't download the ${label} dictionary: ${err instanceof Error ? err.message : String(err)}. Check your connection and try again.`
    );
    return undefined;
  }
}

import * as vscode from 'vscode';
import { Commands, ConfigKeys, EXTENSION_ID } from '../../constants';
import { SpellService } from './spellService';
import { LANGUAGES, isDownloaded } from './dictionaries';

/**
 * Spell-check feature wiring. Spelling no longer publishes `vscode.Diagnostic`s
 * to the Problems panel — it surfaces as inline squiggles in the Pretty editor
 * and in the Spelling sidebar, both driven by the shared {@link SpellService}.
 * This registers the two commands those surfaces share: "Add to dictionary" and
 * "Select Spell Check Language".
 */
export function registerSpellCheck(context: vscode.ExtensionContext, service: SpellService): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.addToDictionary, (word?: string) => {
      if (word) {
        void service.add(word);
      }
    }),
    vscode.commands.registerCommand(Commands.spellSelectLanguage, () => selectLanguage(context))
  );
}

/** Quick-pick of supported languages (marking the current one and what's already
 *  downloaded), writing the choice to settings — the service reloads/downloads. */
async function selectLanguage(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
  const current = cfg.get<string>(ConfigKeys.spellcheckLanguage, 'en');

  type Item = vscode.QuickPickItem & { lang: string };
  const items: Item[] = await Promise.all(
    LANGUAGES.map(async (l) => ({
      label: `${l.id === current ? '$(check) ' : ''}${l.label}`,
      description: l.bundled
        ? 'built in'
        : (await isDownloaded(context, l.id))
          ? 'downloaded'
          : 'downloads on first use',
      lang: l.id
    }))
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Spell Check Language',
    placeHolder: 'Choose the language to spell-check in (non-English downloads once, then works offline)'
  });
  if (picked && picked.lang !== current) {
    await cfg.update(ConfigKeys.spellcheckLanguage, picked.lang, vscode.ConfigurationTarget.Global);
  }
}

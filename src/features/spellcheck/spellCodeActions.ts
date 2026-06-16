import * as vscode from 'vscode';
import { Commands } from '../../constants';
import { SpellEngine } from './spellEngine';

export const SPELL_SOURCE = 'Proser';
export const SPELL_CODE = 'spelling';

/** Offers "replace with suggestion" and "add to dictionary" quick-fixes for
 *  Proser's spelling diagnostics. */
export class SpellCodeActions implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
  };

  constructor(private readonly engine: SpellEngine) {}

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== SPELL_SOURCE || diagnostic.code !== SPELL_CODE) {
        continue;
      }
      const word = document.getText(diagnostic.range);

      for (const suggestion of this.engine.suggest(word)) {
        const fix = new vscode.CodeAction(
          `Replace with “${suggestion}”`,
          vscode.CodeActionKind.QuickFix
        );
        fix.diagnostics = [diagnostic];
        fix.edit = new vscode.WorkspaceEdit();
        fix.edit.replace(document.uri, diagnostic.range, suggestion);
        actions.push(fix);
      }

      const add = new vscode.CodeAction(
        `Add “${word}” to dictionary`,
        vscode.CodeActionKind.QuickFix
      );
      add.diagnostics = [diagnostic];
      add.command = {
        command: Commands.addToDictionary,
        title: 'Add to dictionary',
        arguments: [word]
      };
      actions.push(add);
    }
    return actions;
  }
}

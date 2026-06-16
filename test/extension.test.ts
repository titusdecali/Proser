import * as assert from 'assert';
import * as vscode from 'vscode';
import { countMarkdownWords } from '../src/util/wordcount';

const EXPECTED_COMMANDS = [
  'proser.synonyms',
  'proser.antonyms',
  'proser.countWordsInSelection',
  'proser.addToDictionary',
  'proser.openPretty',
  'proser.openPrettyToSide',
  'proser.setWordGoal',
  'proser.showWordStats',
  'proser.toggleFocusMode',
  'proser.toggleTypewriterMode',
  'proser.useAiSynonyms',
  'proser.useLocalSynonyms',
  'proser.reviseWithAI',
  'proser.ai.setApiKey',
  'proser.ai.clearKey',
  'proser.ai.selectModel',
  'proser.ai.setupLocal'
];

describe('Proser extension', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('titusdecali.proser');
    assert.ok(ext, 'extension should be present');
    await ext!.activate();
  });

  it('registers all contributed commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of EXPECTED_COMMANDS) {
      assert.ok(commands.includes(command), `missing command: ${command}`);
    }
  });

  it('counts words via the status-bar logic on a markdown document', async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: '# Title\n\nThe quick brown fox.\n'
    });
    await vscode.window.showTextDocument(doc);
    // "Title" + "The quick brown fox" = 5 words (heading markers excluded).
    assert.strictEqual(countMarkdownWords(doc.getText()), 5);
  });
});

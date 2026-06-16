import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Headless smoke tests that drive the real flows inside the VS Code Extension
 * Host (the same runtime F5 uses). They cover everything with an observable
 * effect: spell-check diagnostics, quality lint, add-to-dictionary, the outline
 * provider, the explorer word-count command, the custom editor, and focus mode.
 *
 * Flows that block on user UI (QuickPick/InputBox in Synonyms and Revise-with-AI)
 * and the live AI backends are out of scope here and need a human glance under F5.
 */

const tmpFiles: string[] = [];

function writeTemp(name: string, content: string): vscode.Uri {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proser-smoke-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  tmpFiles.push(file);
  return vscode.Uri.file(file);
}

async function openMarkdown(uri: vscode.Uri): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  return doc;
}

async function waitFor<T>(
  poll: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 15000,
  intervalMs = 150
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await poll();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function flattenSymbols(symbols: vscode.DocumentSymbol[]): string[] {
  const names: string[] = [];
  for (const s of symbols) {
    names.push(s.name);
    if (s.children?.length) {
      names.push(...flattenSymbols(s.children));
    }
  }
  return names;
}

function proserDiagnostics(uri: vscode.Uri, code?: string): vscode.Diagnostic[] {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((d) => d.source === 'Proser' && (code === undefined || d.code === code));
}

describe('Proser smoke (Extension Host)', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('titusdecali.proser');
    assert.ok(ext, 'extension present');
    await ext!.activate();
  });

  after(() => {
    for (const f of tmpFiles) {
      try {
        fs.rmSync(path.dirname(f), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('spell check flags misspellings in a .md file, and add-to-dictionary clears them', async () => {
    const uri = writeTemp('spell.md', 'This sentance has a mispeling in it.\n');
    await openMarkdown(uri);

    const diags = await waitFor(() => {
      const d = proserDiagnostics(uri, 'spelling');
      return d.length > 0 ? d : undefined;
    });
    const flagged = diags.map((d) => vscode.workspace.textDocuments
      .find((t) => t.uri.toString() === uri.toString())!
      .getText(d.range).toLowerCase());
    assert.ok(flagged.includes('sentance'), `expected "sentance" flagged, got ${flagged.join(', ')}`);

    // Add one of the flagged words to the dictionary and confirm it clears.
    await vscode.commands.executeCommand('proser.addToDictionary', 'sentance');
    await waitFor(() => {
      const remaining = proserDiagnostics(uri, 'spelling').map((d) =>
        vscode.workspace.textDocuments
          .find((t) => t.uri.toString() === uri.toString())!
          .getText(d.range).toLowerCase()
      );
      return remaining.includes('sentance') ? undefined : true;
    });
  });

  it('quality lint flags filler words in a .md file', async () => {
    const uri = writeTemp('quality.md', 'This is a very really important and simply great idea.\n');
    await openMarkdown(uri);
    const diags = await waitFor(() => {
      const d = proserDiagnostics(uri, 'weasel');
      return d.length > 0 ? d : undefined;
    });
    assert.ok(diags.length >= 2, `expected >=2 filler flags, got ${diags.length}`);
  });

  it('outline provider surfaces the document headings', async () => {
    const uri = writeTemp('outline.md', '# Alpha\n\nbody\n\n## Beta\n\nbody\n\n# Gamma\n');
    const doc = await openMarkdown(uri);
    // executeDocumentSymbolProvider merges all providers (incl. the built-in
    // markdown one), so assert the headings are present rather than exact shape.
    const names = await waitFor(async () => {
      const s = (await vscode.commands.executeCommand(
        'vscode.executeDocumentSymbolProvider',
        doc.uri
      )) as vscode.DocumentSymbol[] | undefined;
      if (!s || s.length === 0) {
        return undefined;
      }
      const flat = flattenSymbols(s);
      return flat.includes('Alpha') && flat.includes('Beta') && flat.includes('Gamma')
        ? flat
        : undefined;
    });
    assert.ok(names.includes('Alpha') && names.includes('Beta') && names.includes('Gamma'));
  });

  it('explorer word-count command runs over a selection of files', async () => {
    const a = writeTemp('a.md', 'one two three\n');
    const b = writeTemp('b.md', 'four five\n');
    // Should resolve without throwing (reports via a non-blocking notification).
    await vscode.commands.executeCommand('proser.countWordsInSelection', a, [a, b]);
  });

  it('opens a .md file in the Proser custom editor and the document stays editable', async () => {
    const uri = writeTemp('pretty.md', '# Hello\n\nSome prose.\n');
    await vscode.commands.executeCommand('vscode.openWith', uri, 'proser.markdownEditor');
    // The backing document must still be a normal, editable TextDocument.
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(0, 0), 'X');
    const applied = await vscode.workspace.applyEdit(edit);
    assert.ok(applied, 'WorkspaceEdit applied to the custom-editor document');
    const doc = vscode.workspace.textDocuments.find((t) => t.uri.toString() === uri.toString())!;
    assert.ok(doc.getText().startsWith('X#'), 'edit reflected in the document');
    // Leave the (now-dirty) editor open: closing it headlessly could trigger a
    // blocking save prompt. The host tears it down at the end of the run.
  });

  it('opening the pretty editor does not dirty the document (incl. frontmatter)', async () => {
    const uri = writeTemp(
      'clean.md',
      '---\ntitle: Test\nauthor: Me\n---\n\n# Title\n\nSome **bold** prose.\n\n- one\n- two\n'
    );
    await vscode.commands.executeCommand('vscode.openWith', uri, 'proser.markdownEditor');
    // Allow the webview to initialize/normalize past the init guard.
    await new Promise((r) => setTimeout(r, 1500));
    const doc = vscode.workspace.textDocuments.find((t) => t.uri.toString() === uri.toString());
    assert.ok(doc, 'document is open');
    assert.strictEqual(doc!.isDirty, false, 'opening the pretty editor must not mark the file dirty');
  });

  it('focus and typewriter modes toggle independently without error', async () => {
    const uri = writeTemp('focus.md', 'para one\n\npara two\n\npara three\n');
    await openMarkdown(uri);
    await vscode.commands.executeCommand('proser.toggleFocusMode');
    await vscode.commands.executeCommand('proser.toggleTypewriterMode');
    await vscode.commands.executeCommand('proser.toggleFocusMode');
    await vscode.commands.executeCommand('proser.toggleTypewriterMode');
  });
});

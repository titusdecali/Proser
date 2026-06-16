import * as vscode from 'vscode';
import { ConfigKeys, EXTENSION_ID, MARKDOWN_LANGUAGE_ID } from '../../constants';
import { createKeyedDebouncer } from '../../util/debounce';
import { getProseSpans } from '../../util/markdownScan';

const QUALITY_SOURCE = 'Proser';
const CODE_WEASEL = 'weasel';
const CODE_PASSIVE = 'passive';
const MAX_DOC_SIZE = 500_000;

/** Filler / weasel / intensifier words that usually weaken prose. */
const WEASEL_WORDS = [
  'very', 'really', 'quite', 'rather', 'somewhat', 'just', 'actually', 'basically',
  'literally', 'simply', 'fairly', 'pretty', 'totally', 'completely', 'extremely',
  'definitely', 'probably', 'virtually', 'essentially', 'clearly', 'obviously'
];
const WEASEL_RE = new RegExp(`\\b(${WEASEL_WORDS.join('|')})\\b`, 'giu');

/** Conservative passive-voice heuristic: a "to be" form followed by a past
 *  participle (regular -ed or a common irregular). */
const PASSIVE_RE =
  /\b(was|were|is|are|been|being|be)\s+(\w+ed|written|done|made|taken|given|seen|known|shown|held|kept|told|found|built|sent|paid|lost|won|left|drawn|brought|bought|caught)\b/giu;

export function registerQualityLint(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection('proser-quality');
  context.subscriptions.push(collection);

  const debouncer = createKeyedDebouncer(1000);
  context.subscriptions.push({ dispose: () => debouncer.dispose() });

  function enabled(): boolean {
    return vscode.workspace
      .getConfiguration(EXTENSION_ID)
      .get<boolean>(ConfigKeys.qualityLintEnabled, true);
  }

  function isTarget(doc: vscode.TextDocument): boolean {
    return doc.languageId === MARKDOWN_LANGUAGE_ID && doc.uri.scheme === 'file';
  }

  function lint(doc: vscode.TextDocument): void {
    if (!isTarget(doc) || !enabled()) {
      collection.delete(doc.uri);
      return;
    }
    const text = doc.getText();
    if (text.length > MAX_DOC_SIZE) {
      collection.delete(doc.uri);
      return;
    }

    const diagnostics: vscode.Diagnostic[] = [];
    for (const span of getProseSpans(text)) {
      const segment = text.slice(span.start, span.end);
      collect(segment, span.start, WEASEL_RE, CODE_WEASEL, doc, diagnostics, (w) =>
        `“${w}” is filler — consider cutting it.`
      );
      collect(segment, span.start, PASSIVE_RE, CODE_PASSIVE, doc, diagnostics, () =>
        'Possible passive voice — consider an active construction.'
      );
    }
    collection.set(doc.uri, diagnostics);
  }

  function relintAllOpen(): void {
    for (const doc of vscode.workspace.textDocuments) {
      lint(doc);
    }
  }

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { language: MARKDOWN_LANGUAGE_ID, scheme: 'file' },
      new QualityCodeActions(),
      QualityCodeActions.metadata
    ),
    vscode.workspace.onDidOpenTextDocument((doc) => lint(doc)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isTarget(e.document)) {
        debouncer.schedule(e.document.uri.toString(), () => lint(e.document));
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${EXTENSION_ID}.qualityLint`)) {
        if (!enabled()) {
          collection.clear();
        } else {
          relintAllOpen();
        }
      }
    })
  );

  relintAllOpen();
}

function collect(
  segment: string,
  base: number,
  re: RegExp,
  code: string,
  doc: vscode.TextDocument,
  out: vscode.Diagnostic[],
  message: (matched: string) => string
): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    const start = base + m.index;
    const end = start + m[0].length;
    const diag = new vscode.Diagnostic(
      new vscode.Range(doc.positionAt(start), doc.positionAt(end)),
      message(m[0]),
      vscode.DiagnosticSeverity.Hint
    );
    diag.source = QUALITY_SOURCE;
    diag.code = code;
    diag.tags = [vscode.DiagnosticTag.Unnecessary];
    out.push(diag);
  }
}

/** Quick-fix to delete a flagged filler word (and one trailing space). */
class QualityCodeActions implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
  };

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== QUALITY_SOURCE || diagnostic.code !== CODE_WEASEL) {
        continue;
      }
      const word = document.getText(diagnostic.range);
      const fix = new vscode.CodeAction(`Remove “${word}”`, vscode.CodeActionKind.QuickFix);
      fix.diagnostics = [diagnostic];
      fix.edit = new vscode.WorkspaceEdit();
      // Also consume one trailing space to avoid a double gap.
      let deleteRange: vscode.Range = diagnostic.range;
      const after = new vscode.Range(diagnostic.range.end, diagnostic.range.end.translate(0, 1));
      if (document.getText(after) === ' ') {
        deleteRange = diagnostic.range.with({ end: after.end });
      }
      fix.edit.delete(document.uri, deleteRange);
      actions.push(fix);
    }
    return actions;
  }
}

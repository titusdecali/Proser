import * as vscode from 'vscode';
import { MARKDOWN_LANGUAGE_ID } from '../../constants';
import { FENCE_RE } from '../../util/markdownScan';

const ATX_HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

interface Heading {
  level: number;
  text: string;
  line: number;
}

/** Provides a heading outline (sidebar + breadcrumbs) for Markdown documents. */
export function registerOutline(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      { language: MARKDOWN_LANGUAGE_ID },
      new MarkdownOutlineProvider()
    )
  );
}

class MarkdownOutlineProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const headings = parseHeadings(document);
    return buildTree(headings, document);
  }
}

function parseHeadings(document: vscode.TextDocument): Heading[] {
  const headings: Heading[] = [];
  let fence: string | null = null;

  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    const fenceMatch = FENCE_RE.exec(text);
    if (fence !== null) {
      if (fenceMatch && text.includes(fence)) {
        fence = null;
      }
      continue;
    } else if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }

    const m = ATX_HEADING_RE.exec(text);
    if (m) {
      headings.push({ level: m[1].length, text: m[2].trim() || '(untitled)', line });
    }
  }
  return headings;
}

/** Nests headings by level into a DocumentSymbol tree in a single pass; each
 *  heading's range extends to just before the next heading of the same or
 *  higher level (computed as open symbols are popped off the stack). */
function buildTree(headings: Heading[], document: vscode.TextDocument): vscode.DocumentSymbol[] {
  const roots: vscode.DocumentSymbol[] = [];
  const stack: Array<{ level: number; symbol: vscode.DocumentSymbol; line: number }> = [];
  const lastLine = Math.max(0, document.lineCount - 1);

  const finalize = (symbol: vscode.DocumentSymbol, startLine: number, endLine: number): void => {
    const end = Math.max(startLine, endLine);
    symbol.range = new vscode.Range(
      new vscode.Position(startLine, 0),
      new vscode.Position(end, document.lineAt(end).text.length)
    );
  };

  for (const heading of headings) {
    const selectionRange = document.lineAt(heading.line).range;
    const symbol = new vscode.DocumentSymbol(
      heading.text,
      `H${heading.level}`,
      vscode.SymbolKind.String,
      selectionRange, // placeholder; finalized when this symbol is popped
      selectionRange
    );

    // Close any open headings at the same or deeper level; their range ends
    // on the line before this heading.
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
      const top = stack.pop()!;
      finalize(top.symbol, top.line, heading.line - 1);
    }
    if (stack.length === 0) {
      roots.push(symbol);
    } else {
      stack[stack.length - 1].symbol.children.push(symbol);
    }
    stack.push({ level: heading.level, symbol, line: heading.line });
  }

  // Anything still open runs to the end of the document.
  while (stack.length > 0) {
    const top = stack.pop()!;
    finalize(top.symbol, top.line, lastLine);
  }

  return roots;
}

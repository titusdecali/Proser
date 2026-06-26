/**
 * The Dictionary side panel: a read-only webview opened beside the editor that
 * shows a word's definition. Content is server-rendered into `webview.html` on
 * each lookup (no scripts, no message channel needed) — the entry is static once
 * fetched, so re-rendering the HTML is simpler than a JS bundle + postMessage.
 */

import * as vscode from 'vscode';
import { presizeSidePanel } from '../../util/editorLayout';
import { DictionaryEntry } from './dictionaryLookup';

const VIEW_TYPE = 'proser.dictionary';
const SIDE_PANEL_PX = 420;

let panel: vscode.WebviewPanel | undefined;

function ensurePanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (panel) {
    panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside, true);
    return panel;
  }
  panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Dictionary', vscode.ViewColumn.Beside, {
    enableScripts: false,
    retainContextWhenHidden: true
  });
  // Size from the remembered editor width (set by the other side panels) so it
  // opens at ≈SIDE_PANEL_PX. This panel has no script to measure its own width, so
  // it consumes the remembered value without writing one back.
  presizeSidePanel(context.globalState, SIDE_PANEL_PX);
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'proser.svg');
  panel.onDidDispose(() => {
    panel = undefined;
  });
  return panel;
}

/** Reveal the panel (creating it if needed) and show a brief loading state while
 *  the lookup runs. */
export function showLoading(context: vscode.ExtensionContext, word: string): void {
  const p = ensurePanel(context);
  p.title = `Dictionary — ${word}`;
  p.webview.html = page(`<div class="status">Looking up <b>${esc(word)}</b>…</div>`);
}

export function showEntry(context: vscode.ExtensionContext, entry: DictionaryEntry): void {
  const p = ensurePanel(context);
  p.title = `Dictionary — ${entry.word}`;
  p.webview.html = page(renderEntry(entry));
}

export function showNotFound(context: vscode.ExtensionContext, word: string): void {
  const p = ensurePanel(context);
  p.title = `Dictionary — ${word}`;
  p.webview.html = page(
    `<div class="status">No definition found for <b>${esc(word)}</b>.` +
      `<div class="hint">Try a different form of the word, or check your spelling.</div></div>`
  );
}

// ── Rendering ──────────────────────────────────────────────────────────────

function renderEntry(entry: DictionaryEntry): string {
  const header =
    `<div class="head">` +
    `<span class="word">${esc(entry.word)}</span>` +
    (entry.phonetic ? `<span class="phon">${esc(entry.phonetic)}</span>` : '') +
    `</div>`;

  const blocks = entry.meanings
    .map((m) => {
      const defs = m.definitions
        .map(
          (d) =>
            `<li>${esc(d.definition)}` +
            (d.example ? `<div class="ex">“${esc(d.example)}”</div>` : '') +
            `</li>`
        )
        .join('');
      const syn =
        m.synonyms && m.synonyms.length > 0
          ? `<div class="rel"><span class="rl">synonyms</span> ${m.synonyms.map(esc).join(', ')}</div>`
          : '';
      const ant =
        m.antonyms && m.antonyms.length > 0
          ? `<div class="rel"><span class="rl">antonyms</span> ${m.antonyms.map(esc).join(', ')}</div>`
          : '';
      return (
        `<section class="pos-block">` +
        `<h2>${esc(m.partOfSpeech)}</h2>` +
        `<ol>${defs}</ol>${syn}${ant}` +
        `</section>`
      );
    })
    .join('');

  const src = entry.source === 'online' ? 'Free Dictionary API' : 'WordNet (offline)';
  return header + blocks + `<div class="src">Source: ${esc(src)}</div>`;
}

function page(body: string): string {
  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1.0">` +
    `<style>${STYLE}</style></head><body>${body}</body></html>`
  );
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    padding: 16px 18px; line-height: 1.5;
  }
  .head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
    padding-bottom: 8px; margin-bottom: 12px;
    border-bottom: 1px solid var(--vscode-panel-border); }
  .word { font-size: 1.7em; font-weight: 600; }
  .phon { opacity: 0.7; font-size: 1em; }
  .pos-block { margin: 0 0 18px; }
  h2 { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.05em;
    opacity: 0.7; font-weight: 600; margin: 0 0 6px; font-style: italic; }
  ol { margin: 0 0 6px; padding-left: 1.4em; }
  li { margin: 0 0 8px; }
  .ex { opacity: 0.75; font-style: italic; margin-top: 2px; }
  .rel { font-size: 0.92em; margin: 4px 0; }
  .rl { text-transform: uppercase; font-size: 0.78em; letter-spacing: 0.04em;
    opacity: 0.6; margin-right: 6px; }
  .src { margin-top: 14px; padding-top: 8px; font-size: 0.8em; opacity: 0.55;
    border-top: 1px solid var(--vscode-panel-border); }
  .status { opacity: 0.8; padding: 8px 0; }
  .hint { opacity: 0.6; font-size: 0.9em; margin-top: 6px; }
`;

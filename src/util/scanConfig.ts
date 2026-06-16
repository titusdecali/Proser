import * as vscode from 'vscode';
import { ConfigKeys, EXTENSION_ID } from '../constants';
import { ScanOptions } from './markdownScan';

/** Word-count/scan options read from Proser configuration. Shared by the
 *  status-bar and explorer word-count features so the mapping lives once.
 *  (Kept out of markdownScan.ts so that module stays free of `vscode` for
 *  unit tests.) */
export function wordcountScanOptions(): ScanOptions {
  const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
  return {
    includeCodeBlocks: cfg.get<boolean>(ConfigKeys.wordcountIncludeCodeBlocks, false),
    includeFrontmatter: cfg.get<boolean>(ConfigKeys.wordcountIncludeFrontmatter, false)
  };
}

import * as vscode from 'vscode';
import { MARKDOWN_LANGUAGE_ID } from '../../constants';
import { AiMessage } from './AiClient';
import { SecretStore } from './secretStore';
import { prepareEngine } from './engineFactory';
import { readPrompts } from './prompts';

const DEFAULT_INSTRUCTION =
  'Revise this passage to be clearer and more concise while preserving its meaning and voice.';

/** Lets the author pick a saved quick-slot prompt or type a custom instruction. */
async function pickInstruction(): Promise<string | undefined> {
  const contextUri = vscode.window.activeTextEditor?.document.uri;
  const saved = await readPrompts(contextUri);
  type Item = vscode.QuickPickItem & { value?: string; custom?: boolean };
  const items: Item[] = saved.map((p) => ({
    label: p.name,
    description: p.prompt,
    value: p.prompt
  }));
  items.push({ label: '$(edit) Custom instruction…', custom: true });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Revise with AI',
    placeHolder: 'Choose a saved prompt, or write a custom instruction'
  });
  if (!picked) {
    return undefined;
  }
  if (!picked.custom) {
    return picked.value;
  }
  return vscode.window.showInputBox({
    title: 'Revise with AI',
    prompt: 'How should this be revised?',
    value: DEFAULT_INSTRUCTION,
    ignoreFocusOut: true
  });
}

/**
 * Revises a passage with AI: prompts for an instruction, streams the revision,
 * and previews it. Returns the revised text only when the user chooses Accept
 * (on Copy it copies to the clipboard and returns undefined; on cancel,
 * undefined). The caller applies the returned text.
 */
export async function reviseText(secrets: SecretStore, original: string): Promise<string | undefined> {
  const client = await prepareEngine(secrets);
  if (!client) {
    return undefined;
  }

  const instruction = await pickInstruction();
  if (instruction === undefined) {
    return undefined;
  }

  const controller = new AbortController();
  let revised: string;
  try {
    revised = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${client.label}: revising…`,
        cancellable: true
      },
      async (progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        let chars = 0;
        const messages: AiMessage[] = [
          {
            role: 'system',
            content:
              'You are a professional prose editor. Return ONLY the revised text — no preamble, no commentary, no code fences.'
          },
          { role: 'user', content: `${instruction}\n\n---\n${original}` }
        ];
        const full = await client.chat(
          messages,
          (chunk) => {
            chars += chunk.length;
            progress.report({ message: `${chars} characters…` });
          },
          controller.signal
        );
        return full.trim();
      }
    );
  } catch (err) {
    if (!controller.signal.aborted) {
      vscode.window.showErrorMessage(
        `Revision failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return undefined;
  }

  if (!revised) {
    vscode.window.showInformationMessage('The model returned no revision.');
    return undefined;
  }

  const choice = await vscode.window.showInformationMessage(
    'Apply this revision?',
    { modal: true, detail: revised },
    'Accept',
    'Copy'
  );
  if (choice === 'Accept') {
    return revised;
  }
  if (choice === 'Copy') {
    await vscode.env.clipboard.writeText(revised);
    vscode.window.showInformationMessage('Revised text copied to clipboard.');
  }
  return undefined;
}

/**
 * Generates several distinct revisions of a passage (for the pretty-view's
 * inline options card). `instruction` is the author's revision request (from a
 * quick-slot prompt or the inline input); a sensible default is used when it is
 * blank. Returns the parsed list (may be fewer than requested).
 */
export async function reviseOptions(
  secrets: SecretStore,
  original: string,
  instruction?: string,
  count = 3
): Promise<string[]> {
  const client = await prepareEngine(secrets);
  if (!client) {
    return [];
  }
  const goal = instruction?.trim()
    ? instruction.trim()
    : 'make each clearer and more concise while preserving the meaning and voice';
  const messages: AiMessage[] = [
    {
      role: 'system',
      content: 'You are a professional prose editor. Return ONLY the revised passages and nothing else.'
    },
    {
      role: 'user',
      content:
        `Rewrite the passage below in ${count} DISTINCT ways. Goal: ${goal}. ` +
        `Each revision must follow that goal, preserve the meaning and the author's voice, and be ` +
        `meaningfully different from the others. ` +
        `Output ONLY the ${count} revisions, separated by a line containing exactly "%%%". ` +
        `Do not number or label them.\n\n---\n${original}`
    }
  ];

  const controller = new AbortController();
  let text: string;
  try {
    text = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${client.label}: drafting ${count} revisions…`,
        cancellable: true
      },
      async (progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        let chars = 0;
        const full = await client.chat(
          messages,
          (chunk) => {
            chars += chunk.length;
            progress.report({ message: `${chars} characters…` });
          },
          controller.signal
        );
        return full.trim();
      }
    );
  } catch (err) {
    if (!controller.signal.aborted) {
      vscode.window.showErrorMessage(
        `Revision failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return [];
  }

  // Primary: split on the %%% delimiter. Fallback: blank-line blocks.
  let parts = text.split(/\n?%{2,}\n?/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) {
    parts = text
      .split(/\n\s*\n/)
      .map((s) => s.replace(/^\s*(option\s*)?\d+[.):]\s*/i, '').trim())
      .filter(Boolean);
  }
  return parts.slice(0, count);
}

/** "Revise with AI" command — operates on the active text editor's selection. */
export async function reviseWithAI(secrets: SecretStore): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== MARKDOWN_LANGUAGE_ID) {
    return;
  }
  if (editor.selection.isEmpty) {
    vscode.window.showInformationMessage('Select the text you want to revise.');
    return;
  }
  if (editor.selections.filter((s) => !s.isEmpty).length > 1) {
    vscode.window.showInformationMessage(
      'Revise with AI works on one selection at a time. Please select a single passage.'
    );
    return;
  }
  const selection = editor.selection;
  const original = editor.document.getText(selection);

  const revised = await reviseText(secrets, original);
  if (!revised) {
    return;
  }

  // The document may have changed during the streamed revision — only replace
  // if the original selection is still intact; otherwise fall back to copy.
  const active = vscode.window.activeTextEditor;
  const stillValid =
    active === editor &&
    !editor.document.isClosed &&
    editor.document.getText(selection) === original;
  if (stillValid) {
    await editor.edit((b) => b.replace(selection, revised));
  } else {
    await vscode.env.clipboard.writeText(revised);
    vscode.window.showWarningMessage(
      'The document changed while revising — the revised text was copied to your clipboard instead.'
    );
  }
}

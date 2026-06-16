/** Folder-level manuscript metadata (title, author, contact) persisted next to
 *  the chapters as `.proser-manuscript.json`. The title-page form writes it; the
 *  compiler and exporters read it. One source of truth for the whole book. */
import * as vscode from 'vscode';
import { ManuscriptMeta } from './model';

const META_FILE = '.proser-manuscript.json';

export function metaUri(folder: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(folder, META_FILE);
}

export async function readMeta(folder: vscode.Uri): Promise<ManuscriptMeta | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(metaUri(folder));
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as ManuscriptMeta;
  } catch {
    return undefined;
  }
}

export async function writeMeta(folder: vscode.Uri, meta: ManuscriptMeta): Promise<void> {
  const data = Buffer.from(JSON.stringify(meta, null, 2) + '\n', 'utf8');
  await vscode.workspace.fs.writeFile(metaUri(folder), data);
}

/** Walks the author through a short input sequence and saves the metadata.
 *  Pre-fills from any existing file. Returns undefined if cancelled. */
export async function promptMeta(
  folder: vscode.Uri,
  existing?: ManuscriptMeta
): Promise<ManuscriptMeta | undefined> {
  const e = existing ?? ({ addressLines: [] } as Partial<ManuscriptMeta>);

  const ask = (
    prompt: string,
    value?: string,
    required = false,
    placeHolder?: string
  ): Thenable<string | undefined> =>
    vscode.window.showInputBox({
      title: 'Manuscript — title page',
      prompt,
      value: value ?? '',
      placeHolder,
      ignoreFocusOut: true,
      validateInput: (v) => (required && !v.trim() ? 'Required.' : null)
    });

  const title = await ask('Manuscript title', e.title, true);
  if (title === undefined) {
    return undefined;
  }
  const authorRealName = await ask('Author legal name (for the contact block)', e.authorRealName, true);
  if (authorRealName === undefined) {
    return undefined;
  }
  const penName = await ask('Byline / pen name (shown under the title)', e.penName ?? authorRealName);
  if (penName === undefined) {
    return undefined;
  }
  const street = await ask('Street address', e.addressLines?.[0], false, '123 Example St');
  if (street === undefined) {
    return undefined;
  }
  const cityLine = await ask('City, State ZIP', e.addressLines?.[1], false, 'Portland, OR 97201');
  if (cityLine === undefined) {
    return undefined;
  }
  const phone = await ask('Phone (optional)', e.phone);
  if (phone === undefined) {
    return undefined;
  }
  const email = await ask('Email (optional)', e.email);
  if (email === undefined) {
    return undefined;
  }
  const headerKeyword = await ask(
    'Running-header keyword (optional — short word from the title)',
    e.headerKeyword
  );
  if (headerKeyword === undefined) {
    return undefined;
  }

  const meta: ManuscriptMeta = {
    title: title.trim(),
    authorRealName: authorRealName.trim(),
    penName: penName.trim() || undefined,
    addressLines: [street.trim(), cityLine.trim()].filter(Boolean),
    phone: phone.trim() || undefined,
    email: email.trim() || undefined,
    headerKeyword: headerKeyword.trim() || undefined
  };
  await writeMeta(folder, meta);
  return meta;
}

/** Returns saved metadata, or runs the form if none exists yet. */
export async function ensureMeta(folder: vscode.Uri): Promise<ManuscriptMeta | undefined> {
  const existing = await readMeta(folder);
  if (existing) {
    return existing;
  }
  const choice = await vscode.window.showInformationMessage(
    'No manuscript title page yet. Set the title and author now?',
    'Set up',
    'Cancel'
  );
  if (choice !== 'Set up') {
    return undefined;
  }
  return promptMeta(folder);
}

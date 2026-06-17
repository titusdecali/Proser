import * as vscode from 'vscode';
import { AiClient } from '../ai/AiClient';
import { SecretStore } from '../ai/secretStore';
import { createEngine, prepareEngine } from '../ai/engineFactory';
import { activeMarkdownDoc, manuscriptFolder, gatherChapterFiles } from '../manuscript/compile';

export type IssueType = 'passive' | 'tense' | 'continuity';
export type Tense = 'past' | 'present';
export type ScanScope = 'active' | 'folder';
export type CheckKind = IssueType;

/** One flagged sentence. `offset`/`length` locate it in the file text for
 *  Jump-to and Fix; `offset` is -1 when the sentence couldn't be located
 *  (e.g. the model paraphrased it). */
export interface Issue {
  id: string;
  type: IssueType;
  file: string;
  uri: string;
  offset: number;
  length: number;
  sentence: string;
  suggestion: string;
  reason: string;
}

export interface ScanResult {
  detectedTense: Tense | 'mixed' | null;
  issues: Issue[];
  /** True when no AI engine is configured (only the local passive pass ran). */
  engineOff: boolean;
}

interface Target {
  uri: vscode.Uri;
  text: string;
}

/** Conservative passive heuristic for the no-AI fallback (mirrors qualityLinter). */
const PASSIVE_RE =
  /\b(was|were|is|are|been|being|be)\s+(\w+ed|written|done|made|taken|given|seen|known|shown|held|kept|told|found|built|sent|paid|lost|won|left|drawn|brought|bought|caught)\b/giu;

/** Strips a leading YAML frontmatter block (kept out of the AI prompt). The body
 *  is a suffix of the full text, so `indexOf` against the full text still yields
 *  correct absolute offsets. */
function bodyOf(text: string): string {
  const m = /^(---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?)/.exec(text);
  return m ? text.slice(m[1].length) : text;
}

function basename(uri: vscode.Uri): string {
  return uri.path.split('/').pop() ?? 'document.md';
}

/** A stable key so an ignored issue stays ignored across re-scans. */
export function issueId(file: string, type: IssueType, sentence: string): string {
  return `${file}|${type}|${sentence.replace(/\s+/g, ' ').trim().toLowerCase()}`;
}

/** Finds a sentence in the file text. Falls back to a prefix match when the
 *  model returned a lightly-edited copy. */
export function locate(fullText: string, sentence: string): { offset: number; length: number } {
  const s = sentence.trim();
  if (!s) {
    return { offset: -1, length: 0 };
  }
  let i = fullText.indexOf(s);
  if (i >= 0) {
    return { offset: i, length: s.length };
  }
  const head = s.slice(0, 40);
  i = head.length >= 12 ? fullText.indexOf(head) : -1;
  return i >= 0 ? { offset: i, length: head.length } : { offset: -1, length: 0 };
}

async function gatherTargets(scope: ScanScope): Promise<Target[]> {
  if (scope === 'active') {
    const doc = activeMarkdownDoc();
    return doc ? [{ uri: doc.uri, text: doc.getText() }] : [];
  }
  const folder = manuscriptFolder();
  if (!folder) {
    return [];
  }
  const uris = await gatherChapterFiles(folder);
  const out: Target[] = [];
  for (const uri of uris) {
    const bytes = await vscode.workspace.fs.readFile(uri);
    out.push({ uri, text: Buffer.from(bytes).toString('utf8') });
  }
  return out;
}

function scanPrompt(target: Tense | 'auto', body: string): { system: string; user: string } {
  const tenseLine =
    target === 'auto'
      ? 'Infer the dominant narrative tense yourself, then flag sentences that deviate from it.'
      : `The intended narrative tense is ${target.toUpperCase()}. Flag sentences that deviate from it.`;
  return {
    system:
      'You are a meticulous prose copy-editor. You find (1) passive-voice sentences and ' +
      '(2) tense-consistency problems. You respond with STRICT JSON only — no prose, no code fences.',
    user:
      `${tenseLine}\n\n` +
      'Return JSON of exactly this shape:\n' +
      '{"detectedTense":"past|present|mixed","issues":[' +
      '{"type":"passive|tense","sentence":"<verbatim sentence copied EXACTLY from the text>",' +
      '"suggestion":"<the sentence rewritten to fix it>","reason":"<short why>"}]}\n' +
      'Rules: copy "sentence" byte-for-byte from the text so it can be located. ' +
      'Only include real problems (skip intentional dialogue/quotes). Max 40 issues. ' +
      'If there are no issues, return an empty "issues" array.\n\n---\n' +
      body
  };
}

function parseScan(text: string): { detectedTense: Tense | 'mixed' | null; raw: Array<Record<string, unknown>> } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { detectedTense: null, raw: [] };
  }
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const dt = obj.detectedTense;
    const detectedTense = dt === 'past' || dt === 'present' || dt === 'mixed' ? dt : null;
    const raw = Array.isArray(obj.issues) ? (obj.issues as Array<Record<string, unknown>>) : [];
    return { detectedTense, raw };
  } catch {
    return { detectedTense: null, raw: [] };
  }
}

async function runChat(
  client: AiClient,
  system: string,
  user: string,
  title: string,
  silent: boolean
): Promise<string> {
  const messages = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user }
  ];
  if (silent) {
    return (await client.chat(messages, () => {})).trim();
  }
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (progress, token) => {
      const controller = new AbortController();
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
}

/** AI scan of one file → its issues + the model's detected tense. */
async function scanOne(
  client: AiClient,
  target: Target,
  tense: Tense | 'auto',
  silent: boolean
): Promise<{ detectedTense: Tense | 'mixed' | null; issues: Issue[] }> {
  const file = basename(target.uri);
  const { system, user } = scanPrompt(tense, bodyOf(target.text));
  const text = await runChat(client, system, user, `Scanning ${file} for issues…`, silent);
  const { detectedTense, raw } = parseScan(text);

  const issues: Issue[] = [];
  for (const r of raw) {
    const type = r.type === 'passive' || r.type === 'tense' ? (r.type as IssueType) : null;
    const sentence = typeof r.sentence === 'string' ? r.sentence : '';
    if (!type || !sentence.trim()) {
      continue;
    }
    const { offset, length } = locate(target.text, sentence);
    issues.push({
      id: issueId(file, type, sentence),
      type,
      file,
      uri: target.uri.toString(),
      offset,
      length,
      sentence: sentence.trim(),
      suggestion: typeof r.suggestion === 'string' ? r.suggestion.trim() : '',
      reason: typeof r.reason === 'string' ? r.reason.trim() : ''
    });
  }
  return { detectedTense, issues };
}

/** Local passive-only pass used when no AI engine is configured. */
function scanLocal(target: Target): Issue[] {
  const file = basename(target.uri);
  const text = target.text;
  const issues: Issue[] = [];
  PASSIVE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PASSIVE_RE.exec(text)) !== null) {
    // Widen the match to the surrounding sentence for a readable snippet.
    const sStart = text.lastIndexOf('.', m.index) + 1;
    let sEnd = text.indexOf('.', m.index + m[0].length);
    if (sEnd < 0) {
      sEnd = Math.min(text.length, m.index + m[0].length + 80);
    }
    const sentence = text.slice(sStart, sEnd + 1).trim();
    issues.push({
      id: issueId(file, 'passive', sentence),
      type: 'passive',
      file,
      uri: target.uri.toString(),
      offset: sStart,
      length: sEnd + 1 - sStart,
      sentence,
      suggestion: '',
      reason: 'Possible passive voice — consider an active construction.'
    });
    if (issues.length >= 200) {
      break;
    }
  }
  return issues;
}

/**
 * Scans the active file or the whole manuscript folder. `silent` (auto-scan)
 * uses a configured engine quietly and never prompts for setup; otherwise the
 * user is guided through AI setup. Falls back to a local passive pass when no
 * engine is available.
 */
export async function scanIssues(
  secrets: SecretStore,
  scope: ScanScope,
  tense: Tense | 'auto',
  silent = false
): Promise<ScanResult> {
  const targets = await gatherTargets(scope);
  if (targets.length === 0) {
    return { detectedTense: null, issues: [], engineOff: false };
  }

  const client = silent ? await createEngine(secrets) : await prepareEngine(secrets);
  if (!client) {
    const issues = targets.flatMap(scanLocal);
    return { detectedTense: null, issues, engineOff: true };
  }

  const all: Issue[] = [];
  let detectedTense: Tense | 'mixed' | null = null;
  for (const target of targets) {
    const res = await scanOne(client, target, tense, silent);
    if (!detectedTense) {
      detectedTense = res.detectedTense;
    }
    all.push(...res.issues);
  }
  return { detectedTense, issues: all, engineOff: false };
}

/** Prompt for a single focused check (one of the Editor-tab buttons). */
function checkPrompt(kind: CheckKind, tense: Tense | 'auto', body: string): { system: string; user: string } {
  const json =
    'Return STRICT JSON only — no prose, no code fences — of this shape:\n' +
    '{"detectedTense":"past|present|mixed","issues":[' +
    '{"sentence":"<verbatim excerpt copied EXACTLY from the text>",' +
    '"suggestion":"<a corrected rewrite, or empty>","reason":"<short why>"}]}\n' +
    'Copy "sentence" byte-for-byte so it can be located. Max 40 issues. ' +
    'Empty "issues" array if there are none.\n\n---\n';
  if (kind === 'tense') {
    const t =
      tense === 'auto'
        ? 'Infer the dominant narrative tense, then flag sentences that deviate from it.'
        : `The intended narrative tense is ${tense.toUpperCase()}. Flag sentences that deviate from it.`;
    return {
      system: 'You are a meticulous prose copy-editor focused on tense consistency. JSON only.',
      user: `${t}\n\n${json}${body}`
    };
  }
  if (kind === 'passive') {
    return {
      system: 'You are a meticulous prose copy-editor focused on passive voice. JSON only.',
      user:
        'Flag passive-voice sentences (skip intentional dialogue/quotes). For each, suggest an ' +
        `active-voice rewrite.\n\n${json}${body}`
    };
  }
  // continuity
  return {
    system:
      'You are a continuity editor for fiction. You find consistency errors: contradictions in ' +
      'character details (appearance, age, name spelling), chronology/timeline, established facts, ' +
      'and object/location continuity. JSON only.',
    user:
      'Find continuity errors in the text below. For each, quote the excerpt where it surfaces and ' +
      `explain what contradicts what. Only real contradictions.\n\n${json}${body}`
  };
}

/** AI check of one file for a single kind. */
async function runCheckOne(
  client: AiClient,
  target: Target,
  kind: CheckKind,
  tense: Tense | 'auto',
  silent: boolean
): Promise<{ detectedTense: Tense | 'mixed' | null; issues: Issue[] }> {
  const file = basename(target.uri);
  const { system, user } = checkPrompt(kind, tense, bodyOf(target.text));
  const text = await runChat(client, system, user, `Checking ${file} (${kind})…`, silent);
  const { detectedTense, raw } = parseScan(text);

  const issues: Issue[] = [];
  for (const r of raw) {
    const sentence = typeof r.sentence === 'string' ? r.sentence : '';
    if (!sentence.trim()) {
      continue;
    }
    const { offset, length } = locate(target.text, sentence);
    issues.push({
      id: issueId(file, kind, sentence),
      type: kind,
      file,
      uri: target.uri.toString(),
      offset,
      length,
      sentence: sentence.trim(),
      suggestion: typeof r.suggestion === 'string' ? r.suggestion.trim() : '',
      reason: typeof r.reason === 'string' ? r.reason.trim() : ''
    });
  }
  return { detectedTense: kind === 'tense' ? detectedTense : null, issues };
}

/**
 * Runs one Editor-tab check (tense / passive / continuity) over the active file
 * or the whole folder. `silent` (continuous auto-scan) uses a configured engine
 * quietly; otherwise the user is guided through AI setup. Passive falls back to
 * a local regex pass when no engine is available; tense/continuity need AI.
 */
export async function runCheck(
  secrets: SecretStore,
  kind: CheckKind,
  scope: ScanScope,
  tense: Tense | 'auto',
  silent = false
): Promise<ScanResult> {
  const targets = await gatherTargets(scope);
  if (targets.length === 0) {
    return { detectedTense: null, issues: [], engineOff: false };
  }

  const client = silent ? await createEngine(secrets) : await prepareEngine(secrets);
  if (!client) {
    const issues = kind === 'passive' ? targets.flatMap(scanLocal) : [];
    return { detectedTense: null, issues, engineOff: true };
  }

  const all: Issue[] = [];
  let detectedTense: Tense | 'mixed' | null = null;
  for (const target of targets) {
    const res = await runCheckOne(client, target, kind, tense, silent);
    if (!detectedTense) {
      detectedTense = res.detectedTense;
    }
    all.push(...res.issues);
  }
  return { detectedTense, issues: all, engineOff: false };
}

/** Rewrites one sentence to fix its issue, returning the replacement (or undefined). */
export async function rewriteIssue(
  secrets: SecretStore,
  issue: Issue,
  tense: Tense | 'auto'
): Promise<string | undefined> {
  const client = await prepareEngine(secrets);
  if (!client) {
    return undefined;
  }
  const goal =
    issue.type === 'passive'
      ? 'Rewrite it in the active voice'
      : issue.type === 'continuity'
        ? `Rewrite it to resolve this continuity error: ${issue.reason}`
        : `Rewrite it in the ${tense === 'auto' ? 'surrounding narrative' : tense} tense`;
  const system =
    'You are a prose copy-editor. Return ONLY the corrected sentence — no preamble, no quotes, no code fences.';
  const user = `${goal}, preserving meaning and the author's voice.\n\n---\n${issue.sentence}`;
  const text = await runChat(client, system, user, `${client.label}: fixing…`, false);
  return text.trim() || undefined;
}

/** Replaces the issue's range in its file with `replacement`. Returns false when
 *  the issue couldn't be located or the on-disk text no longer matches. */
export async function applyFix(issue: Issue, replacement: string): Promise<boolean> {
  if (issue.offset < 0 || !replacement) {
    return false;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(issue.uri));
  const current = doc.getText().slice(issue.offset, issue.offset + issue.length);
  if (current.trim() !== issue.sentence.trim()) {
    return false; // text drifted since the scan — caller should re-scan
  }
  const range = new vscode.Range(doc.positionAt(issue.offset), doc.positionAt(issue.offset + issue.length));
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, range, replacement);
  return vscode.workspace.applyEdit(edit);
}

/** Re-locates each issue against current file text (offsets drift after a fix). */
export async function relocate(issues: Issue[]): Promise<Issue[]> {
  const cache = new Map<string, string>();
  const out: Issue[] = [];
  for (const issue of issues) {
    let text = cache.get(issue.uri);
    if (text === undefined) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(issue.uri));
        text = doc.getText();
      } catch {
        text = '';
      }
      cache.set(issue.uri, text);
    }
    const { offset, length } = locate(text, issue.sentence);
    out.push({ ...issue, offset, length });
  }
  return out;
}

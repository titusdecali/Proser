/** Story Root scope: the single, persisted folder whose canonical chapters the
 *  memory engine folds. Default = the opened workspace folder; the author can
 *  re-point it (Settings tab / first-load prompt / Brainstorm Scope control).
 *  Persisted in `<anchor>/.proser/config.json`. See docs/STORY-MEMORY-SPEC.md §8. */
import * as vscode from 'vscode';
import { referenceExcludeSet, titleFromFilename } from '../manuscript/compile';

const CONFIG_DIR = '.proser';
const CONFIG_FILE = 'config.json';

export interface ProserConfig {
  /** Story Root, relative to the anchor (workspace folder). '.' = the anchor itself. */
  storyRoot?: string;
}

export interface StoryScope {
  anchor: vscode.Uri; // the workspace folder where .proser/ lives
  root: vscode.Uri; // the canonical manuscript folder
  rel: string; // root relative to anchor ('.' when equal)
}

/** A canonical chapter file in reading order. */
export interface ChapterFile {
  id: string; // stable slug of the rel path
  title: string;
  order: number;
  rel: string; // relative to the story root
  uri: vscode.Uri;
}

/** The workspace folder we anchor config + memory to (first folder for now). */
export function anchorFolder(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function configUri(anchor: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(anchor, CONFIG_DIR, CONFIG_FILE);
}

export async function readConfig(anchor: vscode.Uri): Promise<ProserConfig> {
  try {
    const bytes = await vscode.workspace.fs.readFile(configUri(anchor));
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as ProserConfig;
  } catch {
    return {};
  }
}

export async function writeConfig(anchor: vscode.Uri, cfg: ProserConfig): Promise<void> {
  const dir = vscode.Uri.joinPath(anchor, CONFIG_DIR);
  await vscode.workspace.fs.createDirectory(dir);
  const data = Buffer.from(JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  await vscode.workspace.fs.writeFile(configUri(anchor), data);
}

/** Normalizes a stored/relative story-root value to a clean POSIX-ish rel path. */
function normalizeRel(rel: string | undefined): string {
  const r = (rel ?? '.').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim();
  return r === '' || r === '.' ? '.' : r;
}

/** Resolves the current Story Root (anchor + configured rel, default = anchor). */
export async function getStoryScope(): Promise<StoryScope | undefined> {
  const anchor = anchorFolder();
  if (!anchor) {
    return undefined;
  }
  const cfg = await readConfig(anchor);
  const rel = normalizeRel(cfg.storyRoot);
  const root = rel === '.' ? anchor : vscode.Uri.joinPath(anchor, ...rel.split('/'));
  return { anchor, root, rel };
}

/** True once the author has explicitly chosen (or confirmed) a Story Root. */
export async function hasConfiguredRoot(): Promise<boolean> {
  const anchor = anchorFolder();
  if (!anchor) {
    return false;
  }
  return typeof (await readConfig(anchor)).storyRoot === 'string';
}

/** Persists a new Story Root (given as an absolute folder uri under the anchor). */
export async function setStoryRoot(folder: vscode.Uri): Promise<StoryScope | undefined> {
  const anchor = anchorFolder();
  if (!anchor) {
    return undefined;
  }
  const rel = relativeTo(anchor, folder);
  await writeConfig(anchor, { ...(await readConfig(anchor)), storyRoot: rel });
  return { anchor, root: folder, rel };
}

/** POSIX relative path of `target` under `base`; '.' when equal; absolute fsPath
 *  when `target` is outside `base` (we still store it, just not portably). */
function relativeTo(base: vscode.Uri, target: vscode.Uri): string {
  const b = base.path.replace(/\/+$/, '');
  const t = target.path.replace(/\/+$/, '');
  // Compare case-insensitively (macOS/Windows are case-insensitive FSes) but keep
  // the original-cased suffix so the stored rel stays portable.
  const bl = b.toLowerCase();
  const tl = t.toLowerCase();
  if (tl === bl) {
    return '.';
  }
  if (tl.startsWith(bl + '/')) {
    return t.slice(b.length + 1);
  }
  return target.fsPath; // outside the anchor — absolute fallback
}

/** True when any path segment is a reference file/folder (notes, bible, …). A
 *  segment matches only on a word boundary, so "Todoroki.md" / "Arcadia.md" are
 *  NOT mistaken for "todo" / "arcs". Applies at every depth so `notes/x.md`,
 *  `drafts/y.md` etc. never leak into canon (§8.5). */
function segmentIsReference(seg: string, exclude: string[]): boolean {
  const b = seg.replace(/\.md$/i, '').toLowerCase();
  return exclude.some(
    (ex) => b === ex || b.startsWith(ex + '-') || b.startsWith(ex + '_') || b.startsWith(ex + ' ')
  );
}

function relIsReference(rel: string, exclude: string[]): boolean {
  return rel.split('/').some((seg) => segmentIsReference(seg, exclude));
}

/** Non-narrative front/back matter that is NOT story canon — folding a jacket
 *  blurb makes the model assert future-tense pitch copy as established fact. */
const NON_NARRATIVE = new Set([
  'frontmatter',
  'backmatter',
  'blurb',
  'synopsis',
  'pitch',
  'logline',
  'titlepage',
  'halftitle',
  'copyright',
  'dedication',
  'epigraph',
  'acknowledgments',
  'acknowledgements',
  'abouttheauthor',
  'aboutauthor',
  'contents',
  'toc',
  'colophon',
  'terminology',
  'glossary',
  'index',
  'appendix',
  'characterlist',
  'dramatispersonae'
]);

/** True for a non-narrative file at any depth. Strips a leading order prefix
 *  (`00-`) and separators so `00-front-matter.md` → `frontmatter`. */
function isNonNarrative(rel: string): boolean {
  return rel.split('/').some((seg) => {
    const core = seg
      .replace(/\.md$/i, '')
      .replace(/^[\d.]+[-_\s]*/, '')
      .toLowerCase()
      .replace(/[^a-z]/g, '');
    return NON_NARRATIVE.has(core);
  });
}

/** Lists the canonical chapter files under a Story Root, recursively, in reading
 *  (lexical) order, with reference files (notes/bible/…) excluded so canon stays
 *  clean even when such files live inside the root (§8.5). */
export async function resolveCorpus(root: vscode.Uri): Promise<ChapterFile[]> {
  const exclude = referenceExcludeSet();
  let uris: vscode.Uri[];
  try {
    uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(root, '**/*.md'),
      '{**/node_modules/**,**/.git/**,**/.proser/**}',
      5000
    );
  } catch {
    return [];
  }
  const rootPath = root.path.replace(/\/+$/, '');
  const usedIds = new Set<string>();
  return uris
    .map((uri) => {
      const file = uri.path.split('/').pop() ?? '';
      const rel = uri.path.startsWith(rootPath + '/') ? uri.path.slice(rootPath.length + 1) : file;
      return { uri, file, rel };
    })
    .filter((e) => !relIsReference(e.rel, exclude) && !isNonNarrative(e.rel))
    .sort((a, b) => a.rel.localeCompare(b.rel, 'en'))
    .map((e, i) => {
      // Guarantee a unique id so distinct files never clobber each other in the
      // chapters Record (sanitized slugs and case-only twins can collide).
      const baseId = chapterId(e.rel) || 'chapter';
      let id = baseId;
      let n = 2;
      while (usedIds.has(id)) {
        id = `${baseId}-${n++}`;
      }
      usedIds.add(id);
      return { id, title: titleFromFilename(e.file), order: i, rel: e.rel, uri: e.uri };
    });
}

/** Lists every Markdown file under the Story Root in reading (lexical) order, for
 *  the Chapters navigator. Like {@link resolveCorpus} it recurses and drops
 *  reference notes (bible/outline/…), but it KEEPS front/back matter so the author
 *  can still open it from the sidebar (the memory engine excludes those from canon;
 *  the navigator shouldn't hide the author's own files). */
export async function listStoryFiles(root: vscode.Uri): Promise<vscode.Uri[]> {
  const exclude = referenceExcludeSet();
  let uris: vscode.Uri[];
  try {
    uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(root, '**/*.md'),
      '{**/node_modules/**,**/.git/**,**/.proser/**}',
      5000
    );
  } catch {
    return [];
  }
  const rootPath = root.path.replace(/\/+$/, '');
  return uris
    .map((uri) => {
      const file = uri.path.split('/').pop() ?? '';
      const rel = uri.path.startsWith(rootPath + '/') ? uri.path.slice(rootPath.length + 1) : file;
      return { uri, rel };
    })
    .filter((e) => !relIsReference(e.rel, exclude))
    .sort((a, b) => a.rel.localeCompare(b.rel, 'en'))
    .map((e) => e.uri);
}

/** Token-safe slug for a chapter from its story-root-relative path. Not
 *  guaranteed unique on its own (resolveCorpus disambiguates collisions). */
export function chapterId(rel: string): string {
  return rel
    .replace(/\.md$/i, '')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/\//g, '__')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

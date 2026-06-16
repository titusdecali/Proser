/** Shared manuscript model + a small Markdown→blocks parser.
 *
 *  The exporters (DOCX, PDF) consume a `BookModel` and never touch the file
 *  system or VS Code APIs, so they can be unit-tested from plain Node. The
 *  compiler (`compile.ts`) turns a folder of chapter files into this model. */

export interface Run {
  text: string;
  italic?: boolean;
  bold?: boolean;
}

export type Block =
  | { kind: 'para'; runs: Run[] }
  | { kind: 'scene' } // centered # scene divider
  | { kind: 'part'; title: string } // a "PART ONE" divider page
  | { kind: 'end'; text: string }; // centered THE END

export interface Chapter {
  /** Heading shown ~1/3 down the chapter's first page. */
  title: string;
  blocks: Block[];
}

export interface ManuscriptMeta {
  title: string;
  authorRealName: string;
  penName?: string;
  /** Street, then "City, ST ZIP" — one entry per line, rendered top-left. */
  addressLines: string[];
  email?: string;
  phone?: string;
  /** Surname shown in the running header; defaults to the last word of the real name. */
  headerSurname?: string;
  /** Short title keyword for the running header; defaults from the title. */
  headerKeyword?: string;
}

export interface BookModel {
  meta: ManuscriptMeta;
  chapters: Chapter[];
  /** Total prose word count across all chapters. */
  wordCount: number;
}

const SCENE_LINE = /^(#|\*\s?\*\s?\*|---|___)$/;
const PART_MARKER = /^<!--\s*proser:part\s*(.*?)\s*-->$/i;
const END_MARKER = /^<!--\s*proser:end\s*-->$/i;
const HEADING = /^#{1,6}\s+(.*)$/;

/** Strips links/code spans to plain text, then splits emphasis into styled runs. */
export function parseInline(text: string): Run[] {
  // [label](url) -> label ; `code` -> code ; images dropped.
  const cleaned = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1');

  const runs: Run[] = [];
  // **bold** / __bold__  |  *italic* / _italic_
  const re = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    if (m.index > last) {
      runs.push({ text: cleaned.slice(last, m.index) });
    }
    if (m[2] !== undefined) {
      runs.push({ text: m[2], bold: true });
    } else {
      runs.push({ text: m[4], italic: true });
    }
    last = re.lastIndex;
  }
  if (last < cleaned.length) {
    runs.push({ text: cleaned.slice(last) });
  }
  return runs.length ? runs : [{ text: cleaned }];
}

/** Pulls a `title:` out of YAML frontmatter and returns the body without it. */
export function stripFrontmatter(raw: string): { title?: string; body: string } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!fm) {
    return { body: raw };
  }
  const title = /^title:\s*["']?(.+?)["']?\s*$/im.exec(fm[1])?.[1];
  return { title, body: raw.slice(fm[0].length) };
}

/** Parses one chapter file's text into a titled block list. */
export function parseChapter(raw: string, fallbackTitle: string): Chapter {
  const { title: fmTitle, body } = stripFrontmatter(raw);
  const lines = body.replace(/\r\n/g, '\n').split('\n');

  let title = fmTitle;
  const blocks: Block[] = [];
  let para: string[] = [];

  const flush = () => {
    if (para.length) {
      blocks.push({ kind: 'para', runs: parseInline(para.join(' ').trim()) });
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    const part = PART_MARKER.exec(t);
    if (part) {
      flush();
      // Title may be inside the marker, or on the next non-blank line.
      let pt = part[1];
      if (!pt) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) {
          j++;
        }
        const h = j < lines.length ? HEADING.exec(lines[j].trim()) : null;
        pt = h ? h[1] : lines[j]?.trim() ?? 'Part';
        i = j;
      }
      blocks.push({ kind: 'part', title: pt });
      continue;
    }
    if (END_MARKER.test(t)) {
      flush();
      blocks.push({ kind: 'end', text: 'THE END' });
      continue;
    }
    if (!t) {
      flush();
      continue;
    }
    if (SCENE_LINE.test(t)) {
      flush();
      blocks.push({ kind: 'scene' });
      continue;
    }
    const h = HEADING.exec(t);
    if (h) {
      // The first heading becomes the chapter title if frontmatter gave none;
      // later headings are treated as in-chapter section titles (kept as text).
      if (!title && blocks.length === 0 && para.length === 0) {
        title = h[1];
        continue;
      }
      flush();
      blocks.push({ kind: 'para', runs: parseInline(h[1]) });
      continue;
    }
    if (/^(THE END|# # #)$/i.test(t)) {
      flush();
      blocks.push({ kind: 'end', text: 'THE END' });
      continue;
    }
    para.push(t);
  }
  flush();

  return { title: (title || fallbackTitle).trim(), blocks };
}

/** Counts prose words in the model (paragraph text only). */
export function countWords(chapters: Chapter[]): number {
  let n = 0;
  for (const ch of chapters) {
    for (const b of ch.blocks) {
      if (b.kind === 'para') {
        const text = b.runs.map((r) => r.text).join('');
        const m = text.trim().match(/\S+/g);
        n += m ? m.length : 0;
      }
    }
  }
  return n;
}

/** "About 90,000 words" — rounded the way agents expect (nearest 1,000 over 10k). */
export function roundedWordCount(words: number): string {
  const rounded =
    words >= 10000
      ? Math.round(words / 1000) * 1000
      : Math.max(100, Math.round(words / 100) * 100);
  return `About ${rounded.toLocaleString('en-US')} words`;
}

export function surnameOf(meta: ManuscriptMeta): string {
  if (meta.headerSurname) {
    return meta.headerSurname;
  }
  const parts = (meta.authorRealName || meta.penName || 'Author').trim().split(/\s+/);
  return parts[parts.length - 1] || 'Author';
}

export function keywordOf(meta: ManuscriptMeta): string {
  if (meta.headerKeyword) {
    return meta.headerKeyword.toUpperCase();
  }
  const word = (meta.title || 'UNTITLED')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .trim()
    .split(/\s+/)
    .filter((w) => !/^(the|a|an|of|and|to|in|on)$/i.test(w))[0];
  return (word || meta.title || 'UNTITLED').toUpperCase();
}

/** Renders a BookModel to a .docx in Standard Manuscript Format (Shunn):
 *  Courier New 12pt, double-spaced, 1" margins, 0.5" first-line indent,
 *  ragged-right, a "Surname / KEYWORD / page" running header, a contact +
 *  word-count title page, and chapters that begin ~1/3 down a fresh page. */
import {
  AlignmentType,
  Document,
  Header,
  Packer,
  PageNumber,
  Paragraph,
  TabStopType,
  TextRun
} from 'docx';
import {
  BookModel,
  Block,
  Run,
  keywordOf,
  roundedWordCount,
  surnameOf
} from './model';

const TWIP = 1440; // twips per inch
const PAGE_W = 12240; // US Letter
const PAGE_H = 15840;
const MARGIN = TWIP; // 1"
const CONTENT_W = PAGE_W - MARGIN * 2; // right tab stop for the title page
const FONT = 'Courier New';

function runs(rs: Run[]): TextRun[] {
  return rs.map((r) => new TextRun({ text: r.text, italics: r.italic, bold: r.bold }));
}

function single(children: TextRun[], align: (typeof AlignmentType)[keyof typeof AlignmentType]) {
  return new Paragraph({
    alignment: align,
    spacing: { line: 240, lineRule: 'auto', after: 0 },
    children
  });
}

function titlePage(book: BookModel): Paragraph[] {
  const m = book.meta;
  const out: Paragraph[] = [];

  // Line 1: real name (left) ........ word count (right), via a right tab stop.
  out.push(
    new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }],
      spacing: { line: 240, lineRule: 'auto', after: 0 },
      children: [
        new TextRun(m.authorRealName || ''),
        new TextRun({ text: '\t' }),
        new TextRun(roundedWordCount(book.wordCount))
      ]
    })
  );
  for (const line of m.addressLines) {
    out.push(single([new TextRun(line)], AlignmentType.LEFT));
  }
  if (m.phone) {
    out.push(single([new TextRun(m.phone)], AlignmentType.LEFT));
  }
  if (m.email) {
    out.push(single([new TextRun(m.email)], AlignmentType.LEFT));
  }

  // Title block, centered, pushed ~1/3 down the page.
  out.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 3600, line: 240, lineRule: 'auto' },
      children: [new TextRun({ text: (m.title || 'Untitled').toUpperCase() })]
    })
  );
  out.push(single([new TextRun('by')], AlignmentType.CENTER));
  out.push(
    single([new TextRun(m.penName || m.authorRealName || '')], AlignmentType.CENTER)
  );
  return out;
}

function chapterParagraphs(book: BookModel): Paragraph[] {
  const out: Paragraph[] = [];
  book.chapters.forEach((ch, ci) => {
    // Chapter heading ~1/3 down a fresh page (first chapter opens the section).
    out.push(
      new Paragraph({
        pageBreakBefore: ci > 0,
        alignment: AlignmentType.CENTER,
        spacing: { before: ci === 0 ? 3000 : 3600, after: 480, line: 480, lineRule: 'auto' },
        children: [new TextRun({ text: ch.title })]
      })
    );
    for (const b of ch.blocks) {
      out.push(blockParagraph(b));
    }
  });
  return out;
}

function blockParagraph(b: Block): Paragraph {
  if (b.kind === 'scene') {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { line: 480, lineRule: 'auto', before: 0, after: 0 },
      children: [new TextRun('#')]
    });
  }
  if (b.kind === 'part') {
    return new Paragraph({
      pageBreakBefore: true,
      alignment: AlignmentType.CENTER,
      spacing: { before: 4000, line: 480, lineRule: 'auto' },
      children: [new TextRun({ text: b.title.toUpperCase(), bold: true })]
    });
  }
  if (b.kind === 'end') {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 480, line: 480, lineRule: 'auto' },
      children: [new TextRun(b.text)]
    });
  }
  return new Paragraph({
    indent: { firstLine: 720 }, // 0.5"
    spacing: { line: 480, lineRule: 'auto', after: 0 },
    children: runs(b.runs)
  });
}

export async function buildDocx(book: BookModel): Promise<Buffer> {
  const header = new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun(`${surnameOf(book.meta)} / ${keywordOf(book.meta)} / `),
          new TextRun({ children: [PageNumber.CURRENT] })
        ]
      })
    ]
  });

  const page = { size: { width: PAGE_W, height: PAGE_H }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } };

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT, size: 24 }, // 12pt
          paragraph: { spacing: { line: 480, lineRule: 'auto' } }
        }
      }
    },
    sections: [
      // Title page — no running header.
      { properties: { page }, children: titlePage(book) },
      // Body — running header, page numbers restart at 1.
      {
        properties: { page: { ...page, pageNumbers: { start: 1 } } },
        headers: { default: header },
        children: chapterParagraphs(book)
      }
    ]
  });

  return Packer.toBuffer(doc);
}

/** Renders a BookModel to a selectable-text PDF in Standard Manuscript Format,
 *  mirroring the DOCX exporter: Courier 12pt, double-spaced, 1" margins, 0.5"
 *  first-line indents, running header with page numbers, contact/word-count
 *  title page, chapters opening ~1/3 down a fresh page. Latin text uses
 *  pdfkit's built-in Courier family; CJK text (Korean, Japanese, Chinese)
 *  switches to the bundled Noto Sans Mono CJK face, since the built-in fonts
 *  are WinAnsi-only and would render CJK as garbage (see fonts.ts). */
import PDFDocument from 'pdfkit';
import { BookModel, Run, keywordOf, roundedWordCount, surnameOf } from './model';
import { CJK_BOLD, CJK_REGULAR, hasCjk, loadCjkFonts } from './fonts';

const MARGIN = 72; // 1"
const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FONT_SIZE = 12;

/** Picks the face for a styled run. CJK runs use the bundled font (no oblique
 *  face exists — CJK typography doesn't slant for emphasis, so italic maps to
 *  regular); Latin runs keep the Courier manuscript look. */
function fontFor(r: Run, cjkOk: boolean): string {
  if (cjkOk && hasCjk(r.text)) {
    return r.bold ? CJK_BOLD : CJK_REGULAR;
  }
  if (r.bold && r.italic) {
    return 'Courier-BoldOblique';
  }
  if (r.bold) {
    return 'Courier-Bold';
  }
  if (r.italic) {
    return 'Courier-Oblique';
  }
  return 'Courier';
}

/** Same choice for unstyled strings (titles, headers, contact lines). */
function fontForText(text: string, cjkOk: boolean, bold = false): string {
  if (cjkOk && hasCjk(text)) {
    return bold ? CJK_BOLD : CJK_REGULAR;
  }
  return bold ? 'Courier-Bold' : 'Courier';
}

export function buildPdf(book: BookModel): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    autoFirstPage: false,
    bufferPages: true
  });

  // Register the bundled CJK faces; when the assets are missing we degrade to
  // the old Courier-only behavior instead of failing the export.
  const cjkFonts = loadCjkFonts();
  const cjkOk = cjkFonts !== null;
  if (cjkFonts) {
    doc.registerFont(CJK_REGULAR, cjkFonts.regular);
    doc.registerFont(CJK_BOLD, cjkFonts.bold);
  }

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });

  doc.font('Courier').fontSize(FONT_SIZE);
  const lineGap = Math.max(0, 24 - doc.currentLineHeight()); // ~double spacing

  // ---- Title page (unnumbered, no header) ----
  doc.addPage();
  const m = book.meta;
  doc.fontSize(FONT_SIZE);
  doc.font(fontForText(m.authorRealName || '', cjkOk));
  doc.text(m.authorRealName || '', MARGIN, MARGIN, { lineBreak: false });
  doc.font('Courier');
  doc.text(roundedWordCount(book.wordCount), MARGIN, MARGIN, {
    width: CONTENT_W,
    align: 'right',
    lineBreak: false
  });
  let y = MARGIN + 16;
  for (const line of [...m.addressLines, m.phone, m.email].filter(Boolean) as string[]) {
    doc.font(fontForText(line, cjkOk));
    doc.text(line, MARGIN, y, { lineBreak: false });
    y += 16;
  }
  const title = (m.title || 'Untitled').toUpperCase();
  doc.font(fontForText(title, cjkOk));
  doc.text(title, MARGIN, PAGE_H / 3, {
    width: CONTENT_W,
    align: 'center'
  });
  doc.moveDown(1);
  doc.font('Courier').text('by', { width: CONTENT_W, align: 'center' });
  doc.moveDown(1);
  const byline = m.penName || m.authorRealName || '';
  doc.font(fontForText(byline, cjkOk)).text(byline, { width: CONTENT_W, align: 'center' });

  // ---- Body ----
  const bodyStart = doc.bufferedPageRange().count; // first chapter page index

  book.chapters.forEach((ch) => {
    doc.addPage();
    doc.fontSize(FONT_SIZE);
    doc.y = PAGE_H / 3;
    doc.font(fontForText(ch.title, cjkOk));
    doc.text(ch.title, MARGIN, doc.y, { width: CONTENT_W, align: 'center' });
    doc.moveDown(2);

    for (const b of ch.blocks) {
      if (b.kind === 'scene') {
        doc.font('Courier').text('#', { width: CONTENT_W, align: 'center', lineGap });
        continue;
      }
      if (b.kind === 'part') {
        doc.addPage();
        const part = b.title.toUpperCase();
        doc.font(fontForText(part, cjkOk, true)).fontSize(FONT_SIZE);
        doc.text(part, MARGIN, PAGE_H / 2, { width: CONTENT_W, align: 'center' });
        doc.addPage();
        doc.font('Courier').fontSize(FONT_SIZE);
        continue;
      }
      if (b.kind === 'end') {
        doc.moveDown(1);
        doc.font(fontForText(b.text, cjkOk));
        doc.text(b.text, { width: CONTENT_W, align: 'center', lineGap });
        continue;
      }
      // paragraph — flow runs with a 0.5" first-line indent
      const last = b.runs.length - 1;
      b.runs.forEach((r, i) => {
        doc.font(fontFor(r, cjkOk));
        doc.text(r.text, {
          lineGap,
          align: 'left',
          continued: i < last,
          indent: i === 0 ? 36 : 0
        });
      });
    }
  });

  // ---- Running header on every body page (post-applied) ----
  const range = doc.bufferedPageRange();
  const surname = surnameOf(book.meta);
  const keyword = keywordOf(book.meta);
  const headerFont = fontForText(`${surname}${keyword}`, cjkOk);
  for (let i = bodyStart; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font(headerFont).fontSize(FONT_SIZE);
    doc.text(`${surname} / ${keyword} / ${i - bodyStart + 1}`, MARGIN, MARGIN / 2, {
      width: CONTENT_W,
      align: 'right',
      lineBreak: false
    });
  }

  doc.end();
  return done;
}

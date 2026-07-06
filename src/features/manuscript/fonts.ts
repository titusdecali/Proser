/** Bundled CJK font support for the PDF exporter.
 *
 *  pdfkit's built-in Courier family is WinAnsi-encoded, so Korean, Japanese,
 *  and Chinese text renders as garbage. We ship Noto Sans Mono CJK KR
 *  (SIL OFL 1.1 — see fonts/OFL.txt) brotli-compressed in <extension
 *  root>/fonts and decompress it on demand with Node's built-in zlib. The
 *  monospaced design matches the Courier manuscript look, and the font covers
 *  Hangul, kana, and the full unified ideograph set, so one family handles
 *  Korean, Japanese, and Chinese. pdfkit subsets the font on embed, so PDFs
 *  only carry the glyphs actually used. */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

/** pdfkit font names the CJK faces are registered under. */
export const CJK_REGULAR = 'Proser-CJK';
export const CJK_BOLD = 'Proser-CJK-Bold';

const REGULAR_FILE = 'NotoSansMonoCJKkr-Regular.otf.br';
const BOLD_FILE = 'NotoSansMonoCJKkr-Bold.otf.br';

export interface CjkFonts {
  regular: Buffer;
  bold: Buffer;
}

/** Hangul (jamo + syllables), kana, CJK ideographs (incl. Extension A and the
 *  supplementary planes via surrogates), CJK punctuation, and full-width forms. */
const CJK_RE =
  /[ᄀ-ᇿ⺀-〿぀-㆏㆐-鿿ꥠ-꥿가-퟿豈-﫿︰-﹏＀-￯]|[\uD840-\uD87F][\uDC00-\uDFFF]/;

export function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}

let resolvedDir: string | null | undefined;

/** Finds the bundled fonts/ directory by walking up from this module: from
 *  dist/extension.js (production bundle) it's one level up; from out/… (test
 *  builds) it's a few more. Caches the result; null when the assets are absent. */
function fontsDir(): string | null {
  if (resolvedDir !== undefined) {
    return resolvedDir;
  }
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'fonts');
    if (fs.existsSync(path.join(candidate, REGULAR_FILE))) {
      resolvedDir = candidate;
      return resolvedDir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  resolvedDir = null;
  return resolvedDir;
}

/** Decompresses the bundled fonts (~150ms). Buffers are intentionally not
 *  cached — exports are occasional and holding ~33MB in the extension host
 *  between them isn't worth it. Returns null if the assets are missing or
 *  unreadable, in which case the exporter falls back to Courier. */
export function loadCjkFonts(): CjkFonts | null {
  const dir = fontsDir();
  if (!dir) {
    return null;
  }
  try {
    return {
      regular: zlib.brotliDecompressSync(fs.readFileSync(path.join(dir, REGULAR_FILE))),
      bold: zlib.brotliDecompressSync(fs.readFileSync(path.join(dir, BOLD_FILE)))
    };
  } catch {
    return null;
  }
}

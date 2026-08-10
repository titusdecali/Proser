import * as assert from 'assert';
import { preserveMarkdownSource } from '../src/util/markdownSource';

/** A chapter as a writer wrote it: hard-wrapped prose, `-` bullets, a numbered
 *  heading — every convention Toast UI's serializer rewrites. */
const SOURCE =
  '# Chapter One\n\nHe walked into the room.\nShe did not look up.\n\n- first item\n- second item\n\n## 2. Later\n\nThe end.\n';

/** The same chapter after Toast UI re-serialized it, with nothing edited. */
const SERIALIZED =
  '# Chapter One\n\nHe walked into the room. She did not look up.\n\n* first item\n* second item\n\n## 2\\. Later\n\nThe end.\n';

describe('preserveMarkdownSource', () => {
  it('leaves an untouched document byte-identical', () => {
    assert.strictEqual(preserveMarkdownSource(SOURCE, SERIALIZED), SOURCE);
  });

  it('rewrites only the edited block', () => {
    const edited = SERIALIZED.replace('into the room.', 'into the kitchen.');
    assert.strictEqual(
      preserveMarkdownSource(SOURCE, edited),
      '# Chapter One\n\nHe walked into the kitchen. She did not look up.\n\n- first item\n- second item\n\n## 2. Later\n\nThe end.\n'
    );
  });

  it('is idempotent once the merged text is the new baseline', () => {
    const edited = SERIALIZED.replace('into the room.', 'into the kitchen.');
    const once = preserveMarkdownSource(SOURCE, edited);
    assert.strictEqual(preserveMarkdownSource(once, edited), once);
  });

  it('keeps the blank line after frontmatter and an unedited numbered heading', () => {
    // Body as splitHead hands it over: the blank line below the frontmatter leads it.
    const body = '\n## 1. Question\n\n1. What is the answer?\n\n   **Answer:**\n\n   This is one sentence.\n';
    const toast = '## 1\\. Question\n\n1. What is the answer?\n<br>\n    **Answer:**\n    This is one sentence changed.\n';
    const out = preserveMarkdownSource(body, toast);
    assert.ok(out.startsWith('\n## 1. Question\n\n'), 'heading and leading blank line preserved');
    assert.ok(!/<br>/.test(out), 'serializer <br> replaced by a blank line');
  });

  it('does not revert a deliberate re-nesting of a list item', () => {
    assert.strictEqual(preserveMarkdownSource('- alpha\n- beta\n- gamma\n', '* alpha\n  * beta\n* gamma\n'), '- alpha\n  - beta\n- gamma\n');
  });

  it('adds a new block without touching the rest', () => {
    const appended = SERIALIZED.replace('The end.\n', 'The end.\n\nA new closing line.\n');
    assert.strictEqual(preserveMarkdownSource(SOURCE, appended), SOURCE.replace('The end.\n', 'The end.\n\nA new closing line.\n'));
  });

  it('removes a deleted block without touching the rest', () => {
    const deleted = SERIALIZED.replace('* first item\n* second item\n\n', '');
    assert.strictEqual(preserveMarkdownSource(SOURCE, deleted), SOURCE.replace('- first item\n- second item\n\n', ''));
  });

  it('keeps standalone <br> when the file itself uses them', () => {
    const doc = 'Line one.\n<br>\nLine two.\n\nNext para.\n';
    const ser = 'Line one.\n<br>\nLine two.\n\nNext paragraph.\n';
    assert.strictEqual(preserveMarkdownSource(doc, ser), 'Line one.\n<br>\nLine two.\n\nNext paragraph.\n');
  });

  it('keeps CRLF line endings', () => {
    assert.strictEqual(preserveMarkdownSource('# Title\r\n\r\nOne line.\r\n', '# Title\n\nOne line changed.\n'), '# Title\r\n\r\nOne line changed.\r\n');
  });

  it('never touches fenced code', () => {
    const doc = 'Intro.\n\n```js\nconst a = 1\\.5;\n```\n\nOutro.\n';
    const ser = 'Intro edited.\n\n```js\nconst a = 1\\.5;\n```\n\nOutro.\n';
    assert.strictEqual(preserveMarkdownSource(doc, ser), ser);
  });

  it('passes through a new or emptied document', () => {
    assert.strictEqual(preserveMarkdownSource('', '* a\n'), '* a\n');
    assert.strictEqual(preserveMarkdownSource(SOURCE, ''), '');
  });

  it('changes one block only in a 4000-block document', () => {
    const paras: string[] = [];
    for (let i = 0; i < 4000; i++) {
      paras.push(`Paragraph ${i} has some prose in it.\nWrapped by hand at this point.`);
    }
    const big = paras.join('\n\n') + '\n';
    const serialized = paras.map((p, i) => (i === 2000 ? p.replace('some prose', 'other prose') : p).replace(/\n/g, ' ')).join('\n\n') + '\n';
    const out = preserveMarkdownSource(big, serialized).split('\n\n');
    const before = big.split('\n\n');
    assert.strictEqual(out.filter((p, i) => p !== before[i]).length, 1);
  });
});

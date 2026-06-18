import * as assert from 'assert';
import {
  computeProseStats,
  countMarkdownWords,
  countTokens,
  estimateReadingMinutes,
  getProseTokens
} from '../src/util/wordcount';
import { getProseSpans } from '../src/util/markdownScan';

describe('countTokens', () => {
  it('counts plain words', () => {
    assert.strictEqual(countTokens('the quick brown fox'), 4);
  });
  it('treats contractions and hyphenates as single words', () => {
    assert.strictEqual(countTokens("don't well-known mother-in-law"), 3);
  });
  it('ignores punctuation and markdown markers', () => {
    assert.strictEqual(countTokens('# Heading, with — punctuation!'), 3);
  });
});

describe('countMarkdownWords', () => {
  it('skips fenced code blocks by default', () => {
    const md = ['Real prose here.', '', '```js', 'const x = doNotCountThis();', '```', '', 'More prose.'].join(
      '\n'
    );
    assert.strictEqual(countMarkdownWords(md), 5); // "Real prose here" + "More prose"
  });

  it('counts code when opted in', () => {
    const md = ['one two', '```', 'three four', '```'].join('\n');
    assert.strictEqual(countMarkdownWords(md, { includeCodeBlocks: true }), 4);
  });

  it('skips YAML frontmatter by default', () => {
    const md = ['---', 'title: My Doc', 'tags: a b c', '---', '', 'Body words only.'].join('\n');
    assert.strictEqual(countMarkdownWords(md), 3);
  });

  it('skips inline code', () => {
    assert.strictEqual(countMarkdownWords('use the `someFunction` here'), 3);
  });

  it('keeps link text but drops the URL', () => {
    assert.strictEqual(countMarkdownWords('see [the docs](https://example.com/path) now'), 4);
  });

  it('drops bare URLs', () => {
    assert.strictEqual(countMarkdownWords('visit https://example.com today'), 2);
  });

  it('does not treat an unclosed leading --- as frontmatter', () => {
    const md = ['---', 'this is just text not metadata', 'with more words'].join('\n');
    assert.strictEqual(countMarkdownWords(md), 9);
  });
});

describe('getProseSpans / getProseTokens', () => {
  it('maps token offsets back to the original text', () => {
    const md = 'alpha `code` beta';
    const tokens = getProseTokens(md);
    assert.deepStrictEqual(
      tokens.map((t) => t.word),
      ['alpha', 'beta']
    );
    // The "beta" offset must point at the real position in the source.
    const beta = tokens.find((t) => t.word === 'beta')!;
    assert.strictEqual(md.slice(beta.start, beta.end), 'beta');
  });

  it('returns no spans for an all-code document', () => {
    const md = ['```', 'only code', '```'].join('\n');
    assert.strictEqual(getProseSpans(md).length, 0);
  });
});

describe('inline emphasis does not split words', () => {
  it('rejoins a styled mid-word into one whole token', () => {
    // Bold/italic on PART of a word must not produce fragments like "ok"+"ay".
    assert.deepStrictEqual(
      getProseTokens('**ok**ay').map((t) => t.word),
      ['okay']
    );
    assert.deepStrictEqual(
      getProseTokens('an _di_sturbing thing').map((t) => t.word),
      ['an', 'disturbing', 'thing']
    );
  });
  it('strips markers from whole-word emphasis', () => {
    assert.deepStrictEqual(
      getProseTokens('an *italic* word').map((t) => t.word),
      ['an', 'italic', 'word']
    );
  });
  it('counts a styled mid-word as a single word', () => {
    assert.strictEqual(countTokens('**ok**ay'), 1);
  });
  it('still splits double hyphens (no em-dash regression)', () => {
    assert.strictEqual(countTokens('a--b'), 2);
  });
});

describe('computeProseStats', () => {
  it('counts words, characters, sentences, and paragraphs over prose', () => {
    const md = ['First sentence. Second one!', '', 'A new paragraph here.'].join('\n');
    const s = computeProseStats(md);
    assert.strictEqual(s.words, 8);
    assert.strictEqual(s.sentences, 3);
    assert.strictEqual(s.paragraphs, 2);
    assert.ok(s.charactersNoSpaces < s.characters);
  });

  it('excludes code blocks from words/characters', () => {
    const md = ['Real words here.', '', '```js', 'const x = 1;', '```'].join('\n');
    const s = computeProseStats(md);
    assert.strictEqual(s.words, 3);
    assert.strictEqual(s.characters, 'Real words here.'.length);
  });
});

describe('estimateReadingMinutes', () => {
  it('is zero for empty', () => {
    assert.strictEqual(estimateReadingMinutes(0, 200), 0);
  });
  it('rounds up to at least one minute', () => {
    assert.strictEqual(estimateReadingMinutes(10, 200), 1);
  });
  it('scales with word count', () => {
    assert.strictEqual(estimateReadingMinutes(600, 200), 3);
  });
  it('rounds partial minutes up', () => {
    assert.strictEqual(estimateReadingMinutes(250, 200), 2);
  });
});

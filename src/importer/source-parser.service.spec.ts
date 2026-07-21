import { SourceParserService } from './source-parser.service';

describe('SourceParserService', () => {
  const parser = new SourceParserService();

  it('parses chapter definitions with Chinese punctuation', () => {
    expect(
      parser.parseChapters('Chapter 1：自然地理\nChapter 2: 植物研究'),
    ).toEqual([
      { number: 1, title: '自然地理', sourceFile: '1.txt' },
      { number: 2, title: '植物研究', sourceFile: '2.txt' },
    ]);
  });

  it('groups one or more sentences under each vocabulary term', () => {
    const parsed = parser.parseVocabulary(
      [
        'Language.',
        '',
        'Learning a new language takes time and practice.',
        '',
        'Symbol.',
        '',
        'The dove is a symbol of peace.',
        '',
        "The old oak tree became a symbol of the town's history.",
      ].join('\n'),
    );

    expect(parsed.words).toHaveLength(2);
    expect(parsed.words[0].text).toBe('Language');
    expect(parsed.words[0].sentences).toHaveLength(1);
    expect(parsed.words[1].text).toBe('Symbol');
    expect(parsed.words[1].sentences).toHaveLength(2);
  });

  it('normalizes sentence hashes and filesystem names', () => {
    expect(parser.hashSentence('  Hello   WORLD. ')).toBe(
      parser.hashSentence('hello world.'),
    );
    expect(parser.slugify('Carbon dioxide.')).toBe('carbon-dioxide');
  });

  it('does not treat words inside hyphenated terms as sentence grammar', () => {
    const parsed = parser.parseVocabulary(
      'Previous.\n\nA previous example is here.\n\nEnd-to-end test\n\nEnd-to-end tests simulate real users.',
    );

    expect(parsed.words.map((word) => word.text)).toEqual([
      'Previous',
      'End-to-end test',
    ]);
  });
});

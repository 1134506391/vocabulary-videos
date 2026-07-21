import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

export interface ParsedChapter {
  number: number;
  title: string;
  sourceFile: string;
}

export interface ParsedWord {
  text: string;
  sourceOrder: number;
  sentences: ParsedSentence[];
}

export interface ParsedSentence {
  text: string;
  sourceOrder: number;
  normalizedHash: string;
}

export interface AmbiguousBoundary {
  line: number;
  text: string;
  interpretedAs: 'word' | 'sentence';
  reason: string;
}

export interface ParsedVocabulary {
  words: ParsedWord[];
  ambiguities: AmbiguousBoundary[];
}

@Injectable()
export class SourceParserService {
  parseChapters(contents: string): ParsedChapter[] {
    return this.nonEmptyLines(contents).map(({ text, line }) => {
      const match = /^Chapter\s+(\d+)\s*[：:]\s*(.+)$/i.exec(text);
      if (!match) {
        throw new Error(`Invalid chapter definition on line ${line}: ${text}`);
      }
      const number = Number(match[1]);
      return {
        number,
        title: match[2].trim(),
        sourceFile: `${number}.txt`,
      };
    });
  }

  parseVocabulary(contents: string): ParsedVocabulary {
    const lines = this.nonEmptyLines(contents);
    if (lines.length === 0) {
      return { words: [], ambiguities: [] };
    }

    const words: ParsedWord[] = [];
    const ambiguities: AmbiguousBoundary[] = [];
    let current: ParsedWord | undefined;

    for (const line of lines) {
      const mustBeSentence = current && current.sentences.length === 0;
      const termCandidate = this.looksLikeTerm(line.text);
      const startsWord = !current || (!mustBeSentence && termCandidate);

      if (startsWord) {
        current = {
          text: this.cleanTerm(line.text),
          sourceOrder: words.length + 1,
          sentences: [],
        };
        words.push(current);
        if (line.text.split(/\s+/).length >= 3) {
          ambiguities.push({
            line: line.line,
            text: line.text,
            interpretedAs: 'word',
            reason:
              'A term containing three or more words may be a short sentence.',
          });
        }
        continue;
      }

      if (!current) {
        throw new Error('Vocabulary parser reached an invalid state.');
      }
      const sentence: ParsedSentence = {
        text: line.text,
        sourceOrder: current.sentences.length + 1,
        normalizedHash: this.hashSentence(line.text),
      };
      current.sentences.push(sentence);

      if (!termCandidate && line.text.split(/\s+/).length <= 3) {
        ambiguities.push({
          line: line.line,
          text: line.text,
          interpretedAs: 'sentence',
          reason: 'A very short sentence may instead be a vocabulary term.',
        });
      }
    }

    return { words, ambiguities };
  }

  hashSentence(sentence: string): string {
    const normalized = sentence.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    return createHash('sha256').update(normalized).digest('hex');
  }

  slugify(value: string): string {
    const slug = value
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .toLocaleLowerCase();
    return slug.slice(0, 60) || 'word';
  }

  private cleanTerm(value: string): string {
    return value.trim().replace(/\.$/, '');
  }

  private looksLikeTerm(value: string): boolean {
    const trimmed = value.trim().replace(/\.$/, '');
    const tokens = trimmed.split(/\s+/);
    if (
      trimmed.length > 60 ||
      tokens.length > 5 ||
      /[,!?;:“”"']/.test(trimmed)
    ) {
      return false;
    }

    if (tokens.length === 1) {
      return true;
    }
    const sentenceWords = new Set([
      'am',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'has',
      'have',
      'had',
      'can',
      'could',
      'should',
      'would',
      'will',
      'must',
      'does',
      'did',
      'to',
      'for',
      'in',
      'on',
      'at',
      'with',
      'from',
      'into',
      'your',
      'my',
      'his',
      'her',
      'our',
      'their',
      'this',
      'that',
      'these',
      'those',
    ]);
    return !tokens.some((token) => sentenceWords.has(token.toLowerCase()));
  }

  private nonEmptyLines(
    contents: string,
  ): Array<{ text: string; line: number }> {
    return contents
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((text, index) => ({ text: text.trim(), line: index + 1 }))
      .filter(({ text }) => text.length > 0);
  }
}

import { BadRequestException, Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import {
  Chapter,
  Sentence,
  VideoJob,
  VideoJobStatus,
  VocabularyWord,
} from '../database/entities';
import {
  AmbiguousBoundary,
  ParsedChapter,
  ParsedVocabulary,
  SourceParserService,
} from './source-parser.service';

export interface ChapterImportPreview {
  chapter: ParsedChapter;
  wordCount: number;
  sentenceCount: number;
  ambiguities: AmbiguousBoundary[];
}

export interface ImportPreview {
  sourceRoot: string;
  chapterCount: number;
  wordCount: number;
  sentenceCount: number;
  ambiguityCount: number;
  chapters: ChapterImportPreview[];
}

interface LoadedChapter {
  chapter: ParsedChapter;
  vocabulary: ParsedVocabulary;
}

@Injectable()
export class ImporterService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly parser: SourceParserService,
  ) {}

  async preview(): Promise<ImportPreview> {
    const loaded = await this.loadSources();
    const chapters = loaded.map(({ chapter, vocabulary }) => ({
      chapter,
      wordCount: vocabulary.words.length,
      sentenceCount: vocabulary.words.reduce(
        (total, word) => total + word.sentences.length,
        0,
      ),
      ambiguities: vocabulary.ambiguities,
    }));

    return {
      sourceRoot: this.sourceRoot,
      chapterCount: chapters.length,
      wordCount: chapters.reduce((total, item) => total + item.wordCount, 0),
      sentenceCount: chapters.reduce(
        (total, item) => total + item.sentenceCount,
        0,
      ),
      ambiguityCount: chapters.reduce(
        (total, item) => total + item.ambiguities.length,
        0,
      ),
      chapters,
    };
  }

  async confirm(forceAmbiguous = false): Promise<ImportPreview> {
    const loaded = await this.loadSources();
    const preview = await this.preview();
    if (preview.ambiguityCount > 0 && !forceAmbiguous) {
      throw new BadRequestException(
        `Import has ${preview.ambiguityCount} ambiguous boundaries. Review the preview and confirm with forceAmbiguous=true.`,
      );
    }

    await this.dataSource.transaction(async (manager) => {
      for (const item of loaded) {
        let chapter = await manager.findOne(Chapter, {
          where: { number: item.chapter.number },
        });
        chapter ??= manager.create(Chapter);
        chapter.number = item.chapter.number;
        chapter.title = item.chapter.title;
        chapter.sourceFile = item.chapter.sourceFile;
        chapter = await manager.save(chapter);

        for (const parsedWord of item.vocabulary.words) {
          let word = await manager.findOne(VocabularyWord, {
            where: {
              chapterId: chapter.id,
              sourceOrder: parsedWord.sourceOrder,
            },
          });
          word ??= manager.create(VocabularyWord, { chapterId: chapter.id });
          word.sourceOrder = parsedWord.sourceOrder;
          word.text = parsedWord.text;
          word.slug = this.parser.slugify(parsedWord.text);
          word = await manager.save(word);

          for (const parsedSentence of parsedWord.sentences) {
            let sentence = await manager.findOne(Sentence, {
              where: {
                wordId: word.id,
                sourceOrder: parsedSentence.sourceOrder,
              },
              relations: { videoJob: true },
            });
            const sentenceChanged =
              sentence !== null &&
              sentence.normalizedHash !== parsedSentence.normalizedHash;
            sentence ??= manager.create(Sentence, { wordId: word.id });
            sentence.sourceOrder = parsedSentence.sourceOrder;
            sentence.text = parsedSentence.text;
            sentence.normalizedHash = parsedSentence.normalizedHash;
            sentence = await manager.save(sentence);

            let job = sentence.videoJob;
            if (!job) {
              job = manager.create(VideoJob, {
                sentenceId: sentence.id,
                status: VideoJobStatus.PENDING,
              });
            } else if (sentenceChanged) {
              Object.assign(job, {
                status: VideoJobStatus.PENDING,
                externalVideoId: null,
                remoteUrl: null,
                localPath: null,
                attempts: 0,
                lastError: 'Sentence changed during source re-import.',
                nextAttemptAt: null,
                submittedAt: null,
                completedAt: null,
              });
            }
            await manager.save(job);
          }
        }
      }
    });

    return preview;
  }

  private async loadSources(): Promise<LoadedChapter[]> {
    const chapterText = await readFile(
      join(this.sourceRoot, 'chapter.txt'),
      'utf8',
    );
    const chapters = this.parser.parseChapters(chapterText);
    return Promise.all(
      chapters.map(async (chapter) => {
        const contents = await readFile(
          join(this.sourceRoot, 'words-sentences', chapter.sourceFile),
          'utf8',
        );
        return {
          chapter,
          vocabulary: this.parser.parseVocabulary(contents),
        };
      }),
    );
  }

  private get sourceRoot(): string {
    return process.env.SOURCE_ROOT ?? join(process.cwd(), 'src', 'static');
  }
}

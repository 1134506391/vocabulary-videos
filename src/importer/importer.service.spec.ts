import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataSource } from 'typeorm';
import {
  Chapter,
  DailyUsage,
  Sentence,
  VideoJob,
  VocabularyWord,
} from '../database/entities';
import { ImporterService } from './importer.service';
import { SourceParserService } from './source-parser.service';

describe('ImporterService', () => {
  let root: string;
  let dataSource: DataSource;
  let originalSourceRoot: string | undefined;

  beforeEach(async () => {
    originalSourceRoot = process.env.SOURCE_ROOT;
    root = await mkdtemp(join(tmpdir(), 'vocabulary-import-'));
    await mkdir(join(root, 'words-sentences'));
    await writeFile(join(root, 'chapter.txt'), 'Chapter 1：Test\n');
    await writeFile(
      join(root, 'words-sentences', '1.txt'),
      'Atmosphere.\n\nThe atmosphere is calm.\n',
    );
    process.env.SOURCE_ROOT = root;
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [Chapter, VocabularyWord, Sentence, VideoJob, DailyUsage],
      synchronize: true,
    });
    await dataSource.initialize();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
    await rm(root, { recursive: true, force: true });
    if (originalSourceRoot === undefined) {
      delete process.env.SOURCE_ROOT;
    } else {
      process.env.SOURCE_ROOT = originalSourceRoot;
    }
  });

  it('is idempotent and creates one pending job per sentence', async () => {
    const importer = new ImporterService(dataSource, new SourceParserService());

    await importer.confirm(true);
    await importer.confirm(true);

    await expect(dataSource.getRepository(Chapter).count()).resolves.toBe(1);
    await expect(
      dataSource.getRepository(VocabularyWord).count(),
    ).resolves.toBe(1);
    await expect(dataSource.getRepository(Sentence).count()).resolves.toBe(1);
    await expect(dataSource.getRepository(VideoJob).count()).resolves.toBe(1);
  });
});

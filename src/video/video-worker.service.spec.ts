import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DataSource } from 'typeorm';
import {
  Chapter,
  DailyUsage,
  Sentence,
  VideoJob,
  VideoJobStatus,
  VocabularyWord,
} from '../database/entities';
import { AgnesClient } from './agnes.client';
import { ChapterAssemblyService } from './chapter-assembly.service';
import { VideoWorkerService } from './video-worker.service';

describe('VideoWorkerService', () => {
  let dataSource: DataSource;
  let outputRoot: string;
  let originalOutputRoot: string | undefined;

  beforeEach(async () => {
    originalOutputRoot = process.env.VIDEO_OUTPUT_ROOT;
    outputRoot = await mkdtemp(join(tmpdir(), 'vocabulary-videos-'));
    process.env.VIDEO_OUTPUT_ROOT = outputRoot;
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [Chapter, VocabularyWord, Sentence, VideoJob, DailyUsage],
      synchronize: true,
    });
    await dataSource.initialize();
  });

  afterEach(async () => {
    await dataSource.destroy();
    await rm(outputRoot, { recursive: true, force: true });
    if (originalOutputRoot === undefined) {
      delete process.env.VIDEO_OUTPUT_ROOT;
    } else {
      process.env.VIDEO_OUTPUT_ROOT = originalOutputRoot;
    }
  });

  it('submits, polls, downloads, and records one sentence without duplication', async () => {
    const chapter = await dataSource.getRepository(Chapter).save({
      number: 1,
      title: 'Test',
      sourceFile: '1.txt',
    });
    const word = await dataSource.getRepository(VocabularyWord).save({
      chapterId: chapter.id,
      sourceOrder: 1,
      text: 'Atmosphere',
      slug: 'atmosphere',
    });
    const sentence = await dataSource.getRepository(Sentence).save({
      wordId: word.id,
      sourceOrder: 1,
      text: 'The atmosphere is calm.',
      normalizedHash: 'hash',
    });
    await dataSource.getRepository(VideoJob).save({
      sentenceId: sentence.id,
      status: VideoJobStatus.PENDING,
    });

    const createVideo = jest.fn(() =>
      Promise.resolve({
        id: 'video-1',
        video_id: 'video-1',
        task_id: 'video-1',
        status: 'queued',
        progress: 0,
      }),
    );
    const getVideo = jest.fn(() =>
      Promise.resolve({
        id: 'video-1',
        status: 'completed',
        progress: 100,
        error: null,
        url: 'https://example.com/video.mp4',
      }),
    );
    const downloadVideo = jest.fn(async (_url: string, destination: string) => {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, 'mock video');
    });
    const writeManifest = jest.fn(() =>
      Promise.resolve({
        jsonPath: 'manifest.json',
        concatPath: 'concat.txt',
        clipCount: 1,
      }),
    );
    const agnes = {
      isConfigured: jest.fn(() => true),
      createVideo,
      getVideo,
      downloadVideo,
    } as unknown as AgnesClient;
    const assembly = {
      writeManifest,
    } as unknown as ChapterAssemblyService;
    const worker = new VideoWorkerService(
      dataSource.getRepository(VideoJob),
      dataSource,
      agnes,
      assembly,
    );
    await worker.start();
    await worker.tick();
    await worker.tick();

    const saved = await dataSource.getRepository(VideoJob).findOneByOrFail({
      sentenceId: sentence.id,
    });
    expect(createVideo).toHaveBeenCalledTimes(1);
    expect(getVideo).toHaveBeenCalledTimes(1);
    expect(downloadVideo).toHaveBeenCalledTimes(1);
    expect(saved).toMatchObject({
      status: VideoJobStatus.DOWNLOADED,
      externalVideoId: 'video-1',
      lastError: null,
    });
    expect(saved.localPath).toContain('chapter-01/0001-atmosphere/0001-1.mp4');
    const usage = await dataSource.getRepository(DailyUsage).find();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      secondsReserved: 5,
      requestsSubmitted: 1,
    });
  });
});

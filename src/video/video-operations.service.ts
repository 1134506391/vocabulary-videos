import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DailyUsage, VideoJob, VideoJobStatus } from '../database/entities';
import { AgnesKeyService } from './agnes-key.service';
import { VideoWorkerService } from './video-worker.service';

@Injectable()
export class VideoOperationsService {
  constructor(
    @InjectRepository(VideoJob)
    private readonly jobs: Repository<VideoJob>,
    @InjectRepository(DailyUsage)
    private readonly usage: Repository<DailyUsage>,
    private readonly worker: VideoWorkerService,
    private readonly keys: AgnesKeyService,
  ) {}

  async status() {
    const [statusRows, chapterRows, recentUsage, keySummary, keyList] =
      await Promise.all([
        this.jobs
          .createQueryBuilder('job')
          .select('job.status', 'status')
          .addSelect('COUNT(*)', 'count')
          .groupBy('job.status')
          .getRawMany<{ status: VideoJobStatus; count: string }>(),
        this.jobs
          .createQueryBuilder('job')
          .innerJoin('job.sentence', 'sentence')
          .innerJoin('sentence.word', 'word')
          .innerJoin('word.chapter', 'chapter')
          .select('chapter.number', 'chapterNumber')
          .addSelect('chapter.title', 'chapterTitle')
          .addSelect('COUNT(*)', 'total')
          .addSelect(
            `SUM(CASE WHEN job.status = '${VideoJobStatus.DOWNLOADED}' THEN 1 ELSE 0 END)`,
            'downloaded',
          )
          .groupBy('chapter.id')
          .orderBy('chapter.number', 'ASC')
          .getRawMany<{
            chapterNumber: string;
            chapterTitle: string;
            total: string;
            downloaded: string;
          }>(),
        this.usage.find({ order: { localDate: 'DESC' }, take: 7 }),
        this.keys.availableKeySummary(),
        this.keys.list(),
      ]);

    const counts = Object.fromEntries(
      Object.values(VideoJobStatus).map((status) => [status, 0]),
    ) as Record<VideoJobStatus, number>;
    for (const row of statusRows) {
      counts[row.status] = Number(row.count);
    }

    return {
      worker: await this.worker.runtimeState(),
      keys: keySummary,
      keyDetails: keyList,
      counts,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      chapters: chapterRows.map((row) => ({
        chapterNumber: Number(row.chapterNumber),
        chapterTitle: row.chapterTitle,
        total: Number(row.total),
        downloaded: Number(row.downloaded),
      })),
      recentUsage,
      note: 'DAILY_VIDEO_SECONDS is a soft estimate only. New submissions stop when every enabled key returns a real quota HTTP 429.',
    };
  }

  failures() {
    return this.jobs.find({
      where: { status: VideoJobStatus.FAILED },
      relations: { sentence: { word: { chapter: true } } },
      order: { updatedAt: 'DESC' },
      take: 100,
    });
  }

  async retry(jobId: number): Promise<VideoJob> {
    const job = await this.jobs.findOneBy({ id: jobId });
    if (!job) {
      throw new NotFoundException(`Job ${jobId} was not found.`);
    }
    if (job.status !== VideoJobStatus.FAILED) {
      throw new BadRequestException(`Job ${jobId} is not failed.`);
    }
    this.resetFailedJob(job);
    const saved = await this.jobs.save(job);
    void this.worker.tick();
    return saved;
  }

  private resetFailedJob(job: VideoJob): void {
    job.status = VideoJobStatus.PENDING;
    job.externalVideoId = null;
    job.apiKeyId = null;
    job.remoteUrl = null;
    job.localPath = null;
    job.attempts = 0;
    job.lastError = null;
    job.nextAttemptAt = null;
    job.submittedAt = null;
    job.completedAt = null;
  }

  async retryAll(): Promise<{ retried: number }> {
    const failed = await this.jobs.findBy({ status: VideoJobStatus.FAILED });
    for (const job of failed) {
      this.resetFailedJob(job);
    }
    await this.jobs.save(failed);
    void this.worker.tick();
    return { retried: failed.length };
  }
}

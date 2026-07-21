import {
  BadRequestException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { join, relative } from 'node:path';
import { DataSource, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { DailyUsage, VideoJob, VideoJobStatus } from '../database/entities';
import {
  AgnesApiError,
  AgnesClient,
  AgnesStatusResponse,
} from './agnes.client';
import { ChapterAssemblyService } from './chapter-assembly.service';
import {
  clipRelativePath,
  hasDailyBudget,
  remoteJobStatus,
} from './video-policy';

@Injectable()
export class VideoWorkerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(VideoWorkerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private paused = true;
  private rateLimitedOnDate: string | null = null;

  constructor(
    @InjectRepository(VideoJob)
    private readonly jobs: Repository<VideoJob>,
    private readonly dataSource: DataSource,
    private readonly agnes: AgnesClient,
    private readonly assembly: ChapterAssemblyService,
  ) {}

  onApplicationBootstrap(): void {
    this.paused =
      process.env.WORKER_AUTO_START === 'false' || !this.agnes.isConfigured();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.timer.unref();
    if (!this.paused) {
      void this.tick();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async start(): Promise<{ paused: boolean; configured: boolean }> {
    if (!this.agnes.isConfigured()) {
      throw new BadRequestException('AGNES_API_KEY is not configured.');
    }
    this.paused = false;
    await this.tick();
    return this.runtimeState();
  }

  pause(): { paused: boolean; configured: boolean } {
    this.paused = true;
    return this.runtimeState();
  }

  runtimeState(): { paused: boolean; configured: boolean } {
    return {
      paused: this.paused,
      configured: this.agnes.isConfigured(),
    };
  }

  async tick(): Promise<void> {
    if (this.paused || this.running) {
      return;
    }
    const today = this.localDate();
    if (this.rateLimitedOnDate === today) {
      return;
    }
    this.rateLimitedOnDate = null;
    this.running = true;
    try {
      await this.processOnce();
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
    }
  }

  private async processOnce(): Promise<void> {
    const completed = await this.jobs.findOne({
      where: [
        { status: VideoJobStatus.COMPLETED, nextAttemptAt: IsNull() },
        {
          status: VideoJobStatus.COMPLETED,
          nextAttemptAt: LessThanOrEqual(new Date()),
        },
      ],
      relations: {
        sentence: { word: { chapter: true } },
      },
      order: { completedAt: 'ASC', id: 'ASC' },
    });
    if (completed) {
      await this.download(completed);
      return;
    }

    const active = await this.jobs.findOne({
      where: [
        { status: VideoJobStatus.SUBMITTED, nextAttemptAt: IsNull() },
        {
          status: VideoJobStatus.SUBMITTED,
          nextAttemptAt: LessThanOrEqual(new Date()),
        },
        { status: VideoJobStatus.PROCESSING, nextAttemptAt: IsNull() },
        {
          status: VideoJobStatus.PROCESSING,
          nextAttemptAt: LessThanOrEqual(new Date()),
        },
      ],
      order: { submittedAt: 'ASC', id: 'ASC' },
    });
    if (active) {
      await this.poll(active);
      return;
    }

    const pending = await this.jobs.findOne({
      where: [
        { status: VideoJobStatus.PENDING, nextAttemptAt: IsNull() },
        {
          status: VideoJobStatus.PENDING,
          nextAttemptAt: LessThanOrEqual(new Date()),
        },
      ],
      relations: { sentence: true },
      order: { id: 'ASC' },
    });
    if (!pending) {
      return;
    }

    const reserved = await this.reserveDailyBudget();
    if (!reserved) {
      return;
    }
    await this.submit(pending);
  }

  private async submit(job: VideoJob): Promise<void> {
    job.attempts += 1;
    job.nextAttemptAt = null;
    try {
      const result = await this.agnes.createVideo(job.sentence.text);
      job.externalVideoId = result.video_id;
      job.status = VideoJobStatus.SUBMITTED;
      job.submittedAt = new Date();
      job.lastError = null;
      await this.jobs.save(job);
      this.logger.log(
        `Submitted sentence ${job.sentenceId} as ${result.video_id}`,
      );
    } catch (error) {
      const apiError = this.asApiError(error);
      job.lastError = apiError.message;
      if (apiError.rateLimited) {
        this.rateLimitedOnDate = this.localDate();
      }
      const permanent =
        (apiError.statusCode !== undefined &&
          apiError.statusCode >= 400 &&
          apiError.statusCode < 500 &&
          !apiError.rateLimited) ||
        job.attempts >= this.maxAttempts;
      job.status = permanent ? VideoJobStatus.FAILED : VideoJobStatus.PENDING;
      job.nextAttemptAt = permanent ? null : this.retryTime(job.attempts);
      await this.jobs.save(job);
    }
  }

  private async poll(job: VideoJob): Promise<void> {
    if (!job.externalVideoId) {
      job.status = VideoJobStatus.FAILED;
      job.lastError = 'An in-flight job has no external video ID.';
      await this.jobs.save(job);
      return;
    }

    try {
      const result = await this.agnes.getVideo(job.externalVideoId);
      this.applyRemoteStatus(job, result);
      await this.jobs.save(job);
    } catch (error) {
      const apiError = this.asApiError(error);
      job.lastError = apiError.message;
      job.nextAttemptAt = this.retryTime(1);
      if (
        apiError.statusCode !== undefined &&
        apiError.statusCode >= 400 &&
        apiError.statusCode < 500 &&
        !apiError.rateLimited
      ) {
        job.status = VideoJobStatus.FAILED;
        job.nextAttemptAt = null;
      }
      if (apiError.rateLimited) {
        this.rateLimitedOnDate = this.localDate();
      }
      await this.jobs.save(job);
    }
  }

  private applyRemoteStatus(job: VideoJob, result: AgnesStatusResponse): void {
    const status = (result.internal_status ?? result.status).toLowerCase();
    const mappedStatus = remoteJobStatus(status);
    job.lastError = null;
    job.nextAttemptAt = null;
    if (mappedStatus === VideoJobStatus.COMPLETED) {
      if (!result.url) {
        throw new AgnesApiError(
          'Agnes marked the video completed but omitted its URL.',
        );
      }
      job.status = VideoJobStatus.COMPLETED;
      job.remoteUrl = result.url;
      job.completedAt = new Date();
      return;
    }
    if (mappedStatus === VideoJobStatus.FAILED) {
      job.status = VideoJobStatus.FAILED;
      job.lastError =
        typeof result.error === 'string'
          ? result.error
          : JSON.stringify(result.error ?? 'Agnes generation failed.');
      return;
    }
    job.status = mappedStatus;
  }

  private async download(job: VideoJob): Promise<void> {
    if (!job.remoteUrl) {
      job.status = VideoJobStatus.FAILED;
      job.lastError = 'Completed job has no download URL.';
      await this.jobs.save(job);
      return;
    }
    const chapter = job.sentence.word.chapter;
    const word = job.sentence.word;
    const sentence = job.sentence;
    const destination = join(
      this.videoRoot,
      clipRelativePath({
        chapterNumber: chapter.number,
        wordOrder: word.sourceOrder,
        wordSlug: word.slug,
        sentenceOrder: sentence.sourceOrder,
        sentenceId: sentence.id,
      }),
    );

    try {
      await this.agnes.downloadVideo(job.remoteUrl, destination);
      job.localPath = relative(process.cwd(), destination).replace(/\\/g, '/');
      job.status = VideoJobStatus.DOWNLOADED;
      job.lastError = null;
      job.nextAttemptAt = null;
      await this.jobs.save(job);
      await this.assembly.writeManifest(chapter.number);
      this.logger.log(`Downloaded ${job.localPath}`);
    } catch (error) {
      job.lastError = this.asApiError(error).message;
      job.nextAttemptAt = this.retryTime(1);
      await this.jobs.save(job);
    }
  }

  private async reserveDailyBudget(): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const localDate = this.localDate();
      let usage = await manager.findOne(DailyUsage, {
        where: { localDate },
      });
      usage ??= manager.create(DailyUsage, {
        localDate,
        secondsReserved: 0,
        requestsSubmitted: 0,
      });
      if (
        !hasDailyBudget(
          usage.secondsReserved,
          this.clipSeconds,
          this.dailyVideoSeconds,
        )
      ) {
        return false;
      }
      usage.secondsReserved += this.clipSeconds;
      usage.requestsSubmitted += 1;
      await manager.save(usage);
      return true;
    });
  }

  private localDate(date = new Date()): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: process.env.VIDEO_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  private retryTime(attempt: number): Date {
    const seconds = Math.min(300, 10 * 2 ** Math.max(0, attempt - 1));
    return new Date(Date.now() + seconds * 1000);
  }

  private asApiError(error: unknown): AgnesApiError {
    return error instanceof AgnesApiError
      ? error
      : new AgnesApiError(
          error instanceof Error ? error.message : String(error),
        );
  }

  private numberSetting(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private get clipSeconds(): number {
    return this.numberSetting('VIDEO_CLIP_SECONDS', 5);
  }

  private get dailyVideoSeconds(): number {
    return this.numberSetting('DAILY_VIDEO_SECONDS', 500);
  }

  private get maxAttempts(): number {
    return this.numberSetting('VIDEO_MAX_ATTEMPTS', 3);
  }

  private get pollIntervalMs(): number {
    return this.numberSetting('VIDEO_POLL_INTERVAL_MS', 10_000);
  }

  private get videoRoot(): string {
    return process.env.VIDEO_OUTPUT_ROOT ?? join(process.cwd(), 'videos');
  }
}

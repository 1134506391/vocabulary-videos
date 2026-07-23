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
import { AgnesKeyService } from './agnes-key.service';
import { ChapterAssemblyService } from './chapter-assembly.service';
import { clipRelativePath, remoteJobStatus } from './video-policy';

@Injectable()
export class VideoWorkerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(VideoWorkerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private paused = true;
  /** Set when every enabled key hit a real quota 429 for the local day. */
  private allKeysExhaustedOnDate: string | null = null;
  private softBudgetWarnedOnDate: string | null = null;

  constructor(
    @InjectRepository(VideoJob)
    private readonly jobs: Repository<VideoJob>,
    private readonly dataSource: DataSource,
    private readonly agnes: AgnesClient,
    private readonly keys: AgnesKeyService,
    private readonly assembly: ChapterAssemblyService,
  ) {}

  onApplicationBootstrap(): void {
    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    const configured = await this.agnes.isConfigured();
    this.paused = process.env.WORKER_AUTO_START === 'false' || !configured;
    const summary = await this.keys.availableKeySummary();
    this.logger.log(
      `Worker initialized: ${this.paused ? 'paused' : 'running'}, poll interval ${this.pollIntervalMs / 1000}s, soft estimate ${this.dailyVideoSeconds}s/key, keys available today ${summary.availableToday}/${summary.totalEnabled}.`,
    );
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

  async start(): Promise<{
    paused: boolean;
    configured: boolean;
    keys: Awaited<ReturnType<AgnesKeyService['availableKeySummary']>>;
  }> {
    if (!(await this.agnes.isConfigured())) {
      throw new BadRequestException(
        'No Agnes API keys configured. Seed AGNES_API_KEY_1..N in .env or POST /videos/keys.',
      );
    }
    this.paused = false;
    this.allKeysExhaustedOnDate = null;
    this.logger.log('Worker started or resumed by API request.');
    await this.tick();
    return this.runtimeState();
  }

  async pause(): Promise<{
    paused: boolean;
    configured: boolean;
    keys: Awaited<ReturnType<AgnesKeyService['availableKeySummary']>>;
  }> {
    this.paused = true;
    this.logger.warn(
      'Worker paused by API request. Existing Agnes tasks continue remotely and will resume polling after start.',
    );
    return this.runtimeState();
  }

  async runtimeState(): Promise<{
    paused: boolean;
    configured: boolean;
    keys: Awaited<ReturnType<AgnesKeyService['availableKeySummary']>>;
  }> {
    return {
      paused: this.paused,
      configured: await this.agnes.isConfigured(),
      keys: await this.keys.availableKeySummary(),
    };
  }

  async tick(): Promise<void> {
    if (this.paused || this.running) {
      return;
    }
    const today = this.keys.localDate();
    if (this.allKeysExhaustedOnDate === today) {
      return;
    }
    this.allKeysExhaustedOnDate = null;
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
      this.logger.log(
        `${this.jobLabel(completed)} is complete on Agnes; downloading the MP4.`,
      );
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
      relations: {
        sentence: { word: { chapter: true } },
      },
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
      this.logger.log('Queue is idle: no pending jobs are ready to submit.');
      return;
    }

    // Soft estimate only — real stop condition is HTTP 429 quota across all keys.
    await this.recordSoftUsage();
    await this.submit(pending);
  }

  private async submit(job: VideoJob): Promise<void> {
    job.attempts += 1;
    job.nextAttemptAt = null;
    try {
      const result = await this.agnes.createVideo(job.sentence.text);
      job.externalVideoId = result.video_id;
      job.apiKeyId = result.apiKeyId;
      job.status = VideoJobStatus.SUBMITTED;
      job.submittedAt = new Date();
      job.lastError = null;
      await this.jobs.save(job);
      this.logger.log(
        `${this.jobLabel(job)} submitted to Agnes as ${result.video_id} with key #${result.apiKeyId}. Waiting for the first status poll.`,
      );
    } catch (error) {
      const apiError = this.asApiError(error);
      job.lastError = apiError.message;
      if (apiError.quotaExhausted) {
        this.allKeysExhaustedOnDate = this.keys.localDate();
      }
      const permanent =
        (apiError.statusCode !== undefined &&
          apiError.statusCode >= 400 &&
          apiError.statusCode < 500 &&
          !apiError.quotaExhausted &&
          apiError.statusCode !== 429) ||
        (!apiError.quotaExhausted && job.attempts >= this.maxAttempts);
      job.status = permanent ? VideoJobStatus.FAILED : VideoJobStatus.PENDING;
      job.nextAttemptAt = permanent
        ? null
        : apiError.statusCode === 429
          ? new Date(Date.now() + this.pollIntervalMs)
          : this.retryTime(job.attempts);
      await this.jobs.save(job);
      if (apiError.quotaExhausted) {
        this.logger.warn(
          `${this.jobLabel(job)} could not submit: all Agnes keys are quota-exhausted for today. Will resume next local day or after POST /videos/keys/:id/reset.`,
        );
      } else if (permanent) {
        this.logger.error(
          `${this.jobLabel(job)} failed permanently after ${job.attempts} submission attempt(s): ${apiError.message}`,
        );
      } else {
        this.logger.warn(
          `${this.jobLabel(job)} submission failed; retrying at ${job.nextAttemptAt?.toISOString()}: ${apiError.message}`,
        );
      }
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
      const result = await this.agnes.getVideo(
        job.externalVideoId,
        job.apiKeyId,
      );
      const previousStatus = job.status;
      this.applyRemoteStatus(job, result);
      if (
        job.status === VideoJobStatus.SUBMITTED ||
        job.status === VideoJobStatus.PROCESSING
      ) {
        job.nextAttemptAt = new Date(Date.now() + this.pollIntervalMs);
      }
      await this.jobs.save(job);
      const elapsed = job.submittedAt
        ? `${Math.floor((Date.now() - job.submittedAt.getTime()) / 1000)}s`
        : 'unknown duration';
      this.logger.log(
        `${this.jobLabel(job)} polled Agnes task ${job.externalVideoId}: ${previousStatus} -> ${job.status}, remote status "${result.internal_status ?? result.status}", progress ${result.progress ?? 'unknown'}%, elapsed ${elapsed}.`,
      );
    } catch (error) {
      const apiError = this.asApiError(error);
      job.lastError = apiError.message;
      job.nextAttemptAt =
        apiError.statusCode === 429
          ? new Date(Date.now() + this.pollIntervalMs)
          : this.retryTime(1);
      if (
        apiError.statusCode !== undefined &&
        apiError.statusCode >= 400 &&
        apiError.statusCode < 500 &&
        !apiError.quotaExhausted &&
        apiError.statusCode !== 429
      ) {
        job.status = VideoJobStatus.FAILED;
        job.nextAttemptAt = null;
      }
      if (apiError.quotaExhausted) {
        this.allKeysExhaustedOnDate = this.keys.localDate();
      }
      await this.jobs.save(job);
      if (apiError.quotaExhausted) {
        this.logger.warn(
          `${this.jobLabel(job)} status polling blocked: all Agnes keys are quota-exhausted for today.`,
        );
      } else if (job.status === VideoJobStatus.FAILED) {
        this.logger.error(
          `${this.jobLabel(job)} status polling failed permanently: ${apiError.message}`,
        );
      } else {
        this.logger.warn(
          `${this.jobLabel(job)} status poll failed; retrying at ${job.nextAttemptAt?.toISOString()}: ${apiError.message}`,
        );
      }
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
      this.logger.log(`${this.jobLabel(job)} downloaded to ${job.localPath}.`);
    } catch (error) {
      job.lastError = this.asApiError(error).message;
      job.nextAttemptAt = this.retryTime(1);
      await this.jobs.save(job);
      this.logger.warn(
        `${this.jobLabel(job)} download failed; retrying at ${job.nextAttemptAt.toISOString()}: ${job.lastError}`,
      );
    }
  }

  /**
   * Soft estimate only. Never blocks submissions.
   * Real quota enforcement is HTTP 429 from Agnes + key rotation.
   */
  private async recordSoftUsage(): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const localDate = this.keys.localDate();
      let usage = await manager.findOne(DailyUsage, {
        where: { localDate },
      });
      usage ??= manager.create(DailyUsage, {
        localDate,
        secondsReserved: 0,
        requestsSubmitted: 0,
      });
      usage.secondsReserved += this.clipSeconds;
      usage.requestsSubmitted += 1;
      await manager.save(usage);

      if (
        this.dailyVideoSeconds > 0 &&
        usage.secondsReserved > this.dailyVideoSeconds &&
        this.softBudgetWarnedOnDate !== localDate
      ) {
        this.softBudgetWarnedOnDate = localDate;
        this.logger.warn(
          `Soft estimate DAILY_VIDEO_SECONDS=${this.dailyVideoSeconds} exceeded (${usage.secondsReserved}s reserved today). Continuing until Agnes returns quota 429.`,
        );
      }
    });
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
    return Number.isFinite(value) && value >= 0 ? value : fallback;
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
    return Math.max(
      this.numberSetting('VIDEO_POLL_INTERVAL_MS', 60_000),
      60_000,
    );
  }

  private get videoRoot(): string {
    return process.env.VIDEO_OUTPUT_ROOT ?? join(process.cwd(), 'videos');
  }

  private jobLabel(job: VideoJob): string {
    const sentence = job.sentence;
    const word = sentence?.word;
    const chapter = word?.chapter;
    if (!sentence || !word || !chapter) {
      return `Job ${job.id} (sentence ${job.sentenceId})`;
    }
    return `Job ${job.id}: chapter ${chapter.number}, "${word.text}", sentence ${sentence.sourceOrder}`;
  }
}

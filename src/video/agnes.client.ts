import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { AgnesApiKey } from '../database/entities';
import { AgnesKeyService } from './agnes-key.service';

export interface AgnesCreateResponse {
  id: string;
  video_id: string;
  task_id: string;
  status: string;
  progress: number;
  apiKeyId: number;
}

export interface AgnesStatusResponse {
  id: string;
  status: string;
  internal_status?: string;
  progress: number;
  error: unknown;
  url?: string;
  completed_at?: number;
}

export class AgnesApiError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    /** True only for daily quota exhaustion (not temporary "too frequent"). */
    readonly quotaExhausted = false,
    readonly exhaustedKeyId?: number,
  ) {
    super(message);
  }

  /** Backward-compatible alias used by the worker. */
  get rateLimited(): boolean {
    return this.quotaExhausted;
  }
}

@Injectable()
export class AgnesClient {
  private readonly logger = new Logger(AgnesClient.name);
  private readonly http: AxiosInstance;

  constructor(private readonly keyService: AgnesKeyService) {
    this.http = axios.create({
      baseURL: process.env.AGNES_API_BASE_URL ?? 'https://apihub.agnes-ai.com',
      timeout: this.numberSetting('AGNES_REQUEST_TIMEOUT_MS', 30_000),
    });
  }

  async isConfigured(): Promise<boolean> {
    return this.keyService.isConfigured();
  }

  async createVideo(prompt: string): Promise<AgnesCreateResponse> {
    return this.withAvailableKeys('create video', async (key) => {
      const response = await this.http.post<AgnesCreateResponse>(
        '/v1/videos',
        {
          model: process.env.AGNES_MODEL ?? 'agnes-video-v2.0',
          prompt,
          height: this.numberSetting('VIDEO_HEIGHT', 768),
          width: this.numberSetting('VIDEO_WIDTH', 1152),
          num_frames: this.numberSetting('VIDEO_NUM_FRAMES', 121),
          frame_rate: this.numberSetting('VIDEO_FRAME_RATE', 24),
        },
        { headers: this.authHeaders(key.apiKey) },
      );
      if (!response.data.video_id) {
        throw new AgnesApiError('Agnes create response omitted video_id.');
      }
      await this.keyService.markSuccess(key.id);
      return {
        ...response.data,
        apiKeyId: key.id,
      };
    });
  }

  async getVideo(
    videoId: string,
    preferredKeyId?: number | null,
  ): Promise<AgnesStatusResponse> {
    // Prefer the creating key first (status may be account-scoped), then fall back.
    const preferred =
      preferredKeyId != null
        ? await this.keyService.findById(preferredKeyId)
        : null;
    const available = await this.keyService.listAvailableForCreate();
    const ordered: AgnesApiKey[] = [];
    if (preferred?.enabled) {
      ordered.push(preferred);
    }
    for (const key of available) {
      if (!ordered.some((item) => item.id === key.id)) {
        ordered.push(key);
      }
    }
    // Even exhausted keys may still answer status polls; append remaining enabled keys.
    if (ordered.length === 0 && preferred) {
      ordered.push(preferred);
    }

    if (ordered.length === 0) {
      throw new AgnesApiError('No Agnes API keys configured.', 500, false);
    }

    let lastError: AgnesApiError | null = null;
    for (const key of ordered) {
      try {
        const response = await this.http.get<AgnesStatusResponse>('/agnesapi', {
          params: { video_id: videoId },
          headers: this.authHeaders(key.apiKey),
        });
        if (!response.data.status && !response.data.internal_status) {
          throw new AgnesApiError('Agnes status response omitted status.');
        }
        return response.data;
      } catch (error) {
        const apiError = this.normalizeError(error, 'get video status', key.id);
        lastError = apiError;
        if (apiError.quotaExhausted) {
          await this.keyService.markQuotaExhausted(key.id, apiError.message);
          continue;
        }
        // Temporary throttle or network: do not rotate forever on status polls.
        throw apiError;
      }
    }

    throw (
      lastError ??
      new AgnesApiError(
        'All Agnes API keys failed while polling video status.',
        429,
        true,
      )
    );
  }

  async downloadVideo(url: string, destination: string): Promise<void> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      throw new AgnesApiError('Refusing to download a non-HTTPS video URL.');
    }

    const partial = `${destination}.part`;
    await mkdir(dirname(destination), { recursive: true });
    await rm(partial, { force: true });
    try {
      const response = await axios.get<NodeJS.ReadableStream>(url, {
        responseType: 'stream',
        timeout: this.numberSetting('VIDEO_DOWNLOAD_TIMEOUT_MS', 120_000),
      });
      await pipeline(response.data, createWriteStream(partial));
      await rename(partial, destination);
    } catch (error) {
      await rm(partial, { force: true });
      throw this.normalizeError(error, 'download video');
    }
  }

  private authHeaders(apiKey: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private async withAvailableKeys<T>(
    action: string,
    request: (key: AgnesApiKey) => Promise<T>,
  ): Promise<T> {
    const available = await this.keyService.listAvailableForCreate();
    if (available.length === 0) {
      const summary = await this.keyService.availableKeySummary();
      if (summary.totalEnabled === 0) {
        throw new AgnesApiError('No Agnes API keys configured.', 500, false);
      }
      throw new AgnesApiError(
        `All ${summary.totalEnabled} enabled Agnes API keys are quota-exhausted for ${this.keyService.localDate()}.`,
        429,
        true,
      );
    }

    let lastQuotaError: AgnesApiError | null = null;
    for (const key of available) {
      try {
        this.logger.log(
          `Using Agnes API key #${key.id} (${key.label}) for "${action}".`,
        );
        return await request(key);
      } catch (error) {
        const apiError = this.normalizeError(error, action, key.id);
        if (!apiError.quotaExhausted) {
          throw apiError;
        }
        await this.keyService.markQuotaExhausted(key.id, apiError.message);
        lastQuotaError = apiError;
      }
    }

    throw (
      lastQuotaError ??
      new AgnesApiError(
        `All Agnes API keys are quota-exhausted for ${this.keyService.localDate()}.`,
        429,
        true,
      )
    );
  }

  private normalizeError(
    error: unknown,
    action: string,
    keyId?: number,
  ): AgnesApiError {
    if (error instanceof AgnesApiError) {
      return error;
    }
    if (error instanceof AxiosError) {
      const status = error.response?.status;
      const details =
        typeof error.response?.data === 'string'
          ? error.response.data
          : JSON.stringify(error.response?.data ?? {});
      const is429 = status === 429;
      // Temporary request throttling must NOT exhaust a key for the day.
      const isTooFrequent = /too frequent|once every|please limit/i.test(
        details,
      );
      const quotaExhausted = is429 && !isTooFrequent;
      return new AgnesApiError(
        `Failed to ${action}: HTTP ${status ?? 'network error'} ${details}`.trim(),
        status,
        quotaExhausted,
        keyId,
      );
    }
    return new AgnesApiError(
      `Failed to ${action}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  private numberSetting(name: string, fallback: number): number {
    const parsed = Number(process.env[name] ?? fallback);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}

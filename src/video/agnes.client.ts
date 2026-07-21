import { Injectable } from '@nestjs/common';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';

export interface AgnesCreateResponse {
  id: string;
  video_id: string;
  task_id: string;
  status: string;
  progress: number;
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
    readonly rateLimited = false,
  ) {
    super(message);
  }
}

@Injectable()
export class AgnesClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: process.env.AGNES_API_BASE_URL ?? 'https://apihub.agnes-ai.com',
      timeout: this.numberSetting('AGNES_REQUEST_TIMEOUT_MS', 30_000),
    });
  }

  isConfigured(): boolean {
    return Boolean(process.env.AGNES_API_KEY);
  }

  async createVideo(prompt: string): Promise<AgnesCreateResponse> {
    try {
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
        { headers: this.authHeaders },
      );
      if (!response.data.video_id) {
        throw new AgnesApiError('Agnes create response omitted video_id.');
      }
      return response.data;
    } catch (error) {
      throw this.normalizeError(error, 'create video');
    }
  }

  async getVideo(videoId: string): Promise<AgnesStatusResponse> {
    try {
      const response = await this.http.get<AgnesStatusResponse>('/agnesapi', {
        params: { video_id: videoId },
        headers: this.authHeaders,
      });
      if (!response.data.status && !response.data.internal_status) {
        throw new AgnesApiError('Agnes status response omitted status.');
      }
      return response.data;
    } catch (error) {
      throw this.normalizeError(error, 'get video status');
    }
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

  private get authHeaders(): Record<string, string> {
    const apiKey = process.env.AGNES_API_KEY;
    if (!apiKey) {
      throw new AgnesApiError('AGNES_API_KEY is not configured.');
    }
    return {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private normalizeError(error: unknown, action: string): AgnesApiError {
    if (error instanceof AgnesApiError) {
      return error;
    }
    if (error instanceof AxiosError) {
      const status = error.response?.status;
      const details =
        typeof error.response?.data === 'string'
          ? error.response.data
          : JSON.stringify(error.response?.data ?? {});
      return new AgnesApiError(
        `Failed to ${action}: HTTP ${status ?? 'network error'} ${details}`.trim(),
        status,
        status === 429,
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

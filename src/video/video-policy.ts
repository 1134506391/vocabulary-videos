import { join } from 'node:path';
import { VideoJobStatus } from '../database/entities';

export function hasDailyBudget(
  secondsReserved: number,
  clipSeconds: number,
  dailyLimitSeconds: number,
): boolean {
  return secondsReserved + clipSeconds <= dailyLimitSeconds;
}

export function remoteJobStatus(status: string): VideoJobStatus {
  const normalized = status.toLowerCase();
  if (normalized === 'completed' || normalized === 'succeeded') {
    return VideoJobStatus.COMPLETED;
  }
  if (['failed', 'error', 'cancelled', 'canceled'].includes(normalized)) {
    return VideoJobStatus.FAILED;
  }
  return normalized === 'queued'
    ? VideoJobStatus.SUBMITTED
    : VideoJobStatus.PROCESSING;
}

export function clipRelativePath(input: {
  chapterNumber: number;
  wordOrder: number;
  wordSlug: string;
  sentenceOrder: number;
  sentenceId: number;
}): string {
  return join(
    `chapter-${String(input.chapterNumber).padStart(2, '0')}`,
    `${String(input.wordOrder).padStart(4, '0')}-${input.wordSlug}`,
    `${String(input.sentenceOrder).padStart(4, '0')}-${input.sentenceId}.mp4`,
  );
}

import { VideoJobStatus } from '../database/entities';
import {
  clipRelativePath,
  hasDailyBudget,
  remoteJobStatus,
} from './video-policy';

describe('video policy', () => {
  it('allows exactly 100 five-second clips in a 500-second day', () => {
    expect(hasDailyBudget(495, 5, 500)).toBe(true);
    expect(hasDailyBudget(500, 5, 500)).toBe(false);
  });

  it('maps remote lifecycle states without resubmitting active work', () => {
    expect(remoteJobStatus('queued')).toBe(VideoJobStatus.SUBMITTED);
    expect(remoteJobStatus('processing')).toBe(VideoJobStatus.PROCESSING);
    expect(remoteJobStatus('completed')).toBe(VideoJobStatus.COMPLETED);
    expect(remoteJobStatus('failed')).toBe(VideoJobStatus.FAILED);
  });

  it('builds stable ordered filenames', () => {
    expect(
      clipRelativePath({
        chapterNumber: 1,
        wordOrder: 2,
        wordSlug: 'carbon-dioxide',
        sentenceOrder: 3,
        sentenceId: 42,
      }).replace(/\\/g, '/'),
    ).toBe('chapter-01/0002-carbon-dioxide/0003-42.mp4');
  });
});

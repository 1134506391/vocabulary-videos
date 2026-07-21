import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Sentence } from './sentence.entity';

export enum VideoJobStatus {
  PENDING = 'pending',
  SUBMITTED = 'submitted',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  DOWNLOADED = 'downloaded',
  FAILED = 'failed',
}

@Entity('video_jobs')
@Index(['status', 'nextAttemptAt'])
export class VideoJob {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  sentenceId: number;

  @OneToOne(() => Sentence, (sentence) => sentence.videoJob, {
    onDelete: 'CASCADE',
  })
  @JoinColumn()
  sentence: Sentence;

  @Column({
    type: 'varchar',
    enum: VideoJobStatus,
    default: VideoJobStatus.PENDING,
  })
  status: VideoJobStatus;

  @Column({ type: 'varchar', nullable: true, unique: true })
  externalVideoId: string | null;

  @Column({ type: 'text', nullable: true })
  remoteUrl: string | null;

  @Column({ type: 'text', nullable: true })
  localPath: string | null;

  @Column({ default: 0 })
  attempts: number;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: 'datetime', nullable: true })
  nextAttemptAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  submittedAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

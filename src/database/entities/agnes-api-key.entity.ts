import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity('agnes_api_keys')
@Unique(['apiKey'])
export class AgnesApiKey {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 120 })
  label: string;

  @Column({ type: 'text' })
  apiKey: string;

  @Column({ default: true })
  enabled: boolean;

  /** Lower numbers are preferred first. */
  @Column({ default: 100 })
  priority: number;

  /**
   * Local calendar date (YYYY-MM-DD) when this key last hit a real quota 429.
   * Keys with exhaustedOnDate === today are skipped for new submissions.
   */
  @Column({ type: 'varchar', length: 10, nullable: true })
  exhaustedOnDate: string | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ default: 0 })
  successCount: number;

  @Column({ default: 0 })
  quotaHitCount: number;

  @Column({ type: 'datetime', nullable: true })
  lastUsedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

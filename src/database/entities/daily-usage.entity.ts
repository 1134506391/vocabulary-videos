import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('daily_usage')
export class DailyUsage {
  @PrimaryColumn({ length: 10 })
  localDate: string;

  @Column({ default: 0 })
  secondsReserved: number;

  @Column({ default: 0 })
  requestsSubmitted: number;

  @UpdateDateColumn()
  updatedAt: Date;
}

import {
  Column,
  Entity,
  Index,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { VocabularyWord } from './vocabulary-word.entity';
import { VideoJob } from './video-job.entity';

@Entity('sentences')
@Unique(['wordId', 'sourceOrder'])
@Index(['normalizedHash'])
export class Sentence {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  wordId: number;

  @ManyToOne(() => VocabularyWord, (word) => word.sentences, {
    onDelete: 'CASCADE',
  })
  word: VocabularyWord;

  @Column()
  sourceOrder: number;

  @Column('text')
  text: string;

  @Column({ length: 64 })
  normalizedHash: string;

  @OneToOne(() => VideoJob, (job) => job.sentence)
  videoJob: VideoJob;
}

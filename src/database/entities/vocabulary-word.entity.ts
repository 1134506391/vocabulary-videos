import {
  Column,
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Chapter } from './chapter.entity';
import { Sentence } from './sentence.entity';

@Entity('vocabulary_words')
@Unique(['chapterId', 'sourceOrder'])
@Index(['chapterId', 'text'])
export class VocabularyWord {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  chapterId: number;

  @ManyToOne(() => Chapter, (chapter) => chapter.words, {
    onDelete: 'CASCADE',
  })
  chapter: Chapter;

  @Column()
  sourceOrder: number;

  @Column()
  text: string;

  @Column()
  slug: string;

  @OneToMany(() => Sentence, (sentence) => sentence.word)
  sentences: Sentence[];
}

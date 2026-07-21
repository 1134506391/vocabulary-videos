import {
  Column,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { VocabularyWord } from './vocabulary-word.entity';

@Entity('chapters')
@Unique(['number'])
export class Chapter {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  number: number;

  @Column()
  title: string;

  @Column()
  sourceFile: string;

  @OneToMany(() => VocabularyWord, (word) => word.chapter)
  words: VocabularyWord[];
}

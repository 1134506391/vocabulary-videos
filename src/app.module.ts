import 'dotenv/config';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import {
  AgnesApiKey,
  Chapter,
  DailyUsage,
  Sentence,
  VideoJob,
  VocabularyWord,
} from './database/entities';
import { ImporterModule } from './importer/importer.module';
import { VideoModule } from './video/video.module';

const databasePath =
  process.env.DATABASE_PATH ??
  join(process.cwd(), 'data', 'vocabulary-videos.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: databasePath,
      entities: [
        Chapter,
        VocabularyWord,
        Sentence,
        VideoJob,
        DailyUsage,
        AgnesApiKey,
      ],
      synchronize: process.env.DATABASE_SYNCHRONIZE !== 'false',
    }),
    ImporterModule,
    VideoModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

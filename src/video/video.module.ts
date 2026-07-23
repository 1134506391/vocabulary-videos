import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgnesApiKey, DailyUsage, VideoJob } from '../database/entities';
import { AgnesClient } from './agnes.client';
import { AgnesKeyService } from './agnes-key.service';
import { ChapterAssemblyService } from './chapter-assembly.service';
import { VideoController } from './video.controller';
import { VideoOperationsService } from './video-operations.service';
import { VideoWorkerService } from './video-worker.service';

@Module({
  imports: [TypeOrmModule.forFeature([VideoJob, DailyUsage, AgnesApiKey])],
  controllers: [VideoController],
  providers: [
    AgnesClient,
    AgnesKeyService,
    ChapterAssemblyService,
    VideoOperationsService,
    VideoWorkerService,
  ],
  exports: [
    AgnesClient,
    AgnesKeyService,
    ChapterAssemblyService,
    VideoWorkerService,
  ],
})
export class VideoModule {}

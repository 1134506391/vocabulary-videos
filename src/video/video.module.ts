import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DailyUsage, VideoJob } from '../database/entities';
import { AgnesClient } from './agnes.client';
import { ChapterAssemblyService } from './chapter-assembly.service';
import { VideoController } from './video.controller';
import { VideoOperationsService } from './video-operations.service';
import { VideoWorkerService } from './video-worker.service';

@Module({
  imports: [TypeOrmModule.forFeature([VideoJob, DailyUsage])],
  controllers: [VideoController],
  providers: [
    AgnesClient,
    ChapterAssemblyService,
    VideoOperationsService,
    VideoWorkerService,
  ],
  exports: [AgnesClient, ChapterAssemblyService, VideoWorkerService],
})
export class VideoModule {}

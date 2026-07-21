import { Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ChapterAssemblyService } from './chapter-assembly.service';
import { VideoOperationsService } from './video-operations.service';
import { VideoWorkerService } from './video-worker.service';

@Controller('videos')
export class VideoController {
  constructor(
    private readonly worker: VideoWorkerService,
    private readonly operations: VideoOperationsService,
    private readonly assembly: ChapterAssemblyService,
  ) {}

  @Get('status')
  status() {
    return this.operations.status();
  }

  @Get('failures')
  failures() {
    return this.operations.failures();
  }

  @Post('start')
  start() {
    return this.worker.start();
  }

  @Post('pause')
  pause() {
    return this.worker.pause();
  }

  @Post('jobs/:id/retry')
  retry(@Param('id', ParseIntPipe) id: number) {
    return this.operations.retry(id);
  }

  @Post('retry-failed')
  retryFailed() {
    return this.operations.retryAll();
  }

  @Post('chapters/:chapterNumber/manifest')
  manifest(@Param('chapterNumber', ParseIntPipe) chapterNumber: number) {
    return this.assembly.writeManifest(chapterNumber);
  }

  @Post('chapters/:chapterNumber/assemble')
  assemble(@Param('chapterNumber', ParseIntPipe) chapterNumber: number) {
    return this.assembly.assemble(chapterNumber);
  }
}

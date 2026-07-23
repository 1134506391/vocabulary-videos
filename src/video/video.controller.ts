import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { AgnesKeyService } from './agnes-key.service';
import { ChapterAssemblyService } from './chapter-assembly.service';
import { VideoOperationsService } from './video-operations.service';
import { VideoWorkerService } from './video-worker.service';

class AddAgnesKeyDto {
  @IsString()
  apiKey: string;

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  priority?: number;
}

class SetKeyEnabledDto {
  @IsBoolean()
  enabled: boolean;
}

@Controller('videos')
export class VideoController {
  constructor(
    private readonly worker: VideoWorkerService,
    private readonly operations: VideoOperationsService,
    private readonly assembly: ChapterAssemblyService,
    private readonly keys: AgnesKeyService,
  ) {}

  @Get('status')
  status() {
    return this.operations.status();
  }

  @Get('failures')
  failures() {
    return this.operations.failures();
  }

  @Get('keys')
  listKeys() {
    return this.keys.list();
  }

  @Post('keys')
  addKey(@Body() dto: AddAgnesKeyDto) {
    return this.keys.add(dto.apiKey, dto.label, dto.priority);
  }

  @Post('keys/:id/enabled')
  setEnabled(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetKeyEnabledDto,
  ) {
    return this.keys.setEnabled(id, dto.enabled);
  }

  @Post('keys/:id/reset')
  resetKey(@Param('id', ParseIntPipe) id: number) {
    return this.keys.resetExhaustion(id);
  }

  @Post('keys/reset-exhausted')
  resetAllExhausted() {
    return this.keys.resetAllExhaustionForToday();
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

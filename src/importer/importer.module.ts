import { Module } from '@nestjs/common';
import { ImporterController } from './importer.controller';
import { ImporterService } from './importer.service';
import { SourceParserService } from './source-parser.service';

@Module({
  controllers: [ImporterController],
  providers: [ImporterService, SourceParserService],
  exports: [ImporterService, SourceParserService],
})
export class ImporterModule {}

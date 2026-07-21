import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsBoolean, IsOptional } from 'class-validator';
import { ImporterService } from './importer.service';

class ConfirmImportDto {
  @IsOptional()
  @IsBoolean()
  forceAmbiguous?: boolean;
}

@Controller('import')
export class ImporterController {
  constructor(private readonly importer: ImporterService) {}

  @Get('preview')
  preview() {
    return this.importer.preview();
  }

  @Post('confirm')
  confirm(@Body() dto: ConfirmImportDto) {
    return this.importer.confirm(dto.forceAmbiguous ?? false);
  }
}

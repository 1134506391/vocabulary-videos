import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Repository } from 'typeorm';
import { VideoJob, VideoJobStatus } from '../database/entities';

interface ManifestEntry {
  jobId: number;
  word: string;
  sentence: string;
  sourceOrder: {
    word: number;
    sentence: number;
  };
  file: string;
}

@Injectable()
export class ChapterAssemblyService {
  constructor(
    @InjectRepository(VideoJob)
    private readonly jobs: Repository<VideoJob>,
  ) {}

  async writeManifest(chapterNumber: number): Promise<{
    jsonPath: string;
    concatPath: string;
    clipCount: number;
  }> {
    const jobs = await this.chapterJobs(chapterNumber);
    const downloaded = jobs.filter(
      (job) => job.status === VideoJobStatus.DOWNLOADED && job.localPath,
    );
    const chapterFolder = join(
      this.videoRoot,
      `chapter-${this.pad(chapterNumber, 2)}`,
    );
    await mkdir(chapterFolder, { recursive: true });

    const entries: ManifestEntry[] = downloaded.map((job) => ({
      jobId: job.id,
      word: job.sentence.word.text,
      sentence: job.sentence.text,
      sourceOrder: {
        word: job.sentence.word.sourceOrder,
        sentence: job.sentence.sourceOrder,
      },
      file: job.localPath!,
    }));
    const jsonPath = join(chapterFolder, 'manifest.json');
    const concatPath = join(chapterFolder, 'concat.txt');
    await Promise.all([
      writeFile(jsonPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8'),
      writeFile(
        concatPath,
        `${downloaded
          .map((job) => `file '${this.ffmpegPath(job.localPath!)}'`)
          .join('\n')}\n`,
        'utf8',
      ),
    ]);
    return { jsonPath, concatPath, clipCount: downloaded.length };
  }

  async assemble(chapterNumber: number): Promise<{
    outputPath: string;
    clipCount: number;
  }> {
    const jobs = await this.chapterJobs(chapterNumber);
    if (jobs.length === 0) {
      throw new BadRequestException(
        `Chapter ${chapterNumber} has no video jobs.`,
      );
    }
    const incomplete = jobs.filter(
      (job) => job.status !== VideoJobStatus.DOWNLOADED || !job.localPath,
    );
    if (incomplete.length > 0) {
      throw new BadRequestException(
        `Chapter ${chapterNumber} is not complete: ${incomplete.length} clips are missing.`,
      );
    }

    const manifest = await this.writeManifest(chapterNumber);
    const outputPath = join(
      this.videoRoot,
      'chapters',
      `chapter-${this.pad(chapterNumber, 2)}.mp4`,
    );
    await mkdir(dirname(outputPath), { recursive: true });
    await this.runFfmpeg([
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      manifest.concatPath,
      '-c',
      'copy',
      outputPath,
    ]);
    return {
      outputPath: this.relativeOutputPath(outputPath),
      clipCount: manifest.clipCount,
    };
  }

  private chapterJobs(chapterNumber: number): Promise<VideoJob[]> {
    return this.jobs
      .createQueryBuilder('job')
      .innerJoinAndSelect('job.sentence', 'sentence')
      .innerJoinAndSelect('sentence.word', 'word')
      .innerJoinAndSelect('word.chapter', 'chapter')
      .where('chapter.number = :chapterNumber', { chapterNumber })
      .orderBy('word.sourceOrder', 'ASC')
      .addOrderBy('sentence.sourceOrder', 'ASC')
      .getMany();
  }

  private runFfmpeg(args: string[]): Promise<void> {
    const executable = process.env.FFMPEG_PATH ?? 'ffmpeg';
    return new Promise((resolvePromise, reject) => {
      const child = spawn(executable, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-8000);
      });
      child.on('error', (error) => {
        reject(
          new Error(`Unable to start FFmpeg (${executable}): ${error.message}`),
        );
      });
      child.on('close', (code) => {
        if (code === 0) {
          resolvePromise();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
        }
      });
    });
  }

  private ffmpegPath(localPath: string): string {
    return resolve(process.cwd(), localPath)
      .replace(/\\/g, '/')
      .replace(/'/g, "'\\''");
  }

  private relativeOutputPath(path: string): string {
    const rootName = basename(this.videoRoot);
    const marker = `/${rootName}/`;
    const normalized = path.replace(/\\/g, '/');
    const index = normalized.lastIndexOf(marker);
    return index >= 0
      ? `${rootName}/${normalized.slice(index + marker.length)}`
      : normalized;
  }

  private pad(value: number, width: number): string {
    return String(value).padStart(width, '0');
  }

  private get videoRoot(): string {
    return process.env.VIDEO_OUTPUT_ROOT ?? join(process.cwd(), 'videos');
  }
}

import { LoggerService } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

export function createWinstonLogger(): LoggerService {
  const logDirectory = process.env.LOG_DIRECTORY ?? join(process.cwd(), 'logs');
  mkdirSync(logDirectory, { recursive: true });

  const consoleFormat = winston.format.printf(
    ({ timestamp, level, message, context, ...meta }) => {
      const metadata = Object.keys(meta).length
        ? ` ${JSON.stringify(meta)}`
        : '';
      const source =
        typeof context === 'string' && context.length > 0
          ? ` [${context}]`
          : '';
      const renderedMessage =
        typeof message === 'string' ? message : JSON.stringify(message);
      const renderedTimestamp =
        typeof timestamp === 'string' ? timestamp : new Date().toISOString();
      return `${renderedTimestamp} ${level.toUpperCase()}${source} ${renderedMessage}${metadata}`;
    },
  );

  return new WinstonLoggerService(
    winston.createLogger({
      level: process.env.LOG_LEVEL ?? 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
      ),
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            consoleFormat,
          ),
        }),
        new DailyRotateFile({
          dirname: logDirectory,
          filename: 'application-%DATE%.log',
          datePattern: 'YYYY-MM-DD',
          maxFiles: process.env.LOG_RETENTION ?? '14d',
          zippedArchive: true,
          format: winston.format.combine(
            winston.format.json(),
            winston.format.timestamp(),
          ),
        }),
        new DailyRotateFile({
          dirname: logDirectory,
          filename: 'error-%DATE%.log',
          datePattern: 'YYYY-MM-DD',
          level: 'error',
          maxFiles: process.env.LOG_RETENTION ?? '14d',
          zippedArchive: true,
          format: winston.format.combine(
            winston.format.json(),
            winston.format.timestamp(),
          ),
        }),
      ],
    }),
  );
}

class WinstonLoggerService implements LoggerService {
  constructor(private readonly logger: winston.Logger) {}

  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.write('error', message, context, stack ? { stack } : undefined);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('verbose', message, context);
  }

  fatal(message: unknown, context?: string): void {
    this.write('error', message, context);
  }

  private write(
    level: string,
    message: unknown,
    context?: string,
    extra?: Record<string, unknown>,
  ): void {
    this.logger.log({
      level,
      message: message instanceof Error ? message.message : String(message),
      context,
      ...extra,
    });
  }
}

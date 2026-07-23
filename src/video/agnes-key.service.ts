import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgnesApiKey } from '../database/entities';

export interface MaskedAgnesApiKey {
  id: number;
  label: string;
  maskedKey: string;
  enabled: boolean;
  priority: number;
  exhaustedOnDate: string | null;
  availableToday: boolean;
  successCount: number;
  quotaHitCount: number;
  lastUsedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class AgnesKeyService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgnesKeyService.name);

  constructor(
    @InjectRepository(AgnesApiKey)
    private readonly keys: Repository<AgnesApiKey>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.seedFromEnv();
  }

  async isConfigured(): Promise<boolean> {
    const count = await this.keys.count({ where: { enabled: true } });
    return count > 0;
  }

  async list(): Promise<MaskedAgnesApiKey[]> {
    const today = this.localDate();
    const rows = await this.keys.find({
      order: { priority: 'ASC', id: 'ASC' },
    });
    return rows.map((row) => this.mask(row, today));
  }

  async add(
    apiKey: string,
    label?: string,
    priority?: number,
  ): Promise<MaskedAgnesApiKey> {
    const normalized = this.normalizeKey(apiKey);
    if (!normalized) {
      throw new BadRequestException('API key is empty.');
    }
    const existing = await this.keys.findOneBy({ apiKey: normalized });
    if (existing) {
      existing.enabled = true;
      if (label?.trim()) existing.label = label.trim();
      if (priority !== undefined) existing.priority = priority;
      const saved = await this.keys.save(existing);
      return this.mask(saved, this.localDate());
    }
    const created = await this.keys.save(
      this.keys.create({
        apiKey: normalized,
        label: label?.trim() || this.defaultLabel(normalized),
        priority: priority ?? 100,
        enabled: true,
      }),
    );
    this.logger.log(`Added Agnes API key #${created.id} (${created.label}).`);
    return this.mask(created, this.localDate());
  }

  async setEnabled(id: number, enabled: boolean): Promise<MaskedAgnesApiKey> {
    const key = await this.keys.findOneBy({ id });
    if (!key) {
      throw new NotFoundException(`Agnes API key #${id} was not found.`);
    }
    key.enabled = enabled;
    const saved = await this.keys.save(key);
    return this.mask(saved, this.localDate());
  }

  async resetExhaustion(id: number): Promise<MaskedAgnesApiKey> {
    const key = await this.keys.findOneBy({ id });
    if (!key) {
      throw new NotFoundException(`Agnes API key #${id} was not found.`);
    }
    key.exhaustedOnDate = null;
    key.lastError = null;
    const saved = await this.keys.save(key);
    this.logger.log(`Cleared daily exhaustion for Agnes API key #${id}.`);
    return this.mask(saved, this.localDate());
  }

  async resetAllExhaustionForToday(): Promise<{ reset: number }> {
    const today = this.localDate();
    const exhausted = await this.keys.findBy({ exhaustedOnDate: today });
    for (const key of exhausted) {
      key.exhaustedOnDate = null;
      key.lastError = null;
    }
    await this.keys.save(exhausted);
    return { reset: exhausted.length };
  }

  /**
   * Keys that are enabled and not marked exhausted for the local calendar day.
   */
  async listAvailableForCreate(): Promise<AgnesApiKey[]> {
    const today = this.localDate();
    const keys = await this.keys.find({
      where: { enabled: true },
      order: { priority: 'ASC', id: 'ASC' },
    });
    return keys.filter((key) => key.exhaustedOnDate !== today);
  }

  async findById(id: number): Promise<AgnesApiKey | null> {
    return this.keys.findOneBy({ id });
  }

  async markSuccess(id: number): Promise<void> {
    await this.keys
      .createQueryBuilder()
      .update(AgnesApiKey)
      .set({
        lastUsedAt: () => 'CURRENT_TIMESTAMP',
        successCount: () => '"successCount" + 1',
        lastError: () => 'NULL',
      })
      .where('id = :id', { id })
      .execute();
  }

  async markQuotaExhausted(id: number, errorMessage: string): Promise<void> {
    const today = this.localDate();
    const key = await this.keys.findOneBy({ id });
    if (!key) return;
    key.exhaustedOnDate = today;
    key.lastError = errorMessage.slice(0, 2000);
    key.quotaHitCount += 1;
    key.lastUsedAt = new Date();
    await this.keys.save(key);
    this.logger.warn(
      `Agnes API key #${id} (${key.label}) hit quota 429 for ${today}; switching keys.`,
    );
  }

  async availableKeySummary(): Promise<{
    totalEnabled: number;
    availableToday: number;
    exhaustedToday: number;
  }> {
    const today = this.localDate();
    const enabled = await this.keys.find({ where: { enabled: true } });
    const availableToday = enabled.filter(
      (k) => k.exhaustedOnDate !== today,
    ).length;
    return {
      totalEnabled: enabled.length,
      availableToday,
      exhaustedToday: enabled.length - availableToday,
    };
  }

  localDate(date = new Date()): string {
    const timeZone =
      process.env.AGNES_KEY_TIMEZONE ?? process.env.VIDEO_TIMEZONE ?? 'UTC';
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  private async seedFromEnv(): Promise<void> {
    const fromEnv = this.readKeysFromEnv();
    if (fromEnv.length === 0) {
      const existing = await this.keys.count();
      if (existing === 0) {
        this.logger.warn(
          'No Agnes API keys in DB or env. Add keys via POST /videos/keys or seed AGNES_API_KEY_1..N in .env.',
        );
      }
      return;
    }

    let added = 0;
    for (let i = 0; i < fromEnv.length; i++) {
      const { apiKey, label } = fromEnv[i];
      const existing = await this.keys.findOneBy({ apiKey });
      if (existing) {
        if (!existing.enabled) {
          existing.enabled = true;
          await this.keys.save(existing);
        }
        continue;
      }
      await this.keys.save(
        this.keys.create({
          apiKey,
          label,
          priority: (i + 1) * 10,
          enabled: true,
        }),
      );
      added += 1;
    }
    if (added > 0) {
      this.logger.log(
        `Seeded ${added} Agnes API key(s) from environment into SQLite.`,
      );
    }
  }

  private readKeysFromEnv(): Array<{ apiKey: string; label: string }> {
    const found: Array<{ apiKey: string; label: string }> = [];
    const seen = new Set<string>();

    const push = (raw: string | undefined, label: string) => {
      const apiKey = this.normalizeKey(raw ?? '');
      if (!apiKey || seen.has(apiKey)) return;
      seen.add(apiKey);
      found.push({ apiKey, label });
    };

    if (process.env.AGNES_API_KEYS) {
      process.env.AGNES_API_KEYS.split(/[,\s;]+/g).forEach((part, index) => {
        push(part, `env-keys-${index + 1}`);
      });
    }

    push(process.env.AGNES_API_KEY, 'env-AGNES_API_KEY');

    const numbered: Array<{ index: number; value: string }> = [];
    for (const [name, value] of Object.entries(process.env)) {
      const match = /^AGNES_API_KEY_(\d+)$/i.exec(name);
      if (!match || !value) continue;
      numbered.push({ index: Number(match[1]), value });
    }
    numbered
      .sort((a, b) => a.index - b.index)
      .forEach((item) => push(item.value, `env-AGNES_API_KEY_${item.index}`));

    return found;
  }

  normalizeKey(value: string): string {
    return value
      .trim()
      .replace(/^['"]|['"]$/g, '')
      .trim();
  }

  private defaultLabel(apiKey: string): string {
    if (apiKey.length <= 10) return 'key';
    return `key-...${apiKey.slice(-4)}`;
  }

  private mask(row: AgnesApiKey, today: string): MaskedAgnesApiKey {
    return {
      id: row.id,
      label: row.label,
      maskedKey: this.maskKey(row.apiKey),
      enabled: row.enabled,
      priority: row.priority,
      exhaustedOnDate: row.exhaustedOnDate,
      availableToday: row.enabled && row.exhaustedOnDate !== today,
      successCount: row.successCount,
      quotaHitCount: row.quotaHitCount,
      lastUsedAt: row.lastUsedAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private maskKey(apiKey: string): string {
    if (apiKey.length <= 8) return '****';
    return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
  }
}

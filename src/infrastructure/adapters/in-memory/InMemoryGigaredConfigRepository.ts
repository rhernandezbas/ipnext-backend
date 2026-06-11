import {
  GigaredConfig,
  GigaredConfigRepository,
} from '@domain/ports/GigaredConfigRepository';

/** Defaults returned before any row is persisted (empty apiKey = unconfigured). */
const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://partners.gigaredsa.com.ar/api/v1',
};

/**
 * In-memory single-row Gigared config. Mirrors the Prisma adapter contract:
 * `get()` returns defaults until something is persisted; `update()` merges a partial
 * patch (omitted keys untouched) and stamps `updatedAt`.
 */
export class InMemoryGigaredConfigRepository implements GigaredConfigRepository {
  private apiKey: string = DEFAULTS.apiKey;
  private baseUrl: string = DEFAULTS.baseUrl;
  private updatedAt: string = new Date().toISOString();

  async get(): Promise<GigaredConfig> {
    return { apiKey: this.apiKey, baseUrl: this.baseUrl, updatedAt: this.updatedAt };
  }

  async update(patch: Partial<Pick<GigaredConfig, 'apiKey' | 'baseUrl'>>): Promise<GigaredConfig> {
    if (patch.apiKey !== undefined) this.apiKey = patch.apiKey;
    if (patch.baseUrl !== undefined) this.baseUrl = patch.baseUrl;
    this.updatedAt = new Date().toISOString();
    return { apiKey: this.apiKey, baseUrl: this.baseUrl, updatedAt: this.updatedAt };
  }
}

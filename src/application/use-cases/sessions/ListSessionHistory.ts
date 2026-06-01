/**
 * ListSessionHistory — returns paginated revoked sessions ordered revokedAt DESC.
 *
 * Invariant: NO imports from @infrastructure/*. Only @domain/* and @application/*.
 */
import type { SessionRepository, SessionPage } from '@domain/ports/SessionRepository';
import type { SessionPageDto } from '@application/dto/session.dto';
import { toSessionDto } from '@application/dto/session.dto';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface ListSessionHistoryQuery {
  page?: number;
  pageSize?: number;
}

export class ListSessionHistory {
  constructor(private readonly repo: SessionRepository) {}

  async execute(query: ListSessionHistoryQuery = {}): Promise<SessionPageDto> {
    const page = Math.max(1, query.page ?? DEFAULT_PAGE);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));

    const result: SessionPage = await this.repo.findRevoked(page, pageSize);

    return {
      items: result.items.map(toSessionDto),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }
}

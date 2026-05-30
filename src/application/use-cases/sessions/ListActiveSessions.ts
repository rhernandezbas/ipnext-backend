/**
 * ListActiveSessions — paginated list of active sessions (SDD #5).
 * Owns pagination policy (defaults + clamp); returns DTOs (no tokenHash).
 */
import type { SessionRepository, ListActiveSessionsQuery } from '@domain/ports/SessionRepository';
import { toSessionDto, type SessionPageDto } from '@application/dto/session.dto';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export class ListActiveSessions {
  constructor(private readonly repo: SessionRepository) {}

  async execute(query: ListActiveSessionsQuery = {}): Promise<SessionPageDto> {
    const page = query.page && query.page > 0 ? query.page : DEFAULT_PAGE;
    const requested = query.pageSize && query.pageSize > 0 ? query.pageSize : DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(requested, MAX_PAGE_SIZE);

    const result = await this.repo.listActive({ ...query, page, pageSize });

    return {
      items: result.items.map(toSessionDto),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }
}

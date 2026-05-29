/**
 * ListAuditEvents — paginated, filtered audit log query (SDD #4 Phase 1).
 *
 * Owns the pagination policy (defaults + clamp); the repository just filters,
 * sorts (createdAt DESC) and slices. Returns a DTO page (no entity leak).
 */
import type { AuditEventRepository, AuditEventQuery } from '@domain/ports/AuditEventRepository';
import { toAuditEventDto, type AuditEventPageDto } from '@application/dto/audit.dto';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export class ListAuditEvents {
  constructor(private readonly repo: AuditEventRepository) {}

  async execute(query: AuditEventQuery = {}): Promise<AuditEventPageDto> {
    const page = query.page && query.page > 0 ? query.page : DEFAULT_PAGE;
    const requested = query.pageSize && query.pageSize > 0 ? query.pageSize : DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(requested, MAX_PAGE_SIZE);

    const result = await this.repo.list({ ...query, page, pageSize });

    return {
      items: result.items.map(toAuditEventDto),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }
}

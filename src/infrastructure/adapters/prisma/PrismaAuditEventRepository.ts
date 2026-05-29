/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: Uses `as any` on Prisma client calls because prisma generate has not
 * been run against the AuditEvent model in this environment (no DB available).
 * The Dockerfile runs `prisma generate` in the build, so prod is correct.
 */
import { prisma } from '@infrastructure/database/prisma';
import type { AuditEvent } from '@domain/entities/audit';
import type {
  AuditEventRepository,
  AuditEventQuery,
  AuditEventPage,
  RecordAuditInput,
} from '@domain/ports/AuditEventRepository';

type AuditEventRow = {
  id: string;
  actorId: string | null;
  actorLogin: string;
  method: string;
  path: string;
  action: string | null;
  entityType: string | null;
  entityId: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  statusCode: number;
  errorMessage: string | null;
  ip: string | null;
  createdAt: Date;
};

function mapRow(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    actorId: row.actorId,
    actorLogin: row.actorLogin,
    method: row.method,
    path: row.path,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    beforeJson: row.beforeJson ?? null,
    afterJson: row.afterJson ?? null,
    statusCode: row.statusCode,
    errorMessage: row.errorMessage,
    ip: row.ip,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PrismaAuditEventRepository implements AuditEventRepository {
  constructor(private readonly db = prisma) {}

  async record(input: RecordAuditInput): Promise<AuditEvent> {
    const row = (await (this.db as any).auditEvent.create({
      data: {
        actorId: input.actorId,
        actorLogin: input.actorLogin,
        method: input.method,
        path: input.path,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        // undefined → column stays NULL; an object/array is stored as JSONB.
        beforeJson: input.beforeJson ?? undefined,
        afterJson: input.afterJson ?? undefined,
        statusCode: input.statusCode,
        errorMessage: input.errorMessage,
        ip: input.ip,
      },
    })) as AuditEventRow;
    return mapRow(row);
  }

  async list(query: AuditEventQuery): Promise<AuditEventPage> {
    const where: Record<string, unknown> = {};
    if (query.actorId) where['actorId'] = query.actorId;
    if (query.entityType) where['entityType'] = query.entityType;
    if (query.method) where['method'] = query.method;
    if (query.from || query.to) {
      where['createdAt'] = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;

    const [rows, total] = await Promise.all([
      (this.db as any).auditEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }) as Promise<AuditEventRow[]>,
      (this.db as any).auditEvent.count({ where }) as Promise<number>,
    ]);

    return { items: rows.map(mapRow), total, page, pageSize };
  }
}

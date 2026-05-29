import { z } from 'zod';
import type { AuditEvent } from '@domain/entities/audit';

// ---------------------------------------------------------------------------
// Output DTOs — never leak a Prisma entity; mapper enumerates fields.
// ---------------------------------------------------------------------------

export interface AuditEventDto {
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
  createdAt: string;
}

export interface AuditEventPageDto {
  items: AuditEventDto[];
  total: number;
  page: number;
  pageSize: number;
}

export function toAuditEventDto(e: AuditEvent): AuditEventDto {
  return {
    id: e.id,
    actorId: e.actorId,
    actorLogin: e.actorLogin,
    method: e.method,
    path: e.path,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    beforeJson: e.beforeJson,
    afterJson: e.afterJson,
    statusCode: e.statusCode,
    errorMessage: e.errorMessage,
    ip: e.ip,
    createdAt: e.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Query validation (REQ-AUD-QUERY-1) — used by the route in Phase 3.
// Malformed `from`/`to` → Zod error the route maps to 400 VALIDATION_ERROR.
// ---------------------------------------------------------------------------

const isoDate = z
  .string()
  .refine(v => !Number.isNaN(Date.parse(v)), { message: 'invalid date' });

export const AuditEventQuerySchema = z.object({
  actorId: z.string().min(1).optional(),
  entityType: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});

export type AuditEventQueryInput = z.infer<typeof AuditEventQuerySchema>;

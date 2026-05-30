/**
 * createRequestAuditService — request-scoped AuditService (SDD #4 Phase 3).
 *
 * Built in a route handler (which has req/res). Use cases receive it as the
 * AuditService port and call emit() with the true before/after state. emit
 * records a richer event AND marks res.locals.__auditEmitted so the generic
 * mutation middleware skips this request (dedupe → one event per mutation).
 */
import type { Request, Response } from 'express';
import type { AuditEventRepository } from '@domain/ports/AuditEventRepository';
import type { AuditService } from '@domain/ports/AuditService';
import { maskSensitive } from '../middleware/auditMutationsMiddleware';

export function createRequestAuditService(
  repo: AuditEventRepository,
  req: Request,
  res: Response,
): AuditService {
  return {
    async emit(input): Promise<void> {
      // Mark first so the generic middleware dedupes even if record() is slow.
      res.locals['__auditEmitted'] = true;
      const actor = (req as Request & { user?: { id?: string; username?: string } }).user;
      const url = req.originalUrl || req.url || '';
      try {
        await repo.record({
          actorId: actor?.id ?? null,
          actorLogin: actor?.username ?? 'anonymous',
          method: req.method,
          path: url,
          action: input.action,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          beforeJson: maskSensitive(input.before ?? null),
          afterJson: maskSensitive(input.after ?? null),
          statusCode: res.statusCode,
          errorMessage: null,
          ip: req.ip ?? null,
        });
      } catch (err) {
        // Auditing must never break the request path.
        console.error('[audit] emit failed', err);
      }
    },
  };
}

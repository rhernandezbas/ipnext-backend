/**
 * portalAccountDeletionAudit — customer-portal-api (fix wave M5).
 *
 * portal-account-deletion spec "Auditoría del borrado": el use case
 * `DeleteMyPortalAccount` emite el evento por su seam `auditLogger`; el default
 * era un console.log estructurado — rastro que muere con la rotación de logs
 * del container. Este recorder lo persiste como `AuditEvent` (durable en
 * Postgres, consultable por GET /api/admin/audit-events) ADEMÁS del log.
 *
 * Fire-and-forget: la auditoría jamás rompe (ni demora) el borrado — mismo
 * criterio que auditMutationsMiddleware.
 */
import type { AuditEventRepository } from '@domain/ports/AuditEventRepository';
import type { PortalAccountDeletionAuditEvent } from '@application/use-cases/portal/DeleteMyPortalAccount';

export function createPortalAccountDeletionAuditRecorder(
  repo: AuditEventRepository,
): (event: PortalAccountDeletionAuditEvent) => void {
  return function recordPortalAccountDeletion(event: PortalAccountDeletionAuditEvent): void {
    // El log estructurado se mantiene (visibilidad inmediata en docker logs).
    console.log('[portal] account deleted', event);
    void repo
      .record({
        actorId: null, // el actor es el propio cliente del portal, no un RbacUser
        actorLogin: `portal:${event.clientId}`,
        method: 'DELETE',
        path: '/api/portal/account',
        action: 'portal.account.deleted',
        entityType: 'PortalAccount',
        entityId: event.portalAccountId,
        beforeJson: null,
        // Spec: accountId + clientId + timestamp — deliberadamente SIN password ni tokens.
        afterJson: { clientId: event.clientId, deletedAt: event.deletedAt },
        statusCode: 204,
        errorMessage: null,
        ip: null,
      })
      .catch((err: unknown) => {
        console.error('[portal] failed to persist account-deletion audit event', err);
      });
  };
}

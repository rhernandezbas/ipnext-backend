/**
 * M5 (fix wave) — la "Auditoría del borrado" del spec portal-account-deletion
 * era un console.log: se perdía en la rotación de logs del container. El repo SÍ
 * tiene un registro durable usable sin scope-creep: `AuditEventRepository`
 * (tabla AuditEvent, expuesta en GET /api/admin/audit-events). Este recorder
 * persiste el evento RICO ahí (además del log estructurado que emite el propio
 * use case por su seam).
 */
import { createPortalAccountDeletionAuditRecorder } from '@infrastructure/audit/portalAccountDeletionAudit';
import { InMemoryAuditEventRepository } from '@infrastructure/adapters/in-memory/InMemoryAuditEventRepository';
import { DeleteMyPortalAccount } from '@application/use-cases/portal/DeleteMyPortalAccount';
import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createPortalAccountDeletionAuditRecorder (M5)', () => {
  it('persiste un AuditEvent rico y consultable (action/entityType/entityId) — no solo un console.log', async () => {
    const repo = new InMemoryAuditEventRepository();
    const recorder = createPortalAccountDeletionAuditRecorder(repo);

    recorder({ portalAccountId: 'acc-1', clientId: 'client-9', deletedAt: '2026-07-30T12:00:00.000Z' });
    await flush();

    const page = await repo.list({ page: 1, pageSize: 10 });
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      action: 'portal.account.deleted',
      entityType: 'PortalAccount',
      entityId: 'acc-1',
      method: 'DELETE',
      path: '/api/portal/account',
      statusCode: 204,
      actorLogin: 'portal:client-9',
    });
    expect(page.items[0].afterJson).toMatchObject({ clientId: 'client-9', deletedAt: '2026-07-30T12:00:00.000Z' });
  });

  it('un fallo del repo de auditoría JAMÁS rompe el flujo del borrado (fire-and-forget)', async () => {
    const failing = {
      record: jest.fn().mockRejectedValue(new Error('db down')),
      list: jest.fn(),
    };
    const recorder = createPortalAccountDeletionAuditRecorder(failing);

    expect(() => recorder({ portalAccountId: 'acc-1', clientId: 'c', deletedAt: 'x' })).not.toThrow();
    await flush();
    expect(failing.record).toHaveBeenCalledTimes(1);
  });

  it('integración: DeleteMyPortalAccount con el recorder inyectado deja la fila durable', async () => {
    const accounts = new InMemoryPortalAccountRepository();
    const sessions = new InMemoryPortalSessionRepository();
    const hasher = new InMemoryPasswordHasher();
    const auditRepo = new InMemoryAuditEventRepository();
    const useCase = new DeleteMyPortalAccount(
      accounts,
      sessions,
      hasher,
      createPortalAccountDeletionAuditRecorder(auditRepo),
    );
    const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });

    await useCase.execute({ accountId: account.id, password: 'Secret123' });
    await flush();

    const page = await auditRepo.list({ page: 1, pageSize: 10 });
    expect(page.total).toBe(1);
    expect(page.items[0].entityId).toBe(account.id);
    // Jamás password ni tokens en la fila (spec: accountId, clientId, timestamp).
    expect(JSON.stringify(page.items[0])).not.toContain('Secret123');
  });
});

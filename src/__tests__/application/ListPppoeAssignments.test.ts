/**
 * ListPppoeAssignments.test.ts — Bug 3: tab Asignaciones usa datos de PppoeService.
 *
 * TDD (rojo → verde → refactor):
 *   - findAssigned() retorna solo filas con contractId!=null AND remoteAddress!=null AND status='enabled'.
 *   - ListPppoeAssignments mapea a PppoeAssignmentDto (shape exacto del contrato FE).
 */
import { ListPppoeAssignments } from '@application/use-cases/ListPppoeAssignments';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';

// NAS id para fixture
const NAS_ID = 'nas-1';

describe('InMemoryPppoeServiceRepository.findAssigned()', () => {
  it('retorna solo filas con contractId!=null AND remoteAddress!=null AND status=enabled', async () => {
    const repo = new InMemoryPppoeServiceRepository();

    // Debe aparecer: contractId set, remoteAddress set, status enabled
    const assigned = await repo.upsertByUsername({
      username: 'user1', password: 'p', nasId: NAS_ID,
      contractId: 'C1', remoteAddress: '10.0.0.1', status: 'enabled',
    });

    // No debe aparecer: orphan (contractId null)
    await repo.upsertByUsername({
      username: 'orphan', password: 'p', nasId: NAS_ID,
      contractId: null, remoteAddress: '10.0.0.2', status: 'enabled',
    });

    // No debe aparecer: sin IP (remoteAddress null)
    await repo.upsertByUsername({
      username: 'no-ip', password: 'p', nasId: NAS_ID,
      contractId: 'C2', remoteAddress: null, status: 'enabled',
    });

    // No debe aparecer: disabled
    await repo.upsertByUsername({
      username: 'disabled', password: 'p', nasId: NAS_ID,
      contractId: 'C3', remoteAddress: '10.0.0.3', status: 'disabled',
    });

    const result = await repo.findAssigned();

    expect(result).toHaveLength(1);
    expect(result[0].username).toBe('user1');
    expect(result[0].id).toBe(assigned.id);
  });

  it('sin datos → lista vacía', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    expect(await repo.findAssigned()).toHaveLength(0);
  });

  it('múltiples asignados → devuelve todos', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    await repo.upsertByUsername({ username: 'u1', password: 'p', nasId: NAS_ID, contractId: 'C1', remoteAddress: '10.0.0.1', status: 'enabled' });
    await repo.upsertByUsername({ username: 'u2', password: 'p', nasId: NAS_ID, contractId: 'C2', remoteAddress: '10.0.0.2', status: 'enabled' });
    expect(await repo.findAssigned()).toHaveLength(2);
  });
});

describe('ListPppoeAssignments — DTO shape (Bug 3)', () => {
  it('mapea a PppoeAssignmentDto con shape exacto del contrato FE', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const s = await repo.upsertByUsername({
      username: 'juanperez',
      password: 'secret',
      nasId: NAS_ID,
      contractId: 'contract-42',
      remoteAddress: '100.64.10.10',
      status: 'enabled',
      profile: 'IP-Air-30-10',
    });

    const uc = new ListPppoeAssignments(repo);
    const result = await uc.execute();

    expect(result).toHaveLength(1);
    const dto = result[0];

    // Contrato FE: { id, ip, username, contractId, profile, nasId, status, createdAt }
    expect(dto.id).toBe(s.id);
    expect(dto.ip).toBe('100.64.10.10');      // ip = remoteAddress
    expect(dto.username).toBe('juanperez');
    expect(dto.contractId).toBe('contract-42');
    expect(dto.profile).toBe('IP-Air-30-10');
    expect(dto.nasId).toBe(NAS_ID);
    expect(dto.status).toBe('enabled');
    expect(typeof dto.createdAt).toBe('string');

    // Garantizar que password NO viaja en el DTO
    expect((dto as any).password).toBeUndefined();
  });

  it('profile null se preserva como null en el DTO', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    await repo.upsertByUsername({
      username: 'u1', password: 'p', nasId: NAS_ID,
      contractId: 'C1', remoteAddress: '10.0.0.1', status: 'enabled', profile: null,
    });

    const uc = new ListPppoeAssignments(repo);
    const result = await uc.execute();

    expect(result[0].profile).toBeNull();
  });

  it('excluye huérfanos y sin-IP del resultado del use case', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    // Asignado correcto
    await repo.upsertByUsername({ username: 'good', password: 'p', nasId: NAS_ID, contractId: 'C1', remoteAddress: '10.0.0.1', status: 'enabled' });
    // Huérfano
    await repo.upsertByUsername({ username: 'orphan', password: 'p', nasId: NAS_ID, contractId: null, remoteAddress: '10.0.0.2', status: 'enabled' });
    // Sin IP
    await repo.upsertByUsername({ username: 'no-ip', password: 'p', nasId: NAS_ID, contractId: 'C2', remoteAddress: null, status: 'enabled' });

    const uc = new ListPppoeAssignments(repo);
    const result = await uc.execute();

    expect(result).toHaveLength(1);
    expect(result[0].username).toBe('good');
  });
});

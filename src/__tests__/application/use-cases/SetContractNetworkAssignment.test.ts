/**
 * SetContractNetworkAssignment — picker manual BE (PICK-1, design §9.1).
 * Todo en memoria — jamás mockear Prisma.
 */
import { SetContractNetworkAssignment } from '@application/use-cases/SetContractNetworkAssignment';
import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';
import { InMemoryNetworkSiteRepository } from '@infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { InMemoryAccessPointRepository } from '@infrastructure/adapters/in-memory/InMemoryAccessPointRepository';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import {
  NetworkSiteNotFoundError,
  AccessPointNotFoundError,
  AccessPointRetiredError,
  AccessPointNotInSiteError,
} from '@domain/errors/networkAssignment';

function makeHarness() {
  const contractRepo = new InMemoryContractRepository();
  const networkSiteRepo = new InMemoryNetworkSiteRepository();
  const accessPointRepo = new InMemoryAccessPointRepository();
  const uc = new SetContractNetworkAssignment(contractRepo, networkSiteRepo, accessPointRepo);
  return { contractRepo, networkSiteRepo, accessPointRepo, uc };
}

describe('SetContractNetworkAssignment', () => {
  it('contrato inexistente → ContractNotFoundError (404)', async () => {
    const { uc } = makeHarness();

    await expect(uc.execute({ contractId: 'no-such-contract', accessPointId: 'ap-x' }))
      .rejects.toBeInstanceOf(ContractNotFoundError);
  });

  it('networkSiteId inexistente → NetworkSiteNotFoundError (422)', async () => {
    const { contractRepo, uc } = makeHarness();
    const c1 = contractRepo.seed({ clientName: 'Cliente 1', plan: 'Plan A' });

    await expect(uc.execute({ contractId: c1.id, networkSiteId: 'no-such-site' }))
      .rejects.toBeInstanceOf(NetworkSiteNotFoundError);
  });

  it('accessPointId inexistente → AccessPointNotFoundError (422)', async () => {
    const { contractRepo, uc } = makeHarness();
    const c1 = contractRepo.seed({ clientName: 'Cliente 1', plan: 'Plan A' });

    await expect(uc.execute({ contractId: c1.id, accessPointId: 'no-such-ap' }))
      .rejects.toBeInstanceOf(AccessPointNotFoundError);
  });

  it('AP retirado (missingSince != null) → AccessPointRetiredError (422)', async () => {
    const { contractRepo, accessPointRepo, uc } = makeHarness();
    const c1 = contractRepo.seed({ clientName: 'Cliente 1', plan: 'Plan A' });
    const ap9 = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'dev-9', networkSiteId: '1', name: 'AP retirado', mac: null });
    await accessPointRepo.markMissing(['dev-9'], new Date('2026-01-01T00:00:00Z'));

    await expect(uc.execute({ contractId: c1.id, accessPointId: ap9.id }))
      .rejects.toBeInstanceOf(AccessPointRetiredError);
  });

  it('AP de otro nodo (site + AP incoherentes) → AccessPointNotInSiteError (422), no cambia nada', async () => {
    const { contractRepo, accessPointRepo, uc } = makeHarness();
    const c1 = contractRepo.seed({ clientName: 'Cliente 1', plan: 'Plan A' });
    const ap1 = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'dev-1', networkSiteId: '1', name: 'AP1', mac: null });

    await expect(uc.execute({ contractId: c1.id, networkSiteId: '2', accessPointId: ap1.id }))
      .rejects.toBeInstanceOf(AccessPointNotInSiteError);

    const [after] = await contractRepo.getNetworkAssignments([c1.id]);
    expect(after).toEqual({ id: c1.id, networkSiteId: null, accessPointId: null });
  });

  it('asignar AP (sin networkSiteId) autocompleta el nodo desde el AP', async () => {
    const { contractRepo, accessPointRepo, uc } = makeHarness();
    const c1 = contractRepo.seed({ clientName: 'Cliente 1', plan: 'Plan A' });
    const ap1 = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'dev-1', networkSiteId: '1', name: 'AP1', mac: null });

    const result = await uc.execute({ contractId: c1.id, accessPointId: ap1.id });

    expect(result).toEqual({ id: c1.id, networkSiteId: '1', accessPointId: ap1.id });
  });

  it('mover el site limpia un AP incompatible (el AP actual no pertenece al site nuevo)', async () => {
    const { contractRepo, accessPointRepo, uc } = makeHarness();
    const ap1 = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'dev-1', networkSiteId: '1', name: 'AP1', mac: null });
    const c1 = contractRepo.seed({ clientName: 'Cliente 1', plan: 'Plan A', networkSiteId: '1', accessPointId: ap1.id });

    const result = await uc.execute({ contractId: c1.id, networkSiteId: '2' });

    expect(result).toEqual({ id: c1.id, networkSiteId: '2', accessPointId: null });
  });

  it('mover el site a uno que YA contiene el AP actual — lo conserva', async () => {
    const { contractRepo, accessPointRepo, uc } = makeHarness();
    const ap1 = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'dev-1', networkSiteId: '1', name: 'AP1', mac: null });
    const c1 = contractRepo.seed({ clientName: 'Cliente 1', plan: 'Plan A', networkSiteId: '1', accessPointId: ap1.id });

    const result = await uc.execute({ contractId: c1.id, networkSiteId: '1' });

    expect(result).toEqual({ id: c1.id, networkSiteId: '1', accessPointId: ap1.id });
  });

  it('networkSiteId: null explícito limpia AMBOS campos', async () => {
    const { contractRepo, accessPointRepo, uc } = makeHarness();
    const ap1 = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'dev-1', networkSiteId: '1', name: 'AP1', mac: null });
    const c1 = contractRepo.seed({ clientName: 'Cliente 1', plan: 'Plan A', networkSiteId: '1', accessPointId: ap1.id });

    const result = await uc.execute({ contractId: c1.id, networkSiteId: null });

    expect(result).toEqual({ id: c1.id, networkSiteId: null, accessPointId: null });
  });

  it('accessPointId: null explícito limpia SOLO el AP — el site queda', async () => {
    const { contractRepo, accessPointRepo, uc } = makeHarness();
    const ap1 = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'dev-1', networkSiteId: '1', name: 'AP1', mac: null });
    const c1 = contractRepo.seed({ clientName: 'Cliente 1', plan: 'Plan A', networkSiteId: '1', accessPointId: ap1.id });

    const result = await uc.execute({ contractId: c1.id, accessPointId: null });

    expect(result).toEqual({ id: c1.id, networkSiteId: '1', accessPointId: null });
  });

  it('devuelve un DTO — nunca la entidad Prisma cruda', async () => {
    const { contractRepo, accessPointRepo, uc } = makeHarness();
    const c1 = contractRepo.seed({ clientName: 'Cliente 1', plan: 'Plan A' });
    const ap1 = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'dev-1', networkSiteId: '1', name: 'AP1', mac: null });

    const result = await uc.execute({ contractId: c1.id, accessPointId: ap1.id });

    expect(Object.keys(result).sort()).toEqual(['accessPointId', 'id', 'networkSiteId']);
  });
});

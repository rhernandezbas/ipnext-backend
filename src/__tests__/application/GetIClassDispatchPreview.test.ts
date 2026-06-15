/**
 * STRICT TDD — scenarios D1-D2 from the design matrix.
 */
import { GetIClassDispatchPreview } from '@application/use-cases/GetIClassDispatchPreview';
import { InMemoryProjectRepository } from '@infrastructure/adapters/in-memory/InMemoryProjectRepository';

describe('GetIClassDispatchPreview', () => {
  it('D1: project with soType → row has soType + expected sources + initialStatus=assigned-by-iclass', async () => {
    const projectRepo = new InMemoryProjectRepository();
    const soType = { id: 'st-1', code: 'FIBRA_INSTALL', description: 'Instalação Fibra', active: true };
    projectRepo.seedIClassSoType(soType);

    const p = await projectRepo.create({ title: 'Fibra Norte', visible: true });
    await projectRepo.updateIClassSoType(p.id, 'st-1');

    const uc = new GetIClassDispatchPreview(projectRepo);
    const { items } = await uc.execute();

    const row = items.find(r => r.projectId === p.id);
    expect(row).toBeDefined();
    expect(row!.projectTitle).toBe('Fibra Norte');
    expect(row!.soType).toEqual({ code: 'FIBRA_INSTALL', description: 'Instalação Fibra' });
    expect(row!.nodeResolution).toBe('by-customer-city');
    expect(row!.customerCodeSource).toBe('contractCode-or-customerCode');
    expect(row!.phoneSource).toBe('customer-phone');
    expect(row!.soCodeSource).toBe('task-sequence-number');
    expect(row!.initialStatus).toBe('assigned-by-iclass');
    expect(row!.hardcoded.networkPhone).toBe('0000000000');
    expect(row!.hardcoded.networkCustomerCode).toBe('NETWORK');
  });

  it('D2: project without soType → row has soType=null', async () => {
    const projectRepo = new InMemoryProjectRepository();
    const p = await projectRepo.create({ title: 'Sin mapeo', visible: true });

    const uc = new GetIClassDispatchPreview(projectRepo);
    const { items } = await uc.execute();

    const row = items.find(r => r.projectId === p.id);
    expect(row).toBeDefined();
    expect(row!.soType).toBeNull();
  });
});

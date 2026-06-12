/**
 * #66 — UpdateTask networkType immutability guard.
 *
 * networkType is an IDENTITY discriminator (red vs fibra), NOT a mutable state.
 * A task created with the wrong type must be recreated, not switched. The PUT
 * route therefore rejects any networkType CHANGE with NetworkTypeImmutableError.
 *
 * The guard fires on CHANGE, not on PRESENCE: the FE edit form resubmits the
 * FULL body on every save (including the unchanged networkType), so echoing the
 * SAME networkType must be a no-op (mirrors the #40 projectId same-id no-op).
 *
 * REQ-IMMUT-1: red task + {networkType:'fibra'} → NetworkTypeImmutableError
 * REQ-IMMUT-2: fibra task + {networkType:'red'} → NetworkTypeImmutableError
 * REQ-IMMUT-3: red task + {networkType:'red'} (echo) + other fields → no error
 * REQ-IMMUT-4: fibra task + {networkType:'fibra'} (echo) → no error
 * REQ-IMMUT-5: update NOT touching networkType → no error
 */
import { UpdateTask } from '../../application/use-cases/UpdateTask';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { NetworkTypeImmutableError } from '../../domain/errors/scheduling';
import { EntityLookup } from '../../domain/ports/EntityLookup';
import { ProjectKindLookup } from '../../domain/ports/ProjectKindLookup';

class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
}

class EmptyProjectLookup implements ProjectKindLookup {
  async findById() { return null; }
}

function buildUseCase() {
  const repo = new InMemorySchedulingRepository();
  const useCase = new UpdateTask(
    repo,
    new AnyLookup(),
    new AnyLookup(),
    new AnyLookup(),
    new AnyLookup(),
    new EmptyProjectLookup(),
    undefined,
  );
  return { repo, useCase };
}

/** Seed a network task of the given networkType and return its id. */
async function seedNetworkTask(
  repo: InMemorySchedulingRepository,
  networkType: 'red' | 'fibra',
): Promise<string> {
  const base = {
    title: `${networkType} task`,
    priority: 'normal',
    estimatedHours: 2,
    category: 'maintenance',
    kind: 'network',
    stageId: '10000000-0000-4000-a000-000000000001',
    description: null,
    address: 'Ruta 7 km 5',
    coordinates: null,
    projectId: null,
    projectName: null,
    completedAt: null,
    notes: null,
    startDate: null,
    endDate: null,
    customerId: null,
    contractId: null,
    partnerId: null,
    reporterId: null,
    assigneeId: null,
    travelTimeTo: null,
    travelTimeFrom: null,
  };
  const data = networkType === 'fibra'
    ? { ...base, networkType: 'fibra', networkSiteId: null, networkSiteName: 'Nodo FO-1', iclassCityCode: 'Mercedes' }
    : { ...base, networkType: 'red', networkSiteId: '1', networkSiteName: null };
  const task = await repo.createTask(data as never);
  return task.id;
}

describe('UpdateTask — networkType immutable (#66)', () => {
  it('REQ-IMMUT-1: red task + {networkType:"fibra"} → NetworkTypeImmutableError', async () => {
    const { repo, useCase } = buildUseCase();
    const id = await seedNetworkTask(repo, 'red');
    await expect(
      useCase.execute(id, { networkType: 'fibra' } as never),
    ).rejects.toBeInstanceOf(NetworkTypeImmutableError);
  });

  it('REQ-IMMUT-2: fibra task + {networkType:"red"} → NetworkTypeImmutableError', async () => {
    const { repo, useCase } = buildUseCase();
    const id = await seedNetworkTask(repo, 'fibra');
    await expect(
      useCase.execute(id, { networkType: 'red' } as never),
    ).rejects.toBeInstanceOf(NetworkTypeImmutableError);
  });

  it('REQ-IMMUT-3: red task + same networkType echo + other fields → no error (no-op)', async () => {
    const { repo, useCase } = buildUseCase();
    const id = await seedNetworkTask(repo, 'red');
    const updated = await useCase.execute(id, { networkType: 'red', title: 'Renamed' } as never);
    expect(updated?.title).toBe('Renamed');
    expect(updated?.networkType).toBe('red');
  });

  it('REQ-IMMUT-4: fibra task + same networkType echo → no error (no-op)', async () => {
    const { repo, useCase } = buildUseCase();
    const id = await seedNetworkTask(repo, 'fibra');
    const updated = await useCase.execute(id, { networkType: 'fibra', title: 'Renamed FO' } as never);
    expect(updated?.title).toBe('Renamed FO');
    expect(updated?.networkType).toBe('fibra');
  });

  it('REQ-IMMUT-5: update NOT touching networkType → no error', async () => {
    const { repo, useCase } = buildUseCase();
    const id = await seedNetworkTask(repo, 'red');
    const updated = await useCase.execute(id, { title: 'Just a rename' } as never);
    expect(updated?.title).toBe('Just a rename');
    expect(updated?.networkType).toBe('red');
  });
});

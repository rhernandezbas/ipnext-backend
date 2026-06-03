import { RecordMaterialConsumption } from '@application/use-cases/RecordMaterialConsumption';
import { InMemoryTaskMaterialConsumptionRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskMaterialConsumptionRepository';
import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';
import { MaterialNotFoundError, InvalidQuantityError } from '@domain/errors/inventory';

async function setup() {
  const consumptionRepo = new InMemoryTaskMaterialConsumptionRepository();
  const materialRepo = new InMemoryMaterialCatalogRepository();
  const useCase = new RecordMaterialConsumption(consumptionRepo, materialRepo);
  const material = await materialRepo.create({ name: 'CABLE_UTP', unit: 'm', active: true, sortOrder: 0 });
  return { consumptionRepo, materialRepo, useCase, material };
}

describe('RecordMaterialConsumption', () => {
  it('creates a consumption record with snapshot materialName', async () => {
    const { useCase, material } = await setup();
    const c = await useCase.execute({
      taskId: 't1',
      materialCatalogId: material.id,
      quantity: 5,
      recordedByUserId: 'u1',
    });
    expect(c.materialName).toBe('CABLE_UTP');
    expect(c.quantity).toBe(5);
    expect(c.taskId).toBe('t1');
    expect(c.materialCatalogId).toBe(material.id);
    expect(c.recordedByUserId).toBe('u1');
  });

  it('uses material.unit as default when unit not provided', async () => {
    const { useCase, material } = await setup();
    const c = await useCase.execute({ taskId: 't1', materialCatalogId: material.id, quantity: 3 });
    expect(c.unit).toBe('m');
  });

  it('uses input.unit when provided (overrides material.unit)', async () => {
    const { useCase, material } = await setup();
    const c = await useCase.execute({ taskId: 't1', materialCatalogId: material.id, quantity: 3, unit: 'rollo' });
    expect(c.unit).toBe('rollo');
  });

  it('null unit when material.unit is null and no input.unit', async () => {
    const consumptionRepo = new InMemoryTaskMaterialConsumptionRepository();
    const materialRepo = new InMemoryMaterialCatalogRepository();
    const mat = await materialRepo.create({ name: 'OTRO', unit: null, active: true, sortOrder: 0 });
    const useCase = new RecordMaterialConsumption(consumptionRepo, materialRepo);
    const c = await useCase.execute({ taskId: 't1', materialCatalogId: mat.id, quantity: 1 });
    expect(c.unit).toBeNull();
  });

  it('throws MaterialNotFoundError when material does not exist', async () => {
    const { useCase } = await setup();
    await expect(useCase.execute({ taskId: 't1', materialCatalogId: 'nonexistent', quantity: 2 }))
      .rejects.toMatchObject({ code: 'MATERIAL_NOT_FOUND' });
  });

  it('throws InvalidQuantityError when quantity <= 0', async () => {
    const { useCase, material } = await setup();
    await expect(useCase.execute({ taskId: 't1', materialCatalogId: material.id, quantity: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_QUANTITY' });
    await expect(useCase.execute({ taskId: 't1', materialCatalogId: material.id, quantity: -1 }))
      .rejects.toMatchObject({ code: 'INVALID_QUANTITY' });
  });
});

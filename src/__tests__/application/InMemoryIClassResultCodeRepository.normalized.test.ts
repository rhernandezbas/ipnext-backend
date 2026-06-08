/**
 * Adapter-layer tests for InMemoryIClassResultCodeRepository — métodos normalizados.
 * Cubre: trailing-period-catalog, soTypeId-disambiguation, no-false-collapse.
 */
import { InMemoryIClassResultCodeRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository';

async function seedMapped(
  repo: InMemoryIClassResultCodeRepository,
  soTypeId: string | null,
  code: string,
  stageId: string,
) {
  await repo.upsert({ soTypeId, code, type: 'Sucesso' });
  const all = await repo.list();
  const entry = all.find(r => r.soTypeId === soTypeId && r.code === code)!;
  await repo.assignStage(entry.id, stageId);
}

describe('InMemoryIClassResultCodeRepository — normalized finders', () => {
  it('trailing-period-catalog: findByCodeNormalized resolves "Cliente Ausente." against stored "Cliente Ausente"', async () => {
    const repo = new InMemoryIClassResultCodeRepository();
    await seedMapped(repo, null, 'Cliente Ausente', 'stage-1');

    const result = await repo.findByCodeNormalized('Cliente Ausente.');

    expect(result).not.toBeNull();
    expect(result!.mappedStageId).toBe('stage-1');
  });

  it('internal-whitespace: findByCodeNormalized resolves "cliente  ausente" against "Cliente Ausente"', async () => {
    const repo = new InMemoryIClassResultCodeRepository();
    await seedMapped(repo, null, 'Cliente Ausente', 'stage-1');

    const result = await repo.findByCodeNormalized('cliente  ausente');

    expect(result).not.toBeNull();
    expect(result!.mappedStageId).toBe('stage-1');
  });

  it('soTypeId-disambiguation: findBySoTypeAndCodeNormalized returns only the soType-1 entry for "Code A."', async () => {
    const repo = new InMemoryIClassResultCodeRepository();
    await seedMapped(repo, 'soType-1', 'Code A', 'stage-X');
    await seedMapped(repo, 'soType-2', 'Code A', 'stage-Y');

    const result = await repo.findBySoTypeAndCodeNormalized('soType-1', 'Code A.');

    expect(result).not.toBeNull();
    expect(result!.mappedStageId).toBe('stage-X');
  });

  it('soTypeId-disambiguation: no cross-type leak under normalization', async () => {
    const repo = new InMemoryIClassResultCodeRepository();
    await seedMapped(repo, 'soType-1', 'Code A', 'stage-X');
    await seedMapped(repo, 'soType-2', 'Code A', 'stage-Y');

    const result = await repo.findBySoTypeAndCodeNormalized('soType-2', 'Code A.');

    expect(result!.mappedStageId).toBe('stage-Y');
  });

  it('no-false-collapse: "Alpha" and "Alpha Beta" under the same soType resolve independently', async () => {
    const repo = new InMemoryIClassResultCodeRepository();
    await seedMapped(repo, 'soType-1', 'Alpha', 'stage-1');
    await seedMapped(repo, 'soType-1', 'Alpha Beta', 'stage-2');

    const r1 = await repo.findByCodeNormalized('Alpha');
    const r2 = await repo.findByCodeNormalized('Alpha Beta');

    expect(r1!.mappedStageId).toBe('stage-1');
    expect(r2!.mappedStageId).toBe('stage-2');
    expect(r1!.id).not.toBe(r2!.id);
  });

  it('returns null when no normalized match found', async () => {
    const repo = new InMemoryIClassResultCodeRepository();
    await repo.upsert({ soTypeId: null, code: 'Otro Código', type: 'Sucesso' });

    expect(await repo.findByCodeNormalized('Cliente Ausente')).toBeNull();
    expect(await repo.findBySoTypeAndCodeNormalized('soType-1', 'Cliente Ausente')).toBeNull();
  });
});

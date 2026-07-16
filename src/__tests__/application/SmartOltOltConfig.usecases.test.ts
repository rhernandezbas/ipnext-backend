/**
 * smartolt-provision (K2) — CRUD mínimo del catálogo de OLTs SmartOLT:
 * ListSmartOltOlts (GET) + UpdateSmartOltOlt (PUT por id, patch parcial con
 * semántica "omitido ≠ null" en los nullables).
 */
import { ListSmartOltOlts } from '@application/use-cases/ListSmartOltOlts';
import { UpdateSmartOltOlt } from '@application/use-cases/UpdateSmartOltOlt';
import { InMemorySmartOltOltConfigRepository } from '@infrastructure/adapters/in-memory/InMemorySmartOltOltConfigRepository';
import { SmartOltOltConfigNotFoundError } from '@domain/errors/smartolt';

function buildRepo(): InMemorySmartOltOltConfigRepository {
  const repo = new InMemorySmartOltOltConfigRepository();
  repo.seed({ id: 'olt-m1', smartoltOltId: '1', name: 'MERCEDES1', serviceVlanDefault: 246, mgmtVlan: 11 });
  repo.seed({ id: 'olt-ch', smartoltOltId: '3', name: 'CHIVILCOY X2', serviceVlanDefault: null, mgmtVlan: null });
  return repo;
}

describe('ListSmartOltOlts', () => {
  it('devuelve el catálogo completo ordenado por smartoltOltId', async () => {
    const uc = new ListSmartOltOlts(buildRepo());
    const result = await uc.execute();
    expect(result).toEqual([
      { id: 'olt-m1', smartoltOltId: '1', name: 'MERCEDES1', serviceVlanDefault: 246, mgmtVlan: 11 },
      { id: 'olt-ch', smartoltOltId: '3', name: 'CHIVILCOY X2', serviceVlanDefault: null, mgmtVlan: null },
    ]);
  });
});

describe('UpdateSmartOltOlt', () => {
  it('patch parcial: setea serviceVlanDefault sin tocar mgmtVlan ni name', async () => {
    const repo = buildRepo();
    const uc = new UpdateSmartOltOlt(repo);

    const result = await uc.execute('olt-ch', { serviceVlanDefault: 1500 });

    expect(result).toEqual({
      id: 'olt-ch',
      smartoltOltId: '3',
      name: 'CHIVILCOY X2',
      serviceVlanDefault: 1500,
      mgmtVlan: null,
    });
  });

  it('null explícito LIMPIA el default (vuelve a VLAN-obligatoria)', async () => {
    const repo = buildRepo();
    const uc = new UpdateSmartOltOlt(repo);

    const result = await uc.execute('olt-m1', { serviceVlanDefault: null });

    expect(result.serviceVlanDefault).toBeNull();
    expect(result.mgmtVlan).toBe(11); // no se tocó
  });

  it('id inexistente → SmartOltOltConfigNotFoundError (404)', async () => {
    const uc = new UpdateSmartOltOlt(buildRepo());
    await expect(uc.execute('nope', { mgmtVlan: 12 })).rejects.toThrow(
      SmartOltOltConfigNotFoundError,
    );
  });
});

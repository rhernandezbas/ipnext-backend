/**
 * smartolt-provision (K2) — ListUnconfiguredOnus: lista para el picker del FE.
 * Devuelve TODAS las ONUs sin configurar, cada una con:
 *  - `huawei`: sn prefijo HWTC (solo Huawei se auto-aprovisiona)
 *  - `authorizable`: huawei && SmartOLT ofrece la acción authorize
 *  - metadata del catálogo del OLT: oltName, serviceVlanDefault y `vlanRequired`
 *    (CHIVILCOY sin default → el FE exige la VLAN antes del POST).
 */
import { ListUnconfiguredOnus } from '@application/use-cases/ListUnconfiguredOnus';
import { InMemoryOltProvisioningGateway } from '@infrastructure/adapters/in-memory/InMemoryOltProvisioningGateway';
import { InMemorySmartOltOltConfigRepository } from '@infrastructure/adapters/in-memory/InMemorySmartOltOltConfigRepository';

function buildFixture() {
  const gateway = new InMemoryOltProvisioningGateway();
  const oltRepo = new InMemorySmartOltOltConfigRepository();
  oltRepo.seed({ id: 'olt-m1', smartoltOltId: '1', name: 'MERCEDES1', serviceVlanDefault: 246, mgmtVlan: 11 });
  oltRepo.seed({ id: 'olt-ch', smartoltOltId: '3', name: 'CHIVILCOY X2', serviceVlanDefault: null, mgmtVlan: null });
  const uc = new ListUnconfiguredOnus(gateway, oltRepo);
  return { gateway, oltRepo, uc };
}

describe('ListUnconfiguredOnus', () => {
  it('marca Huawei como authorizable y enriquece con el catálogo del OLT', async () => {
    const { gateway, uc } = buildFixture();
    gateway.unconfigured = [
      {
        sn: 'HWTC11112222',
        onuTypeName: 'HG8546M',
        onuTypeId: '15',
        oltId: '1',
        board: '0',
        port: '3',
        ponType: 'gpon',
        supportsAuthorize: true,
      },
      {
        sn: 'ZTEGC1234567',
        onuTypeName: 'F660',
        onuTypeId: '9',
        oltId: '1',
        board: '0',
        port: '5',
        ponType: 'gpon',
        supportsAuthorize: true,
      },
    ];

    const result = await uc.execute();

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      sn: 'HWTC11112222',
      onuTypeName: 'HG8546M',
      oltId: '1',
      oltName: 'MERCEDES1',
      board: '0',
      port: '3',
      ponType: 'gpon',
      huawei: true,
      authorizable: true,
      serviceVlanDefault: 246,
      vlanRequired: false,
    });
    // La ZTE se LISTA (visibilidad) pero NO es auto-aprovisionable.
    expect(result[1]).toMatchObject({ sn: 'ZTEGC1234567', huawei: false, authorizable: false });
  });

  it('Huawei sin acción authorize en SmartOLT → authorizable false', async () => {
    const { gateway, uc } = buildFixture();
    gateway.unconfigured = [
      {
        sn: 'HWTC99990000',
        onuTypeName: 'HG8145V5',
        onuTypeId: '22',
        oltId: '1',
        board: '1',
        port: '2',
        ponType: 'gpon',
        supportsAuthorize: false,
      },
    ];

    const result = await uc.execute();

    expect(result[0]).toMatchObject({ huawei: true, authorizable: false });
  });

  it('OLT sin default de VLAN (CHIVILCOY) → vlanRequired true; OLT fuera del catálogo → oltName null y vlanRequired true', async () => {
    const { gateway, uc } = buildFixture();
    gateway.unconfigured = [
      {
        sn: 'HWTC00001111',
        onuTypeName: 'HG8546M',
        onuTypeId: '15',
        oltId: '3',
        board: '0',
        port: '1',
        ponType: 'gpon',
        supportsAuthorize: true,
      },
      {
        sn: 'HWTC22223333',
        onuTypeName: 'HG8546M',
        onuTypeId: '15',
        oltId: '99',
        board: '0',
        port: '2',
        ponType: 'gpon',
        supportsAuthorize: true,
      },
    ];

    const result = await uc.execute();

    expect(result[0]).toMatchObject({
      oltId: '3',
      oltName: 'CHIVILCOY X2',
      serviceVlanDefault: null,
      vlanRequired: true,
    });
    expect(result[1]).toMatchObject({
      oltId: '99',
      oltName: null,
      serviceVlanDefault: null,
      vlanRequired: true,
    });
  });

  it('sin ONUs sin configurar → lista vacía (el gateway respondió, no hay pendientes)', async () => {
    const { gateway, uc } = buildFixture();
    gateway.unconfigured = [];
    expect(await uc.execute()).toEqual([]);
  });
});

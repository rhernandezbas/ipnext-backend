import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { GetInventoryOverview } from '@application/use-cases/GetInventoryOverview';
import { createStockLocation } from '@domain/entities/stock-location';
import { createInventoryAsset } from '@domain/entities/inventory-asset';
import { createMaterialStock } from '@domain/entities/material-stock';

/**
 * SCEN-LOC-1: mixed locations returned with correct labels.
 * SCEN-LOC-2: empty list — all 4 groups present with count 0.
 * All 4 location types ALWAYS present in groups; TECNICO excluded from CONTENT but group present.
 */
describe('GetInventoryOverview', () => {
  function makeRepos() {
    const locations = new InMemoryStockLocationRepository();
    const assets = new InMemoryInventoryAssetRepository();
    const stock = new InMemoryMaterialStockRepository();
    return { locations, assets, stock };
  }

  it('SCEN-LOC-2: returns all 4 groups with count 0 when no locations have content', async () => {
    const { locations, assets, stock } = makeRepos();
    const uc = new GetInventoryOverview(locations);

    const result = await uc.execute();

    expect(result.groups).toHaveLength(4);
    const types = result.groups.map((g) => g.type);
    expect(types).toContain('DEPOSITO');
    expect(types).toContain('CLIENTE');
    expect(types).toContain('TECNICO');
    expect(types).toContain('CAMIONETA');

    result.groups.forEach((g) => {
      expect(g.locationCount).toBe(0);
      expect(g.totalAssets).toBe(0);
      expect(g.totalMaterialQty).toBe(0);
      expect(g.locations).toHaveLength(0);
    });
  });

  it('FIX-4: CLIENTE location with only installed assets appears in overview with correct assetCount', async () => {
    const { locations } = makeRepos();

    // CLIENTE with 2 installed assets (no available ones) — must NOT be excluded
    await locations.create(createStockLocation({ id: 'loc-client-installed', type: 'CLIENTE', contractId: 'contract-installed' }));
    // Seed content: assetCount=2 (installed assets), materialQty=0
    locations.seedContent('loc-client-installed', { assetCount: 2, materialQty: 0, label: 'Client Installed' });

    const uc = new GetInventoryOverview(locations);
    const result = await uc.execute();

    const clientGroup = result.groups.find((g) => g.type === 'CLIENTE')!;
    expect(clientGroup.locationCount).toBe(1);
    expect(clientGroup.totalAssets).toBe(2);
    expect(clientGroup.locations[0].label).toBe('Client Installed');
    expect(clientGroup.locations[0].assetCount).toBe(2);
  });

  it('SCEN-LOC-1: returns DEPOSITO and CLIENTE with content; TECNICO empty location excluded from locations list', async () => {
    const { locations } = makeRepos();

    // DEPOSITO with 2 assets
    await locations.create(createStockLocation({ id: 'loc-depot', type: 'DEPOSITO', code: 'DEPOSITO' }));
    // CLIENTE with 5 materialQty
    await locations.create(createStockLocation({ id: 'loc-client', type: 'CLIENTE', contractId: 'contract-1' }));
    // TECNICO with no content — should be excluded from locations list
    await locations.create(createStockLocation({ id: 'loc-tech', type: 'TECNICO', technicianId: 'tech-1' }));

    // Seed content via InMemory test-only setters
    locations.seedContent('loc-depot', { assetCount: 2, materialQty: 0, label: 'Depósito' });
    locations.seedContent('loc-client', { assetCount: 0, materialQty: 5, label: 'Cliente SA' });
    // loc-tech has no content seeded → will be excluded

    const uc = new GetInventoryOverview(locations);
    const result = await uc.execute();

    expect(result.groups).toHaveLength(4);

    const depotGroup = result.groups.find((g) => g.type === 'DEPOSITO')!;
    expect(depotGroup.locationCount).toBe(1);
    expect(depotGroup.totalAssets).toBe(2);
    expect(depotGroup.totalMaterialQty).toBe(0);
    expect(depotGroup.locations).toHaveLength(1);
    expect(depotGroup.locations[0].label).toBe('Depósito');
    expect(depotGroup.locations[0].assetCount).toBe(2);

    const clientGroup = result.groups.find((g) => g.type === 'CLIENTE')!;
    expect(clientGroup.locationCount).toBe(1);
    expect(clientGroup.totalAssets).toBe(0);
    expect(clientGroup.totalMaterialQty).toBe(5);
    expect(clientGroup.locations[0].label).toBe('Cliente SA');

    const techGroup = result.groups.find((g) => g.type === 'TECNICO')!;
    expect(techGroup.locationCount).toBe(0);
    expect(techGroup.locations).toHaveLength(0);
  });
});

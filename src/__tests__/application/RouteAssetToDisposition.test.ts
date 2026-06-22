import { RouteAssetToDisposition } from '@application/services/RouteAssetToDisposition';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { ResolveTechnicianLocation } from '@application/use-cases/ResolveTechnicianLocation';
import { ResolveClientLocation } from '@application/use-cases/ResolveClientLocation';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryInventoryMovementRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { createInventoryAsset } from '@domain/entities/inventory-asset';

/**
 * RouteAssetToDisposition — the tx-scoped routing service (Cambio B, Commit 1).
 *
 * The asset always starts `installed` at the contract's CLIENTE location. The
 * service routes it to the status/location/movement of the chosen disposition
 * (canonical table in the design). Tests exercise each of the 5 dispositions plus
 * the net-new CLIENTE→TECNICO path and the optional note.
 */

const CONTRACT_ID = 'C1';
const TECH_ID = 't1';

/**
 * Build a routing service over fresh in-memory repos. Seeds:
 *  - a CLIENTE location for CONTRACT_ID
 *  - an asset `installed` at that CLIENTE location
 * Returns the service, the tx-bag shape the service consumes, and the repos so
 * tests can assert the final asset state + the recorded movement.
 */
async function setup() {
  const locations = new InMemoryStockLocationRepository();
  const assets = new InMemoryInventoryAssetRepository();
  const materialStock = new InMemoryMaterialStockRepository();
  const movements = new InMemoryInventoryMovementRepository(assets, materialStock);

  const resolveDepot = new ResolveDepotLocation(locations);
  const resolveTechnician = new ResolveTechnicianLocation(locations);
  const resolveClient = new ResolveClientLocation(locations);

  // The asset enters installed at the contract's CLIENTE location.
  const cliente = await resolveClient.execute(CONTRACT_ID);
  await assets.create(
    createInventoryAsset({
      id: 'asset-1',
      serialNumber: 'SN-1',
      mac: null,
      deviceTypeId: 'dt',
      status: 'installed',
      currentLocationId: cliente.id,
      source: 'MANUAL',
    }),
  );

  const route = new RouteAssetToDisposition(resolveDepot, resolveTechnician, resolveClient);

  // The bag the use case hands the service inside runInTransaction.
  const bag = { assets, movements };

  return { route, bag, assets, movements, locations, cliente };
}

describe('RouteAssetToDisposition', () => {
  it('DEPOSITO → asset available @ DEPOSITO + RETURN movement (CLIENTE → DEPOSITO)', async () => {
    const { route, bag, assets, movements, locations, cliente } = await setup();

    await route.execute(bag, { assetId: 'asset-1', disposition: 'DEPOSITO', contractId: CONTRACT_ID });

    const depot = await locations.findByCode('DEPOSITO');
    const asset = await assets.findById('asset-1');
    expect(asset!.status).toBe('available');
    expect(asset!.currentLocationId).toBe(depot!.id);

    const moves = await movements.listByAsset('asset-1');
    expect(moves).toHaveLength(1);
    expect(moves[0].type).toBe('RETURN');
    expect(moves[0].fromLocationId).toBe(cliente.id);
    expect(moves[0].toLocationId).toBe(depot!.id);
    expect(moves[0].source).toBe('OPERATOR_RETIRE');
  });

  it('TECNICO → asset available @ the technician location + TRANSFER movement (CLIENTE → TECNICO) with technicianId', async () => {
    const { route, bag, assets, movements, locations, cliente } = await setup();

    await route.execute(bag, {
      assetId: 'asset-1',
      disposition: 'TECNICO',
      contractId: CONTRACT_ID,
      technicianId: TECH_ID,
    });

    const techLoc = await locations.findByTypeAndTechnician('TECNICO', TECH_ID);
    expect(techLoc).not.toBeNull();
    const asset = await assets.findById('asset-1');
    expect(asset!.status).toBe('available');
    expect(asset!.currentLocationId).toBe(techLoc!.id);

    const moves = await movements.listByAsset('asset-1');
    expect(moves).toHaveLength(1);
    expect(moves[0].type).toBe('TRANSFER');
    expect(moves[0].fromLocationId).toBe(cliente.id);
    expect(moves[0].toLocationId).toBe(techLoc!.id);
    expect(moves[0].technicianId).toBe(TECH_ID);
    expect(moves[0].source).toBe('OPERATOR_RETIRE');
  });

  it('CLIENTE → asset retired, stays @ CLIENTE + ADJUST movement (status=retired)', async () => {
    const { route, bag, assets, movements, cliente } = await setup();

    await route.execute(bag, { assetId: 'asset-1', disposition: 'CLIENTE', contractId: CONTRACT_ID });

    const asset = await assets.findById('asset-1');
    expect(asset!.status).toBe('retired');
    expect(asset!.currentLocationId).toBe(cliente.id); // stays put

    const moves = await movements.listByAsset('asset-1');
    expect(moves).toHaveLength(1);
    expect(moves[0].type).toBe('ADJUST');
    expect(moves[0].status).toBe('retired');
    expect(moves[0].source).toBe('OPERATOR_RETIRE');
  });

  it('DAMAGED → asset damaged @ DEPOSITO + ADJUST movement (status=damaged)', async () => {
    const { route, bag, assets, movements, locations } = await setup();

    await route.execute(bag, { assetId: 'asset-1', disposition: 'DAMAGED', contractId: CONTRACT_ID });

    const depot = await locations.findByCode('DEPOSITO');
    const asset = await assets.findById('asset-1');
    expect(asset!.status).toBe('damaged');
    expect(asset!.currentLocationId).toBe(depot!.id);

    const moves = await movements.listByAsset('asset-1');
    expect(moves).toHaveLength(1);
    expect(moves[0].type).toBe('ADJUST');
    expect(moves[0].status).toBe('damaged');
    expect(moves[0].toLocationId).toBe(depot!.id);
  });

  it('RETIRED → asset retired @ DEPOSITO + ADJUST movement (status=retired)', async () => {
    const { route, bag, assets, movements, locations } = await setup();

    await route.execute(bag, { assetId: 'asset-1', disposition: 'RETIRED', contractId: CONTRACT_ID });

    const depot = await locations.findByCode('DEPOSITO');
    const asset = await assets.findById('asset-1');
    expect(asset!.status).toBe('retired');
    expect(asset!.currentLocationId).toBe(depot!.id);

    const moves = await movements.listByAsset('asset-1');
    expect(moves).toHaveLength(1);
    expect(moves[0].type).toBe('ADJUST');
    expect(moves[0].status).toBe('retired');
    expect(moves[0].toLocationId).toBe(depot!.id);
  });

  it('records the note on the movement when provided', async () => {
    const { route, bag, movements } = await setup();

    await route.execute(bag, {
      assetId: 'asset-1',
      disposition: 'DEPOSITO',
      contractId: CONTRACT_ID,
      note: 'se cambió por upgrade',
    });

    const moves = await movements.listByAsset('asset-1');
    expect(moves).toHaveLength(1);
    expect(moves[0].note).toBe('se cambió por upgrade');
  });
});

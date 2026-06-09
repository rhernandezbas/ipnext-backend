import { StageReturnSuggestions } from '@application/use-cases/StageReturnSuggestions';
import { InMemoryReturnSuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryReturnSuggestionRepository';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryInventoryMovementRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { createInventoryAsset, AssetStatus } from '@domain/entities/inventory-asset';
import { OcrExtraction } from '@domain/entities/ocr-extraction';
import { randomUUID } from 'crypto';

const TASK = 't1';
const SO = 'so-900';

function ext(over: Partial<OcrExtraction> = {}): OcrExtraction {
  return {
    id: randomUUID(),
    photoUrl: 'https://s3/photo.jpg',
    serviceOrderId: SO,
    sourceTaskId: TASK,
    deviceType: 'ONU',
    qwenDeviceType: null,
    sn: 'SN-001',
    mac: null,
    confidence: 0.9,
    rawOutput: null,
    provider: 'test',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function seedAsset(
  assets: InMemoryInventoryAssetRepository,
  serial: string,
  status: AssetStatus,
): string {
  const id = randomUUID();
  assets.store.set(
    id,
    createInventoryAsset({
      id,
      serialNumber: serial,
      deviceTypeId: 'dt-onu',
      status,
      currentLocationId: 'loc-client',
      source: 'OCR',
    }),
  );
  return id;
}

function setup() {
  const returns = new InMemoryReturnSuggestionRepository();
  const assets = new InMemoryInventoryAssetRepository();
  const materials = new InMemoryMaterialStockRepository();
  const movements = new InMemoryInventoryMovementRepository(assets, materials);
  const useCase = new StageReturnSuggestions(returns, assets);
  return { returns, assets, movements, useCase };
}

describe('StageReturnSuggestions', () => {
  it('(a) completed retiro + matched installed serial → pending suggestion, no movement', async () => {
    const { returns, assets, movements, useCase } = setup();
    const assetId = seedAsset(assets, 'SN-001', 'installed');

    await useCase.execute({ taskId: TASK, serviceOrderId: SO, extractions: [ext({ sn: 'SN-001' })] });

    const staged = await returns.listByTask(TASK);
    expect(staged).toHaveLength(1);
    expect(staged[0].status).toBe('pending');
    expect(staged[0].matchedAssetId).toBe(assetId);
    expect(staged[0].serviceOrderId).toBe(SO);
    expect(movements.movements).toHaveLength(0);
  });

  it('(b) completed retiro + unmatched serial → needs_review, matchedAssetId null', async () => {
    const { returns, movements, useCase } = setup();

    await useCase.execute({ taskId: TASK, serviceOrderId: SO, extractions: [ext({ sn: 'SN-UNKNOWN' })] });

    const staged = await returns.listByTask(TASK);
    expect(staged).toHaveLength(1);
    expect(staged[0].status).toBe('needs_review');
    expect(staged[0].matchedAssetId).toBeNull();
    expect(movements.movements).toHaveLength(0);
  });

  it('(c) serial matches a NON-installed asset → needs_review (not a valid return)', async () => {
    const { returns, assets, movements, useCase } = setup();
    seedAsset(assets, 'SN-002', 'available');

    await useCase.execute({ taskId: TASK, serviceOrderId: SO, extractions: [ext({ sn: 'SN-002' })] });

    const staged = await returns.listByTask(TASK);
    expect(staged).toHaveLength(1);
    expect(staged[0].status).toBe('needs_review');
    expect(staged[0].matchedAssetId).toBeNull();
    expect(movements.movements).toHaveLength(0);
  });

  it('matches by normalized serial (IClass/OCR drift)', async () => {
    const { returns, assets, useCase } = setup();
    // The installed asset's serial differs by punctuation/case; normalized they match.
    const drift = seedAsset(assets, 'sn 003', 'installed');

    await useCase.execute({
      taskId: TASK,
      serviceOrderId: SO,
      extractions: [ext({ sn: 'SN-003', mac: null })],
    });

    const staged = await returns.listByTask(TASK);
    expect(staged[0].matchedAssetId).toBe(drift);
    expect(staged[0].status).toBe('pending');
  });

  it('falls back to MAC when the OCR serial is missing', async () => {
    const { returns, assets, useCase } = setup();
    // Device with no SN: the asset was registered with the MAC as its serial key.
    const byMac = seedAsset(assets, 'AABBCCDDEEFF', 'installed');

    await useCase.execute({
      taskId: TASK,
      serviceOrderId: SO,
      extractions: [ext({ sn: null, mac: 'AA:BB:CC:DD:EE:FF' })],
    });

    const staged = await returns.listByTask(TASK);
    expect(staged).toHaveLength(1);
    expect(staged[0].matchedAssetId).toBe(byMac);
    expect(staged[0].status).toBe('pending');
    expect(staged[0].serialNumber).toBe('AABBCCDDEEFF'); // normalized MAC used as the key
  });

  it('(e) re-stage of the same (SO, serial) silently dedups via the natural key', async () => {
    const { returns, assets, useCase } = setup();
    seedAsset(assets, 'SN-001', 'installed');

    await useCase.execute({ taskId: TASK, serviceOrderId: SO, extractions: [ext({ sn: 'SN-001' })] });
    await useCase.execute({ taskId: TASK, serviceOrderId: SO, extractions: [ext({ sn: 'SN-001' })] });

    expect(await returns.listByTask(TASK)).toHaveLength(1);
  });

  it('stages nothing for an empty extraction list (no devices on the SO)', async () => {
    const { returns, useCase } = setup();
    await useCase.execute({ taskId: TASK, serviceOrderId: SO, extractions: [] });
    expect(await returns.listByTask(TASK)).toHaveLength(0);
  });

  // ── Fix #4 [MEDIUM]: skip staging when there is neither SN nor MAC ──────────
  it('(fix4) OCR with no serial AND no mac → no suggestion (unactionable, would dup on re-stage)', async () => {
    const { returns, useCase } = setup();
    // Postgres @@unique treats NULL serialNumber as DISTINCT, so a partial-crash re-stage
    // would duplicate a null-key needs_review row. A device with no SN/MAC is unmatchable
    // and unlinkable anyway → skip it entirely.
    await useCase.execute({
      taskId: TASK,
      serviceOrderId: SO,
      extractions: [ext({ sn: null, mac: null }), ext({ sn: '   ', mac: '' })],
    });

    expect(await returns.listByTask(TASK)).toHaveLength(0);
  });
});

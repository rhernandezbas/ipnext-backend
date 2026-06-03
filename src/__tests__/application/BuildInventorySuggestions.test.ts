import { BuildInventorySuggestions } from '@application/use-cases/BuildInventorySuggestions';
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { OcrExtraction } from '@domain/entities/ocr-extraction';
import { SoMaterial } from '@domain/entities/iclass-closed-order';

const extraction = (over: Partial<OcrExtraction>): OcrExtraction => ({
  id: 'e', photoUrl: 'https://x/p.jpg', serviceOrderId: null, sourceTaskId: 't1',
  deviceType: 'ROUTER', qwenDeviceType: null, sn: 'SN', mac: 'MAC', confidence: 0.9, rawOutput: '',
  provider: 'in-memory', createdAt: '2026-06-01T00:00:00Z', ...over,
});

const material = (over: Partial<SoMaterial>): SoMaterial => ({
  iclassOsMaterialId: 'm', materialCode: null, materialDescription: 'UTP CAT5',
  qty: 30, unitValue: null, totalValue: null, ...over,
});

describe('BuildInventorySuggestions', () => {
  it('SCEN-BS-1: builds one DEVICE suggestion per OCR extraction (antena + router)', async () => {
    const repo = new InMemoryInventorySuggestionRepository();
    const uc = new BuildInventorySuggestions(repo);

    await uc.execute({
      taskId: 't1',
      extractions: [
        extraction({ photoUrl: 'https://x/antena.jpg', deviceType: 'ANTENA', sn: 'A1', mac: 'MA' }),
        extraction({ photoUrl: 'https://x/router.jpg', deviceType: 'ROUTER', sn: 'R1', mac: 'MR' }),
      ],
      materials: [],
    });

    const list = await repo.listByTask('t1');
    const devices = list.filter(s => s.kind === 'DEVICE');
    expect(devices).toHaveLength(2);
    expect(devices.map(d => d.deviceType).sort()).toEqual(['ANTENA', 'ROUTER']);
    expect(devices.every(d => d.status === 'pending' && d.source === 'OCR')).toBe(true);
  });

  it('SCEN-BS-2: idempotent — re-running does not duplicate', async () => {
    const repo = new InMemoryInventorySuggestionRepository();
    const uc = new BuildInventorySuggestions(repo);
    const input = {
      taskId: 't1',
      extractions: [extraction({ photoUrl: 'https://x/router.jpg', deviceType: 'ROUTER', sn: 'R1' })],
      materials: [material({ materialDescription: 'UTP CAT5' })],
    };

    await uc.execute(input);
    await uc.execute(input);

    expect(await repo.listByTask('t1')).toHaveLength(2); // 1 device + 1 material, not 4
  });

  it('SCEN-BS-3: builds MATERIAL suggestions from IClass materials with quantity', async () => {
    const repo = new InMemoryInventorySuggestionRepository();
    const uc = new BuildInventorySuggestions(repo);

    await uc.execute({
      taskId: 't1',
      extractions: [],
      materials: [material({ materialDescription: 'RJ45', qty: 2 })],
    });

    const list = await repo.listByTask('t1');
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe('MATERIAL');
    expect(list[0].materialDesc).toBe('RJ45');
    expect(list[0].quantity).toBe(2);
    expect(list[0].source).toBe('ICLASS_MATERIAL');
  });
});

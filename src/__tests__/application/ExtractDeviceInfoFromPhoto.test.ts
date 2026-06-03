import { ExtractDeviceInfoFromPhoto } from '@application/use-cases/ExtractDeviceInfoFromPhoto';
import { InMemoryDevicePhotoOcr } from '@infrastructure/adapters/in-memory/InMemoryDevicePhotoOcr';
import { InMemoryOcrExtractionRepository } from '@infrastructure/adapters/in-memory/InMemoryOcrExtractionRepository';
import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';

const BASE_TYPES = ['ONU', 'ROUTER', 'ANTENA', 'REPETIDOR', 'OTROS'];

async function setup() {
  const ocr = new InMemoryDevicePhotoOcr();
  const repo = new InMemoryOcrExtractionRepository();
  const catalogRepo = new InMemoryDeviceTypeCatalogRepository();
  for (const name of BASE_TYPES) await catalogRepo.create({ name, active: true, sortOrder: 0 });
  const uc = new ExtractDeviceInfoFromPhoto(ocr, repo, catalogRepo);
  return { ocr, repo, uc };
}

describe('ExtractDeviceInfoFromPhoto', () => {
  it('SCEN-OCR-1: persists the extracted sn/mac with deviceType + provider', async () => {
    const { ocr, repo, uc } = await setup();
    ocr.set('https://x/router.jpg', { sn: '1100309242501444', mac: 'DC8E8D156CE6', confidence: 0.95, rawOutput: '{...}' });

    const ext = await uc.execute({ photoUrl: 'https://x/router.jpg', deviceType: 'ROUTER', sourceTaskId: 't1' });

    expect(ext.sn).toBe('1100309242501444');
    expect(ext.mac).toBe('DC8E8D156CE6');
    expect(ext.deviceType).toBe('ROUTER');
    expect(ext.provider).toBe('in-memory');
    expect(await repo.findByPhotoUrl('https://x/router.jpg')).not.toBeNull();
  });

  it('SCEN-OCR-2: an unreadable photo persists null sn/mac and does not throw', async () => {
    const { uc } = await setup();
    const ext = await uc.execute({ photoUrl: 'https://x/blurry.jpg', deviceType: 'ANTENA' });
    expect(ext.sn).toBeNull();
    expect(ext.mac).toBeNull();
  });

  it('is idempotent by photoUrl — re-running returns the cached extraction', async () => {
    const { ocr, repo, uc } = await setup();
    ocr.set('https://x/r.jpg', { sn: 'SN1', mac: null, confidence: 0.9, rawOutput: '' });

    const first = await uc.execute({ photoUrl: 'https://x/r.jpg', deviceType: 'ROUTER' });
    // change the stub; idempotency must ignore it
    ocr.set('https://x/r.jpg', { sn: 'SN2', mac: null, confidence: 0.9, rawOutput: '' });
    const second = await uc.execute({ photoUrl: 'https://x/r.jpg', deviceType: 'ROUTER' });

    expect(second.id).toBe(first.id);
    expect(second.sn).toBe('SN1');
    expect(repo.store.size).toBe(1);
  });

  it('F2/D.4: persiste qwenDeviceType validado desde el catálogo (onu→ONU)', async () => {
    const { ocr, uc } = await setup();
    ocr.set('https://x/a.jpg', { sn: null, mac: 'DC8E8D156CE6', confidence: 0.8, rawOutput: '', deviceType: 'antena' });

    const ext = await uc.execute({ photoUrl: 'https://x/a.jpg', deviceType: 'ONU' }); // label dice ONU

    expect(ext.deviceType).toBe('ONU'); // label intacto
    expect(ext.qwenDeviceType).toBe('ANTENA'); // lo que vio el modelo, validado contra catálogo
  });

  it('F2/D.4: qwenDeviceType es null cuando el modelo da un tipo no en el catálogo', async () => {
    const { ocr, uc } = await setup();
    ocr.set('https://x/b.jpg', { sn: null, mac: null, confidence: 0, rawOutput: '', deviceType: 'switch' });

    const ext = await uc.execute({ photoUrl: 'https://x/b.jpg', deviceType: 'ROUTER' });
    expect(ext.qwenDeviceType).toBeNull();
  });

  it('D.4: tipo dinámico del catálogo es reconocido (CPE)', async () => {
    const ocr = new InMemoryDevicePhotoOcr();
    const repo = new InMemoryOcrExtractionRepository();
    const catalogRepo = new InMemoryDeviceTypeCatalogRepository();
    for (const name of [...BASE_TYPES, 'CPE']) await catalogRepo.create({ name, active: true, sortOrder: 0 });
    const uc = new ExtractDeviceInfoFromPhoto(ocr, repo, catalogRepo);

    ocr.set('https://x/cpe.jpg', { sn: 'SN99', mac: null, confidence: 0.9, rawOutput: '', deviceType: 'cpe' });
    const ext = await uc.execute({ photoUrl: 'https://x/cpe.jpg', deviceType: 'CPE' });
    expect(ext.qwenDeviceType).toBe('CPE');
  });
});

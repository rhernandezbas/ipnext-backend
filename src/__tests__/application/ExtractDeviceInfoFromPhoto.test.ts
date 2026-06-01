import { ExtractDeviceInfoFromPhoto } from '@application/use-cases/ExtractDeviceInfoFromPhoto';
import { InMemoryDevicePhotoOcr } from '@infrastructure/adapters/in-memory/InMemoryDevicePhotoOcr';
import { InMemoryOcrExtractionRepository } from '@infrastructure/adapters/in-memory/InMemoryOcrExtractionRepository';

function setup() {
  const ocr = new InMemoryDevicePhotoOcr();
  const repo = new InMemoryOcrExtractionRepository();
  const uc = new ExtractDeviceInfoFromPhoto(ocr, repo);
  return { ocr, repo, uc };
}

describe('ExtractDeviceInfoFromPhoto', () => {
  it('SCEN-OCR-1: persists the extracted sn/mac with deviceType + provider', async () => {
    const { ocr, repo, uc } = setup();
    ocr.set('https://x/router.jpg', { sn: '1100309242501444', mac: 'DC8E8D156CE6', confidence: 0.95, rawOutput: '{...}' });

    const ext = await uc.execute({ photoUrl: 'https://x/router.jpg', deviceType: 'ROUTER', sourceTaskId: 't1' });

    expect(ext.sn).toBe('1100309242501444');
    expect(ext.mac).toBe('DC8E8D156CE6');
    expect(ext.deviceType).toBe('ROUTER');
    expect(ext.provider).toBe('in-memory');
    expect(await repo.findByPhotoUrl('https://x/router.jpg')).not.toBeNull();
  });

  it('SCEN-OCR-2: an unreadable photo persists null sn/mac and does not throw', async () => {
    const { uc } = setup();
    const ext = await uc.execute({ photoUrl: 'https://x/blurry.jpg', deviceType: 'ANTENA' });
    expect(ext.sn).toBeNull();
    expect(ext.mac).toBeNull();
  });

  it('is idempotent by photoUrl — re-running returns the cached extraction', async () => {
    const { ocr, repo, uc } = setup();
    ocr.set('https://x/r.jpg', { sn: 'SN1', mac: null, confidence: 0.9, rawOutput: '' });

    const first = await uc.execute({ photoUrl: 'https://x/r.jpg', deviceType: 'ROUTER' });
    // change the stub; idempotency must ignore it
    ocr.set('https://x/r.jpg', { sn: 'SN2', mac: null, confidence: 0.9, rawOutput: '' });
    const second = await uc.execute({ photoUrl: 'https://x/r.jpg', deviceType: 'ROUTER' });

    expect(second.id).toBe(first.id);
    expect(second.sn).toBe('SN1');
    expect(repo.store.size).toBe(1);
  });
});

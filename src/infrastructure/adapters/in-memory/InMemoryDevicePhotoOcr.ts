import { DevicePhotoOcr, DeviceOcrResult } from '@domain/ports/DevicePhotoOcr';

/**
 * Stub DevicePhotoOcr for use-case tests. Preload results per photoUrl with
 * `set`; unknown photos return an unreadable result (null sn/mac), mirroring a
 * photo the model could not parse.
 */
export class InMemoryDevicePhotoOcr implements DevicePhotoOcr {
  readonly provider = 'in-memory';
  private readonly results = new Map<string, DeviceOcrResult>();

  set(photoUrl: string, result: DeviceOcrResult): void {
    this.results.set(photoUrl, result);
  }

  async extract(photoUrl: string): Promise<DeviceOcrResult> {
    return (
      this.results.get(photoUrl) ?? { sn: null, mac: null, confidence: 0, rawOutput: '' }
    );
  }
}

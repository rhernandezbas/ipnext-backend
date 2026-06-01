import { DevicePhotoOcr } from '@domain/ports/DevicePhotoOcr';
import { OcrExtractionRepository } from '@domain/ports/OcrExtractionRepository';
import { OcrExtraction } from '@domain/entities/ocr-extraction';
import { randomUUID } from 'crypto';

export interface ExtractDeviceInfoInput {
  photoUrl: string;
  /** Device class from the question label (Capa 2). */
  deviceType?: string | null;
  serviceOrderId?: string | null;
  sourceTaskId?: string | null;
}

/**
 * Runs OCR over one device photo and persists the result. Idempotent by
 * photoUrl — re-running returns the stored extraction without re-calling the
 * model. A null SN/MAC (unreadable) is a valid, persisted outcome (kept for
 * manual review); it never throws.
 */
export class ExtractDeviceInfoFromPhoto {
  constructor(
    private readonly ocr: DevicePhotoOcr,
    private readonly repo: OcrExtractionRepository,
  ) {}

  async execute(input: ExtractDeviceInfoInput): Promise<OcrExtraction> {
    const cached = await this.repo.findByPhotoUrl(input.photoUrl);
    if (cached) return cached;

    const result = await this.ocr.extract(input.photoUrl, input.deviceType ?? undefined);

    const extraction: OcrExtraction = {
      id: randomUUID(),
      photoUrl: input.photoUrl,
      serviceOrderId: input.serviceOrderId ?? null,
      sourceTaskId: input.sourceTaskId ?? null,
      deviceType: input.deviceType ?? null,
      sn: result.sn,
      mac: result.mac,
      confidence: result.confidence,
      rawOutput: result.rawOutput,
      provider: this.ocr.provider,
      createdAt: new Date().toISOString(),
    };
    return this.repo.save(extraction);
  }
}

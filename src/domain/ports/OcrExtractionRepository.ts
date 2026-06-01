import { OcrExtraction } from '@domain/entities/ocr-extraction';

export interface OcrExtractionRepository {
  /** Persist an extraction. */
  save(extraction: OcrExtraction): Promise<OcrExtraction>;
  /** Lookup by photo URL — idempotency: a photo is OCR'd once. */
  findByPhotoUrl(photoUrl: string): Promise<OcrExtraction | null>;
}

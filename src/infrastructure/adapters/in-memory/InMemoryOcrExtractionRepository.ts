import { OcrExtractionRepository } from '@domain/ports/OcrExtractionRepository';
import { OcrExtraction } from '@domain/entities/ocr-extraction';

export class InMemoryOcrExtractionRepository implements OcrExtractionRepository {
  readonly store = new Map<string, OcrExtraction>(); // keyed by photoUrl

  async save(extraction: OcrExtraction): Promise<OcrExtraction> {
    this.store.set(extraction.photoUrl, extraction);
    return extraction;
  }

  async findByPhotoUrl(photoUrl: string): Promise<OcrExtraction | null> {
    return this.store.get(photoUrl) ?? null;
  }
}
